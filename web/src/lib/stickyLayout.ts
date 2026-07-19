/**
 * Pure layout logic for the overlay sticky-note view. DOM measurement lives in
 * the component (jsdom returns zero rects); everything that can be tested as a
 * pure function — anchor resolution, orphaned classification, and vertical
 * de-overlap stacking — lives here.
 */

import { Comment, rematchLine } from './comments';

export interface ResolvedPlacement {
  comment: Comment;
  /** Line the comment currently maps to (rematch-corrected). */
  line: number;
  orphaned: boolean;
}

/**
 * Runs each comment through rematchLine against the current file content to
 * find its display line and whether it has become orphaned.
 *
 * DOM-anchored comments (anchor.type === 'dom') bypass rematchLine entirely: their
 * snippet/snippetHash describe a live DOM element's text, not a raw-source line, so
 * comparing them against lines of `content` would be a category error (and could
 * spuriously "rematch" to an unrelated line that happens to hash the same). For these,
 * `orphaned` is always false here — whether the anchor actually resolves to a DOM
 * element is determined later by BridgeResolver/DirectDomResolver (surfaced as the
 * "missing" bucket in splitOrphaned), not by this text-level pass.
 */
export function resolvePlacements(
  comments: Comment[],
  content: string,
  radius?: number
): ResolvedPlacement[] {
  return comments.map((comment) => {
    if (comment.anchor.type === 'dom') {
      return { comment, line: comment.anchor.line, orphaned: false };
    }
    const { line, orphaned } = rematchLine({
      content,
      anchorLine: comment.anchor.line,
      snippetHash: comment.anchor.snippetHash,
      radius,
    });
    return { comment, line, orphaned };
  });
}

export interface SplitPlacements {
  /** Non-orphaned and the anchored element currently exists in the DOM. */
  placed: ResolvedPlacement[];
  /** rematchLine failed to find the line (orphaned:true). */
  orphaned: ResolvedPlacement[];
  /** Non-orphaned but no target element exists (e.g. inline-only source line
   *  with no block element carrying data-source-line). Cannot be pinned. */
  missing: ResolvedPlacement[];
}

/**
 * Classifies placements for display. A placement is:
 * - orphaned: rematchLine reported orphaned:true
 * - missing: not orphaned, but `hasElement` reports no anchor element exists
 * - placed: not orphaned and an anchor element exists (can be pinned)
 *
 * `hasElement` defaults to always-true so callers without DOM knowledge get the
 * simple orphaned / placed split. Both orphaned and missing notes should be
 * shown in the pane's unresolved zone rather than silently dropped.
 */
export function splitOrphaned(
  placements: ResolvedPlacement[],
  hasElement: (placement: ResolvedPlacement) => boolean = () => true
): SplitPlacements {
  const placed: ResolvedPlacement[] = [];
  const orphaned: ResolvedPlacement[] = [];
  const missing: ResolvedPlacement[] = [];
  for (const p of placements) {
    if (p.orphaned) {
      orphaned.push(p);
    } else if (hasElement(p)) {
      placed.push(p);
    } else {
      missing.push(p);
    }
  }
  return { placed, orphaned, missing };
}

/**
 * Combines truly-orphaned placements (rematchLine reported orphaned:true)
 * with "missing" placements (anchor line still resolves but has no DOM
 * element to pin to) into the single ordered list rendered in the pane's
 * unresolved zone. Orphaned entries come first, then missing, each
 * preserving its own relative order — callers should not rely on any other
 * ordering (e.g. by line number).
 */
export function combineUnresolved(
  orphaned: ResolvedPlacement[],
  missing: ResolvedPlacement[]
): ResolvedPlacement[] {
  return [...orphaned, ...missing];
}

/**
 * Per-comment measurement result for a 'live' pane, as reported by the BridgeResolver
 * postMessage protocol (agent -> parent "rects" message). Structurally identical to
 * StickyNoteLayer's `LiveRect` (kept as its own declaration here so this pure layout
 * module has no dependency on the React component file); TypeScript's structural typing
 * means a `LiveRect` value satisfies this type without any conversion.
 */
export interface LiveRectSnapshot {
  found: boolean;
  rect?: { top: number; left: number; width: number; height: number };
  visible: boolean;
}

export interface LiveRawEntry {
  id: string;
  desiredTop: number;
  present: boolean;
  visible: boolean;
}

/**
 * Maps each 'live'-pane candidate placement to its raw display entry using the
 * BridgeResolver's latest liveRects snapshot.
 *
 * A candidate is `present` only when its anchor is DOM-typed AND liveRects reports
 * `found: true` with a `rect` for its comment id. Every other case — a non-DOM anchor
 * (line-anchored comments have no meaning in a live pane), the id missing from the
 * snapshot entirely (not yet resolved, or dropped from the agent's known-anchors list),
 * or an explicit `found: false` (the agent resolved the anchor once but the element has
 * since left the DOM, e.g. after a SPA route change) — is `present: false`.
 *
 * This makes the "found:false / missing key -> unresolved zone" reclassification a pure
 * function of the latest liveRects snapshot: the caller re-runs it every time liveRects
 * changes (SplitView passes a fresh object on every "rects" message), so a comment can
 * never keep displaying a stale position after its element disappears — it does not
 * depend on any separate trigger such as the comment panel being toggled.
 */
