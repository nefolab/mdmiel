/**
 * Pure, React-independent helpers for the live-pane <-> BridgeResolver agent postMessage
 * protocol. Extracted from SplitView (and now hooks/useLiveAgentBridge) so the message
 * validation/shaping logic can be unit-tested without mounting React or an iframe.
 *
 * Wire protocol (unchanged from the original SplitView implementation):
 * - parent -> agent: { mdmiel: true, nonce, type: 'anchors', anchors }
 *                     { mdmiel: true, nonce, type: 'commentMode', on }
 *                     { mdmiel: true, nonce, type: 'scrollTo', selector }
 * - agent -> parent: { mdmiel: true, nonce, type: 'ready' }
 *                     { mdmiel: true, nonce, type: 'rects', rects }
 *                     { mdmiel: true, nonce, type: 'pick', selector, snippet, snippetHash, rect }
 */
import { Comment } from './comments';
import { LiveRect } from '../components/StickyNoteLayer';

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export interface AnchorPayloadItem {
  id: string;
  selector: string | undefined;
  snippet: string;
  snippetHash: string;
}

/** Builds the "anchors" message payload sent to a live pane's agent from its DOM-anchored comments. */
export function buildAnchorsPayload(comments: Comment[]): AnchorPayloadItem[] {
  return comments
    .filter((c) => c.anchor.type === 'dom' && !!c.anchor.selector)
    .map((c) => ({
      id: c.id,
      selector: c.anchor.selector,
      snippet: c.anchor.snippet,
      snippetHash: c.anchor.snippetHash,
    }));
}

/** Builds the liveRects map from a "rects" message's (untrusted) rects array, dropping malformed entries. */
export function buildLiveRectsMap(rects: unknown[]): Record<string, LiveRect> {
  const map: Record<string, LiveRect> = {};
  for (const entry of rects) {
    if (!entry || typeof entry !== 'object' || typeof (entry as { id?: unknown }).id !== 'string') continue;
    const e = entry as { id: string; found?: unknown; rect?: unknown; visible?: unknown };
    if (e.found === true && e.rect) {
      const r = e.rect as { top?: unknown; left?: unknown; width?: unknown; height?: unknown };
      if (!isFiniteNumber(r.top) || !isFiniteNumber(r.left) || !isFiniteNumber(r.width) || !isFiniteNumber(r.height)) {
        continue;
      }
      map[e.id] = {
        found: true,
        rect: { top: r.top, left: r.left, width: r.width, height: r.height },
        visible: e.visible === true,
      };
    } else {
      map[e.id] = { found: false, visible: false };
    }
  }
  return map;
}

export interface PickPayload {
  selector: string;
  snippet: string;
  snippetHash: string;
  rect: { top: number; left: number };
}

/** Validates a "pick" message's fields; returns null if the shape doesn't match what we require. */
export function parsePickPayload(data: Record<string, unknown>): PickPayload | null {
  const rect = data.rect as { top?: unknown; left?: unknown } | undefined;
  if (
    typeof data.selector !== 'string' ||
    typeof data.snippet !== 'string' ||
    typeof data.snippetHash !== 'string' ||
    !rect ||
    !isFiniteNumber(rect.top) ||
    !isFiniteNumber(rect.left)
  ) {
    return null;
  }
  return {
    selector: data.selector,
    snippet: data.snippet,
    snippetHash: data.snippetHash,
    rect: { top: rect.top, left: rect.left },
  };
}

export type IncomingAgentMessage =
  | { type: 'ready' }
  | { type: 'rects'; rects: unknown[] }
  | { type: 'pick'; payload: PickPayload };

/**
 * Validates a raw postMessage event's `data` against the expected nonce and returns its
 * typed message, or null if the message doesn't belong to us / has an unrecognized or
 * malformed shape. Does NOT check event.source; callers must verify that separately
 * (this module has no access to the iframe/window).
 */
export function parseIncomingMessage(data: unknown, expectedNonce: string): IncomingAgentMessage | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.mdmiel !== true || d.nonce !== expectedNonce) return null;

  if (d.type === 'ready') return { type: 'ready' };
  if (d.type === 'rects' && Array.isArray(d.rects)) return { type: 'rects', rects: d.rects };
  if (d.type === 'pick') {
    const payload = parsePickPayload(d);
    return payload ? { type: 'pick', payload } : null;
  }
  return null;
}

/**
 * Computes a "pick" position relative to the pane's content container (the coordinate
 * space StickyNoteLayer's comment-composer popover is positioned in), from the iframe's
 * and container's viewport rects plus the pick rect reported by the agent (which is
 * relative to the iframe's own viewport).
 */
export function computePickPosition(
  containerRect: { top: number; left: number },
  iframeRect: { top: number; left: number },
  pickRect: { top: number; left: number }
): { top: number; left: number } {
  return {
    top: iframeRect.top - containerRect.top + pickRect.top,
    left: iframeRect.left - containerRect.left + pickRect.left,
  };
}
