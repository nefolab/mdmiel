import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Comment } from '../lib/comments';
import { ViewMode } from '../lib/viewMode';
import { LiveRect } from '../components/StickyNoteLayer';
import { buildAnchorsPayload, buildLiveRectsMap, computePickPosition, parseIncomingMessage } from '../lib/liveBridge';
import { PanePickResult } from '../lib/domAnchor';

/** Minimal shape useLiveAgentBridge needs from a pane's loaded data. */
interface PaneDataLike {
  path: string;
}

/** Result handed to onPick when the agent reports a "pick" while the pane is armed. */
export type LiveAgentPickResult = PanePickResult;

export interface UseLiveAgentBridgeParams<T extends PaneDataLike> {
  /** Filesystem revision; a change remounts the live iframe with a new nonce. */
  revision: number;
  /** Target path for this pane (from viewState), driving nonce (re)generation independent of
   *  whether `data` for that path has finished loading yet. */
  path: string | undefined;
  viewMode: ViewMode;
  /** The pane's loaded data, once fetched. Bridge activation and bridge.path both wait on this. */
  data: T | null;
  /** Current DOM-anchored comments for this pane; re-sent to the agent whenever this changes. */
  comments: Comment[];
  iframeRef: React.RefObject<HTMLIFrameElement>;
  /** The pane-content container, used to translate a "pick" rect into popover coordinates. */
  containerRef: React.RefObject<HTMLDivElement>;
  /** Called when the agent reports a "pick" while armed (armed is auto-cleared beforehand). */
  onPick: (result: LiveAgentPickResult) => void;
}

export interface UseLiveAgentBridgeResult {
  /** Per-pane handshake token for the current live agent instance; '' when not in live mode. */
  nonce: string;
  /** True once the current agent instance has signalled "ready". */
  agentReady: boolean;
  /** Latest BridgeResolver measurement per comment id, from the agent's "rects" messages. */
  liveRects: Record<string, LiveRect>;
  /** True once the current agent instance has delivered its first rects measurement. */
  measured: boolean;
  /** True after the current live document has started leaving via page navigation. */
  blocked: boolean;
  /** Whether this pane may currently enter comment placement mode. */
  canComment: boolean;
  /** Whether the next "pick" from the agent should open the comment composer. */
  armed: boolean;
  setArmed: React.Dispatch<React.SetStateAction<boolean>>;
  toggleArmed: () => void;
  /** Re-sends the pane's current dom-anchored comments to the agent for (re-)resolution. */
  sendAnchors: () => void;
  /** Asks the agent to scroll a selector into view (used by comment-link navigation). */
  sendScrollTo: (selector: string) => void;
  /** Remounts the current live iframe with a fresh bridge nonce. */
  reload: () => void;
}

/**
 * Owns one live pane's agent-bridge state and postMessage wiring: the per-instance nonce,
 * the "ready"/"rects"/"pick" message listener (validated against event.source + nonce),
 * "コメント追加"-armed state, and the anchors/commentMode (re-)send effects.
 *
 * Extracted from SplitView, which previously ran this logic twice inline (once per pane)
 * behind a single shared window listener. Behavior, message shapes, and timing are
 * unchanged; only the state/effects have moved. Mount two instances (one per pane) from
 * SplitView; each instance's listener only ever processes messages whose event.source is
 * its own iframe.contentWindow, so the two coexist safely.
 */
