import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Comment } from '../lib/comments';
import {
  resolvePlacements,
  splitOrphaned,
  stackNotes,
  nextOffset,
  partitionStackable,
  combineUnresolved,
  buildLiveRawEntries,
  NotePlacementInput,
  NoteOffset,
} from '../lib/stickyLayout';
import { useCommentActions } from '../lib/useCommentActions';

/** Pointer movement (px) beyond which a pointerdown->pointerup is treated as a drag rather than a click. */
const DRAG_THRESHOLD = 4;

/** Estimated collapsed card height used for de-overlap stacking. */
const NOTE_HEIGHT = 64;

/**
 * Per-comment measurement result for a 'live' pane, as reported by the BridgeResolver
 * postMessage protocol (agent -> parent "rects" message, one entry per requested DOM
 * anchor). SplitView owns the postMessage listener (it's the only thing with access to
 * the iframe's contentWindow/nonce) and passes the latest snapshot down as `liveRects`.
 */
export interface LiveRect {
  found: boolean;
  rect?: { top: number; left: number; width: number; height: number };
  visible: boolean;
}

export interface StickyNoteLayerProps {
  type: 'markdown' | 'html';
  content: string;
  comments: Comment[];
  /** The pane-content element that hosts the overlay (position: relative). */
  containerRef: React.RefObject<HTMLDivElement>;
  /** The sandboxed iframe for html panes (unused for markdown). */
  iframeRef: React.RefObject<HTMLIFrameElement>;
  /**
   * 'live' panes render an allow-scripts-only iframe: contentDocument is unreachable from the
   * parent (cross-origin), so direct DOM measurement is impossible. Measurement instead comes
   * from `liveRects`, fed by SplitView's BridgeResolver postMessage bridge.
   */
  viewMode?: 'static' | 'live';
  /** Latest BridgeResolver measurement per comment id. Only consulted when viewMode === 'live'. */
  liveRects?: Record<string, LiveRect>;
  /** Called with a user-facing status message after a card's "リンクをコピー" succeeds. */
  onCopyLink?: (message: string) => void;
  /** Comment id to briefly flash-highlight (e.g. after following a /#/comment/<id> link). */
  flashCommentId?: string | null;
  onChanged: () => void;
  /**
   * Reports this pane's current unresolved (orphaned + missing) comment ids, called
   * whenever the computed set changes. There is no pane-level display for these anymore
   * (see CommentSidebar's 未解決 section) — this is purely a notification channel for the
   * parent to aggregate across panes.
   */
  onUnresolvedChange?: (commentIds: string[]) => void;
}

interface NotePosition {
  top: number;
  visible: boolean;
}

