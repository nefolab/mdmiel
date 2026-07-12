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
 */
export function resolvePlacements(
  comments: Comment[],
  content: string,
  radius?: number
): ResolvedPlacement[] {
  return comments.map((comment) => {
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