export function useLiveAgentBridge<T extends PaneDataLike>({
  path,
  revision,
  viewMode,
  data,
  comments,
  iframeRef,
  containerRef,
  onPick,
}: UseLiveAgentBridgeParams<T>): UseLiveAgentBridgeResult {
  // Phase 1 navigation-guard state. This generation tracking is intentionally temporary;
  // Phase 2 will move it into the live-session reducer.
  const [reloadKey, setReloadKey] = useState(0);
  const [measured, setMeasured] = useState(false);
  const blockedNonceRef = useRef('');
  const [blockedNonce, setBlockedNonce] = useState('');

  // Regenerated whenever the pane switches to a new path or (re-)enters live mode, so each
  // fresh agent instance gets its own nonce; the iframe is remounted (key change) in
  // lockstep via viewMode+nonce by the caller.
  const nonce = useMemo(
    () => (viewMode === 'live' && path ? crypto.randomUUID() : ''),
    [viewMode, path, revision, reloadKey]
  );
  const blocked = blockedNonce !== '' && blockedNonce === nonce;
  const canComment = viewMode === 'live' ? !blocked : true;

  const [agentReady, setAgentReady] = useState(false);
  const [liveRects, setLiveRects] = useState<Record<string, LiveRect>>({});
  const [armed, setArmed] = useState(false);

  // Read by the message listener (added once, below) to validate incoming postMessage
  // events against this pane's current nonce (and read its current path/armed-for-pick
  // state) without re-adding the listener every time mode/nonce/armed changes.
  const bridgeRef = useRef<{ nonce: string; path: string; armed: boolean } | undefined>(undefined);

  // useLayoutEffect 必須。iframe は nonce が変わる同じ commit でマウントされるため、
  // paint 後の useEffect では新文書が即 location.href を書き換えた際の unload を旧 nonce の
  // bridgeRef で拒否しうる。特に blocked からの reload() では旧 nonce が
  // blockedNonceRef と一致し、新文書のメッセージまで冒頭ガードで破棄されて無言失敗へ戻る。
  // この effect を useEffect に戻してはならない。
  useLayoutEffect(() => {
    bridgeRef.current = viewMode === 'live' && nonce && data ? { nonce, path: data.path, armed } : undefined;
  }, [viewMode, nonce, data, armed]);

  // Resets stale bridge state whenever a fresh agent instance is about to mount (new nonce
  // = new iframe key), so a leftover "ready"/rects/armed from a previous agent never leaks
  // into the new one.
  // こちらも iframe の同一 commit でのマウントより後、paint より前に同期リセットする必要がある。
  // useEffect に戻すと、即時遷移した新文書の unload を旧世代の状態と blockedNonceRef で扱い、
  // 新 nonce のメッセージを破棄しうるため、必ず useLayoutEffect のままにする。
  useLayoutEffect(() => {
    setAgentReady(false);
    setLiveRects({});
    setArmed(false);
    setMeasured(false);
  }, [nonce]);

  // onPick may be a fresh closure every render (the caller isn't required to memoize it);
  // keep the listener effect itself attached for the component's lifetime (matching the
  // original single-listener-for-lifetime behavior) by always invoking the latest onPick
  // via this ref instead of putting onPick in the listener effect's deps.
  const onPickRef = useRef(onPick);
  useEffect(() => {
    onPickRef.current = onPick;
  }, [onPick]);

  // Verifies event.source === this pane's iframe.contentWindow and the nonce matches
  // before trusting the message. Non-matching messages (wrong source, wrong/missing
  // nonce, foreign origin payload shape) are silently ignored rather than acted on.
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const bridge = bridgeRef.current;
      if (!bridge) return;
      if (blockedNonceRef.current && blockedNonceRef.current === bridge.nonce) return;
      const iframe = iframeRef.current;
      if (!iframe || event.source !== iframe.contentWindow) return;

      const message = parseIncomingMessage(event.data, bridge.nonce);
      if (!message) return;

      if (message.type === 'ready') {
        setAgentReady(true);
      } else if (message.type === 'rects') {
        setLiveRects(buildLiveRectsMap(message.rects));
        setMeasured(true);
      } else if (message.type === 'pick' && bridge.armed) {
        const container = containerRef.current;
        if (!container) return;
        const containerRect = container.getBoundingClientRect();
        const iframeRect = iframe.getBoundingClientRect();
        const { top, left } = computePickPosition(containerRect, iframeRect, message.payload.rect);
        onPickRef.current({
          path: bridge.path,
          top,
          left,
          selector: message.payload.selector,
          snippet: message.payload.snippet,
          snippetHash: message.payload.snippetHash,
        });
        setArmed(false);
      } else if (message.type === 'unload') {
        blockedNonceRef.current = bridge.nonce;
        setBlockedNonce(bridge.nonce);
        setAgentReady(false);
        setArmed(false);
        setMeasured(false);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [iframeRef, containerRef]);

  // Sends the pane's current DOM-anchored comments to its live agent for (re-)resolution.
  const sendAnchors = () => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow || !nonce) return;
    const anchors = buildAnchorsPayload(comments);
    iframe.contentWindow.postMessage({ mdmiel: true, nonce, type: 'anchors', anchors }, '*');
  };

  // Called once the agent has signalled "ready" and again whenever the comment list
  // changes (e.g. a new DOM comment was just created) while the pane stays in live mode.
  useEffect(() => {
    if (viewMode === 'live' && agentReady) sendAnchors();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, agentReady, comments, nonce]);

  // Tells the agent whether "コメント追加" is armed, so it only sends a "pick" message for
  // the next click while armed. bridge.armed (message listener above) is kept as a
  // defense-in-depth backstop even though the agent should no longer send pick when unarmed.
  const sendCommentMode = (on: boolean) => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow || !nonce) return;
    iframe.contentWindow.postMessage({ mdmiel: true, nonce, type: 'commentMode', on }, '*');
  };

  useEffect(() => {
    if (viewMode === 'live' && agentReady) sendCommentMode(armed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, agentReady, armed, nonce]);

  const sendScrollTo = (selector: string) => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow || !nonce) return;
    iframe.contentWindow.postMessage({ mdmiel: true, nonce, type: 'scrollTo', selector }, '*');
  };

  const toggleArmed = () => setArmed((v) => !v);
  const reload = () => setReloadKey((v) => v + 1);

  return {
    nonce,
    agentReady,
    liveRects,
    measured,
    blocked,
    canComment,
    armed,
    setArmed,
    toggleArmed,
    sendAnchors,
    sendScrollTo,
    reload,
  };
}