export function StickyNoteLayer({
  type,
  content,
  comments,
  containerRef,
  iframeRef,
  viewMode = 'static',
  liveRects,
  onCopyLink,
  flashCommentId,
  onChanged,
  onUnresolvedChange,
}: StickyNoteLayerProps) {
  const allPlacements = useMemo(
    () => resolvePlacements(comments, content),
    [comments, content]
  );
  // Non-orphaned comments are measurement candidates; whether each actually has
  // a DOM anchor element is only known after measure() runs.
  const candidates = useMemo(
    () => allPlacements.filter((p) => !p.orphaned),
    [allPlacements]
  );

  const [positions, setPositions] = useState<Record<string, NotePosition>>({});
  const [missingIds, setMissingIds] = useState<string[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    // present: an anchor element exists in the DOM at all.
    // visible: present AND currently within the viewport (html scroll case).
    const raw: { id: string; desiredTop: number; present: boolean; visible: boolean }[] = [];

    if (type === 'markdown') {
      for (const p of candidates) {
        const el = container.querySelector(`[data-source-line="${p.line}"]`) as HTMLElement | null;
        raw.push({ id: p.comment.id, desiredTop: el ? el.offsetTop : 0, present: !!el, visible: !!el });
      }
    } else if (viewMode === 'live') {
      // sandbox="allow-scripts" のiframeはcontentDocumentが取得できない (cross-origin) ため、
      // 測定はSplitViewのpostMessageブリッジ (BridgeResolver) が送ってくるliveRectsに委ねる。
      const iframe = iframeRef.current;
      if (!iframe) {
        setPositions({});
        setMissingIds([]);
        return;
      }
      const containerRect = container.getBoundingClientRect();
      const iframeRect = iframe.getBoundingClientRect();
      const iframeOffsetTop = iframeRect.top - containerRect.top;
      // Pure function (lib/stickyLayout.ts): re-run in full against the latest liveRects
      // snapshot every time it changes, so a comment whose element vanished (found:false,
      // or dropped from the snapshot entirely) is reclassified into the unresolved zone
      // immediately rather than keeping its last-known position.
      raw.push(...buildLiveRawEntries(candidates, liveRects, iframeOffsetTop));
    } else {
      const iframe = iframeRef.current;
      const doc = iframe?.contentDocument;
      const win = iframe?.contentWindow;
      if (!iframe || !doc || !win) {
        setPositions({});
        setMissingIds([]);
        return;
      }
      const containerRect = container.getBoundingClientRect();
      const iframeRect = iframe.getBoundingClientRect();
      const viewportHeight = win.innerHeight || iframe.clientHeight;
      const iframeOffsetTop = iframeRect.top - containerRect.top;
      for (const p of candidates) {
        // DirectDomResolver: 静的ペイン (sandbox="allow-same-origin") ではcontentDocumentに
        // 直接アクセスできるため、DOMアンカー ( ライブペインで作成後に静的へ切替えた場合等 ) も
        // selectorでそのまま解決できる。行アンカーは従来通りdata-source-line属性で解決する。
        const el =
          p.comment.anchor.type === 'dom' && p.comment.anchor.selector
            ? (doc.querySelector(p.comment.anchor.selector) as HTMLElement | null)
            : (doc.querySelector(`[data-source-line="${p.line}"]`) as HTMLElement | null);
        if (!el) {
          raw.push({ id: p.comment.id, desiredTop: 0, present: false, visible: false });
          continue;
        }
        const rect = el.getBoundingClientRect();
        const visible = rect.top >= -rect.height && rect.top <= viewportHeight;
        raw.push({ id: p.comment.id, desiredTop: iframeOffsetTop + rect.top, present: true, visible });
      }
    }

    // A note with a persisted noteOffset is user-positioned: it must sit at
    // its raw anchor position (offset applied later via transform in render)
    // and must neither push nor be pushed by other notes during stacking.
    const idHasOffset = new Map(candidates.map((p) => [p.comment.id, p.comment.noteOffset != null]));
    const visibleRaw = raw.filter((r) => r.visible);
    const { stackable } = partitionStackable(visibleRaw, (r) => idHasOffset.get(r.id) === true);

    const stackInputs: NotePlacementInput[] = stackable.map((r) => ({
      id: r.id,
      desiredTop: r.desiredTop,
      height: NOTE_HEIGHT,
    }));
    const stacked = stackNotes(stackInputs);
    const topById = new Map(stacked.map((s) => [s.id, s.top]));

    const next: Record<string, NotePosition> = {};
    for (const r of raw) {
      const hasOffset = idHasOffset.get(r.id) === true;
      next[r.id] = { top: hasOffset ? r.desiredTop : topById.get(r.id) ?? r.desiredTop, visible: r.visible };
    }
    setPositions(next);
    setMissingIds(raw.filter((r) => !r.present).map((r) => r.id));
  }, [candidates, type, containerRef, iframeRef, viewMode, liveRects]);

  useLayoutEffect(() => {
    // Initial synchronous measure so notes are positioned on first paint.
    measure();

    // rAF-coalesced re-measure: repeated scroll/resize events collapse into at
    // most one measure per frame.
    let rafId: number | null = null;
    const scheduleMeasure = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        measure();
      });
    };

    // Every listener/observer registers its own teardown here; the effect
    // cleanup runs them all, so nothing leaks across deps changes, iframe
    // reloads, or unmount.
    const cleanups: Array<() => void> = [];

    const container = containerRef.current;
    const resizeObserver = new ResizeObserver(scheduleMeasure);
    if (container) {
      resizeObserver.observe(container);
      const body = container.querySelector('.markdown-body');
      if (body) resizeObserver.observe(body);
    }
    cleanups.push(() => resizeObserver.disconnect());

    window.addEventListener('resize', scheduleMeasure);
    cleanups.push(() => window.removeEventListener('resize', scheduleMeasure));

    // HTML panes: the iframe scrolls internally, so notes must be repositioned
    // on iframe scroll/resize and re-measured once the iframe finishes loading.
    // Skipped entirely for live panes: contentDocument is cross-origin-null there, and
    // attaching listeners to a cross-origin contentWindow would throw anyway.
    if (type === 'html' && viewMode !== 'live') {
      const iframe = iframeRef.current;
      if (iframe) {
        const attach = () => {
          const win = iframe.contentWindow;
          const doc = iframe.contentDocument;
          if (!win || !doc) return;
          win.addEventListener('scroll', scheduleMeasure);
          cleanups.push(() => win.removeEventListener('scroll', scheduleMeasure));
          const innerObserver = new ResizeObserver(scheduleMeasure);
          if (doc.documentElement) innerObserver.observe(doc.documentElement);
          cleanups.push(() => innerObserver.disconnect());
          scheduleMeasure();
        };
        if (iframe.contentDocument?.readyState === 'complete') {
          attach();
        } else {
          iframe.addEventListener('load', attach);
          cleanups.push(() => iframe.removeEventListener('load', attach));
        }
      }
    }

    cleanups.push(() => {
      if (rafId !== null) cancelAnimationFrame(rafId);
    });

    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [measure, type, containerRef, iframeRef, viewMode]);

  const toggleExpand = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  const missingSet = useMemo(() => new Set(missingIds), [missingIds]);
  const { placed, orphaned, missing } = useMemo(
    () => splitOrphaned(allPlacements, (p) => !missingSet.has(p.comment.id)),
    [allPlacements, missingSet]
  );
  // Both truly-orphaned notes and notes whose anchor element is absent are no longer
  // shown in-pane (see working/HANDOFF.md L2 決定: 別画面のコメントがorphanedなのはライブ
  // モードでは正常状態で、常時表示はノイズになる) — they're reported to the parent instead
  // (below) for display in CommentSidebar's 未解決 section. Memoized (not just inline) so
  // its reference — and unresolvedIds/the effect below that depends on it — stay stable
  // across renders that don't actually change the orphaned/missing sets; without this the
  // effect would fire, and notify the parent, on every render.
  const unresolved = useMemo(() => combineUnresolved(orphaned, missing), [orphaned, missing]);
  const unresolvedIds = useMemo(() => unresolved.map((p) => p.comment.id), [unresolved]);
  // Last ids array actually delivered to the parent, so a measure() pass that leaves the
  // unresolved set content-identical (e.g. missingSet is a freshly-allocated Set on every
  // remeasure even when its contents didn't change) doesn't re-notify the parent — that
  // would otherwise call setState upstream (App's unresolvedByPane) on every scroll/resize.
  const lastNotifiedIdsRef = useRef<string[]>([]);

  // onUnresolvedChange is intentionally omitted from the deps array: it's typically a
  // fresh inline closure on every parent render (see the analogous onPaneContentChange
  // effects in SplitView), so depending on its identity would re-notify the parent on
  // every unrelated re-render instead of only when the unresolved set itself changes.
  useEffect(() => {
    const prev = lastNotifiedIdsRef.current;
    const unchanged =
      prev.length === unresolvedIds.length && prev.every((id, i) => id === unresolvedIds[i]);
    if (unchanged) return;
    lastNotifiedIdsRef.current = unresolvedIds;
    onUnresolvedChange?.(unresolvedIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unresolvedIds]);

  return (
    <>
      {placed.map((p) => {
        const pos = positions[p.comment.id];
        if (!pos || !pos.visible) return null;
        return (
          <StickyNote
            key={p.comment.id}
            comment={p.comment}
            line={p.line}
            floating
            style={{ top: `${pos.top}px` }}
            expanded={expandedId === p.comment.id}
            onToggle={() => toggleExpand(p.comment.id)}
            onChanged={onChanged}
            onCopyLink={onCopyLink}
            flashing={flashCommentId === p.comment.id}
          />
        );
      })}
    </>
  );
}