export function buildLiveRawEntries(
  candidates: ResolvedPlacement[],
  liveRects: Record<string, LiveRectSnapshot> | undefined,
  iframeOffsetTop: number
): LiveRawEntry[] {
  return candidates.map((p) => {
    if (p.comment.anchor.type !== 'dom') {
      // renderHtmlLive() はdata-source-line属性を注入しないため、旧来の行アンカー
      // コメントはライブペインでは位置を特定できない (未解決ゾーンへ)。
      return { id: p.comment.id, desiredTop: 0, present: false, visible: false };
    }
    const live = liveRects?.[p.comment.id];
    if (!live || !live.found || !live.rect) {
      return { id: p.comment.id, desiredTop: 0, present: false, visible: false };
    }
    return {
      id: p.comment.id,
      desiredTop: iframeOffsetTop + live.rect.top,
      present: true,
      visible: live.visible,
    };
  });
}

export interface NotePlacementInput {
  id: string;
  /** Ideal top coordinate derived from the anchored element's position. */
  desiredTop: number;
  /** Estimated rendered height of the note, used to detect overlap. */
  height: number;
}

export interface NotePlacementResult {
  id: string;
  top: number;
}

/**
 * Greedy vertical de-overlap: notes are placed in order of desired top; each
 * note is pushed down to at least `previousBottom + gap` so cards never
 * overlap. Notes far apart keep their desired position. Returns results sorted
 * by desired top (ascending); ties keep input order (stable sort).
 */
export function stackNotes(inputs: NotePlacementInput[], gap = 8): NotePlacementResult[] {
  const indexed = inputs.map((item, index) => ({ item, index }));
  indexed.sort((a, b) =>
    a.item.desiredTop === b.item.desiredTop
      ? a.index - b.index
      : a.item.desiredTop - b.item.desiredTop
  );

  const results: NotePlacementResult[] = [];
  let cursor = -Infinity;
  for (const { item } of indexed) {
    const top = Math.max(item.desiredTop, cursor);
    results.push({ id: item.id, top });
    cursor = top + item.height + gap;
  }
  return results;
}

/**
 * Splits candidates into those that participate in de-overlap stacking and
 * those that are user-positioned (have an explicit offset) and must be
 * excluded: an offset note neither pushes nor is pushed by its neighbors, so
 * it keeps its raw desired position untouched by stackNotes.
 */
export function partitionStackable<T>(
  items: T[],
  hasOffset: (item: T) => boolean
): { stackable: T[]; offset: T[] } {
  const stackable: T[] = [];
  const offset: T[] = [];
  for (const item of items) {
    if (hasOffset(item)) {
      offset.push(item);
    } else {
      stackable.push(item);
    }
  }
  return { stackable, offset };
}

export interface UnresolvedIdsByPane {
  left: string[];
  right: string[];
}

export interface UnresolvedCommentEntry {
  pane: 'left' | 'right';
  comment: Comment;
}

/**
 * Resolves the per-pane unresolved-comment-id sets reported by each pane's
 * StickyNoteLayer (via its onUnresolvedChange callback) into full Comment
 * objects, for display in CommentSidebar's 未解決 section and for the
 * header's unresolved-count badge (single source of truth for both).
 *
 * An id with no matching comment in its pane's list is silently skipped
 * (e.g. the comment was deleted in the moment between being reported
 * unresolved and this running again) rather than throwing. Left-pane
 * entries precede right-pane entries; within a pane, order follows the
 * reported id order (orphaned before missing — see combineUnresolved).
 */
export function collectUnresolvedComments(
  commentsByPane: { left: Comment[]; right: Comment[] },
  unresolvedIdsByPane: UnresolvedIdsByPane
): UnresolvedCommentEntry[] {
  const result: UnresolvedCommentEntry[] = [];
  (['left', 'right'] as const).forEach((pane) => {
    const byId = new Map(commentsByPane[pane].map((c) => [c.id, c] as const));
    for (const id of unresolvedIdsByPane[pane]) {
      const comment = byId.get(id);
      if (comment) result.push({ pane, comment });
    }
  });
  return result;
}

export interface NoteOffset {
  dx: number;
  dy: number;
}

const OFFSET_BOUND = 20000;

/**
 * Clamps a drag offset into [-20000, 20000] on each axis independently, so a
 * runaway drag (or corrupted persisted value) can't push a note arbitrarily
 * far off-screen.
 */
export function clampOffset(dx: number, dy: number): NoteOffset {
  const clamp = (value: number) => Math.min(OFFSET_BOUND, Math.max(-OFFSET_BOUND, value));
  return { dx: clamp(dx), dy: clamp(dy) };
}

/**
 * Combines a base offset (e.g. the persisted comment.noteOffset) with an
 * in-progress drag delta, clamping the result.
 */
export function nextOffset(base: NoteOffset, delta: NoteOffset): NoteOffset {
  return clampOffset(base.dx + delta.dx, base.dy + delta.dy);
}