interface StickyNoteProps {
  comment: Comment;
  line: number;
  floating?: boolean;
  style?: React.CSSProperties;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
  /** Called with a user-facing status message after a successful clipboard write. */
  onCopyLink?: (message: string) => void;
  /** Briefly applies a flash-highlight animation (e.g. after following a comment link). */
  flashing?: boolean;
}

function excerpt(body: string, max = 48): string {
  const firstLine = body.split('\n')[0];
  return firstLine.length > max ? `${firstLine.slice(0, max)}…` : firstLine;
}

function StickyNote({
  comment,
  line,
  floating,
  style,
  expanded,
  onToggle,
  onChanged,
  onCopyLink,
  flashing,
}: StickyNoteProps) {
  const actions = useCommentActions(onChanged);
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState(comment.body);
  const isBusy = actions.busyId === comment.id;

  // Drag state (floating notes only). dragDelta is the transient in-progress
  // pointer movement; it is combined with the persisted base offset for
  // preview and cleared once the drag ends (persisted or not).
  const [dragDelta, setDragDelta] = useState<NoteOffset | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragStateRef = useRef<{ startX: number; startY: number; base: NoteOffset } | null>(null);
  // Set on pointerup after a real drag so the click event the browser fires
  // right after doesn't also toggle expand/collapse.
  const suppressClickRef = useRef(false);

  const baseOffset: NoteOffset = comment.noteOffset ?? { dx: 0, dy: 0 };
  const previewOffset = dragDelta ? nextOffset(baseOffset, dragDelta) : baseOffset;

  const handleNoteClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onToggle();
  };

  const handleHeaderPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStateRef.current = { startX: e.clientX, startY: e.clientY, base: baseOffset };
    setDragDelta({ dx: 0, dy: 0 });
  };

  const handleHeaderPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const ds = dragStateRef.current;
    if (!ds) return;
    const delta: NoteOffset = { dx: e.clientX - ds.startX, dy: e.clientY - ds.startY };
    if (!isDragging && (Math.abs(delta.dx) > DRAG_THRESHOLD || Math.abs(delta.dy) > DRAG_THRESHOLD)) {
      setIsDragging(true);
    }
    setDragDelta(delta);
  };

  const handleHeaderPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const ds = dragStateRef.current;
    dragStateRef.current = null;
    if (!ds) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const delta: NoteOffset = { dx: e.clientX - ds.startX, dy: e.clientY - ds.startY };
    const moved = Math.abs(delta.dx) > DRAG_THRESHOLD || Math.abs(delta.dy) > DRAG_THRESHOLD;
    setIsDragging(false);
    setDragDelta(null);
    if (moved) {
      suppressClickRef.current = true;
      const final = nextOffset(ds.base, delta);
      actions.saveOffset(comment.id, final.dx, final.dy);
    }
  };

  // Shared cleanup for pointer sequences that end WITHOUT a normal pointerup
  // (cancel or lost capture, e.g. touch/pen interruption or an OS gesture).
  // Unlike handleHeaderPointerUp this never persists an offset: the drag is
  // simply abandoned so a later plain hover doesn't keep dragging the note.
  const resetDragState = (e: React.PointerEvent<HTMLDivElement>) => {
    dragStateRef.current = null;
    setDragDelta(null);
    setIsDragging(false);
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Capture may already be released; nothing to clean up.
    }
  };

  const handleHeaderPointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    resetDragState(e);
  };

  const handleHeaderLostPointerCapture = (e: React.PointerEvent<HTMLDivElement>) => {
    resetDragState(e);
  };

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditBody(comment.body);
    setEditing(true);
  };

  const cancelEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditing(false);
  };

  const saveEdit = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!editBody.trim()) return;
    await actions.saveBody(comment.id, editBody);
    setEditing(false);
  };

  // "リンクをコピー": /#/comment/<id> は静的/ライブ/markdown共通のアンカー再解決経路を持つため、
  // モードを問わずこの1形式に一本化する ( 行リンクはmd側にのみ残す。html側の行リンクは廃止 )。
  const handleCopyLink = (e: React.MouseEvent | React.PointerEvent) => {
    e.stopPropagation();
    const url = `${window.location.origin}${window.location.pathname}#/comment/${encodeURIComponent(comment.id)}`;
    navigator.clipboard
      .writeText(url)
      .then(() => onCopyLink?.('付箋リンクをコピーしました'))
      .catch((err) => console.error('Failed to copy', err));
  };

  const className = [
    'sticky-note',
    floating ? 'sticky-note-floating' : '',
    comment.resolved ? 'sticky-note-resolved' : '',
    expanded ? 'sticky-note-expanded' : '',
    isDragging ? 'sticky-note-dragging' : '',
    flashing ? 'sticky-note-flash' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const noteStyle: React.CSSProperties | undefined = floating
    ? { ...style, transform: `translate(${previewOffset.dx}px, ${previewOffset.dy}px)` }
    : style;

  return (
    <div className={className} style={noteStyle} onClick={handleNoteClick}>
      <div
        className="sticky-note-header"
        onPointerDown={floating ? handleHeaderPointerDown : undefined}
        onPointerMove={floating ? handleHeaderPointerMove : undefined}
        onPointerUp={floating ? handleHeaderPointerUp : undefined}
        onPointerCancel={floating ? handleHeaderPointerCancel : undefined}
        onLostPointerCapture={floating ? handleHeaderLostPointerCapture : undefined}
      >
        <span className="sticky-note-dot" />
        <span className="sticky-note-author">{comment.author}</span>
        {comment.resolved && <span className="sticky-note-badge-resolved">解決済み</span>}
        <span className="sticky-note-line">{comment.anchor.type === 'dom' ? 'DOM' : `L${line}`}</span>
        <button
          className="sticky-note-btn-link"
          onClick={handleCopyLink}
          onPointerDown={(e) => e.stopPropagation()}
          title="付箋リンクをコピー"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
          </svg>
        </button>
      </div>

      {!expanded && <div className="sticky-note-excerpt">{excerpt(comment.body)}</div>}

      {expanded && !editing && (
        <div className="sticky-note-content">
          <div className="sticky-note-body">{comment.body}</div>
          <div className="sticky-note-actions" onClick={(e) => e.stopPropagation()}>
            <button
              className="sticky-note-btn-resolve"
              onClick={(e) => {
                e.stopPropagation();
                actions.toggleResolved(comment);
              }}
              disabled={isBusy}
            >
              {comment.resolved ? '未解決に戻す' : '解決済みにする'}
            </button>
            <button className="sticky-note-btn-edit" onClick={startEdit} disabled={isBusy}>
              編集
            </button>
            <button
              className="sticky-note-btn-delete"
              onClick={(e) => {
                e.stopPropagation();
                if (window.confirm('このコメントを削除しますか?')) {
                  actions.remove(comment.id);
                }
              }}
              disabled={isBusy}
            >
              削除
            </button>
          </div>
        </div>
      )}

      {expanded && editing && (
        <div className="sticky-note-content">
          <div className="sticky-note-edit" onClick={(e) => e.stopPropagation()}>
            <textarea
              className="comment-edit-textarea"
              value={editBody}
              autoFocus
              onChange={(e) => setEditBody(e.target.value)}
              disabled={isBusy}
            />
            <div className="comment-item-actions">
              <button className="btn-secondary" onClick={cancelEdit} disabled={isBusy}>
                キャンセル
              </button>
              <button className="btn-primary" onClick={saveEdit} disabled={isBusy || !editBody.trim()}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
