import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ViewState, generateHash } from '../lib/anchor';
import { Comment, CommentAnchor, computeSnippet, snippetHash } from '../lib/comments';
import { createComment } from '../lib/commentsApi';
import { StickyNoteLayer, LiveRect } from './StickyNoteLayer';
import { resolvePlacements } from '../lib/stickyLayout';
import { renderMarkdown } from '../renderer/markdown';
import { renderHtml, renderHtmlLive } from '../renderer/html';
import { ViewMode, getViewMode, setViewMode as persistViewMode } from '../lib/viewMode';

interface PaneData {
  path: string;
  type: 'markdown' | 'html';
  content: string;
  renderedHtml: string;
}

export interface PaneContentInfo {
  path: string;
  type: 'markdown' | 'html';
  content: string;
}

export interface SplitViewProps {
  viewState: ViewState;
  onClosePane: (pane: 'left' | 'right') => void;
  onPaneContentChange?: (pane: 'left' | 'right', data: PaneContentInfo | null) => void;
  onCommentAdded?: () => void;
  leftComments?: Comment[];
  rightComments?: Comment[];
  onCommentsChanged?: () => void;
  /**
   * Set by App when the URL was a "/#/comment/<id>" link: the id of the comment to
   * scroll to and flash-highlight once its pane has finished loading. Cleared via
   * onFocusHandled once the scroll+flash has actually been performed (or the target
   * turns out not to belong to either open pane).
   */
  focusCommentId?: string;
  onFocusHandled?: () => void;
}

interface MenuState {
  pane: 'left' | 'right';
  line: number;
  top: number;
  left: number;
}

/** anchor payload for a DOM-anchored draft, computed from the agent's "pick" message. */
interface DomAnchorDraft {
  selector: string;
  snippet: string;
  snippetHash: string;
}

interface CommentDraft {
  pane: 'left' | 'right';
  path: string;
  line: number;
  top: number;
  left: number;
  body: string;
  submitting: boolean;
  error: string | null;
  /** Present for comments picked in a live pane; posted as anchor.type === 'dom'. */
  domAnchor?: DomAnchorDraft;
}

interface ViewModeSwitcherProps {
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
}

/** 静的/ライブの切替トグル。ヘッダーのtheme-switcherと同系のUI ( CSS変数のみ使用 )。 */
function ViewModeSwitcher({ mode, onChange }: ViewModeSwitcherProps) {
  return (
    <div className="view-mode-switcher-track">
      <button
        className={`view-mode-switcher-btn ${mode === 'static' ? 'active' : ''}`}
        onClick={() => onChange('static')}
        title="静的モードに切替 ( スクリプト無効・安全側 )"
      >
        静的
      </button>
      <button
        className={`view-mode-switcher-btn ${mode === 'live' ? 'active' : ''}`}
        onClick={() => onChange('live')}
        title="ライブモードに切替 ( JS駆動プロトタイプをそのまま実行 )"
      >
        ライブ
      </button>
    </div>
  );
}

export function SplitView({
  viewState,
  onClosePane,
  onPaneContentChange,
  onCommentAdded,
  leftComments = [],
  rightComments = [],
  onCommentsChanged,
  focusCommentId,
  onFocusHandled,
}: SplitViewProps) {
  const [leftData, setLeftData] = useState<PaneData | null>(null);
  const [rightData, setRightData] = useState<PaneData | null>(null);
  const [leftError, setLeftError] = useState<string | null>(null);
  const [rightError, setRightError] = useState<string | null>(null);
  const [menuState, setMenuState] = useState<MenuState | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [commentDraft, setCommentDraft] = useState<CommentDraft | null>(null);
  const [leftViewMode, setLeftViewMode] = useState<ViewMode>('static');
  const [rightViewMode, setRightViewMode] = useState<ViewMode>('static');
  // BridgeResolver measurement (agent -> parent "rects" message), keyed by comment id.
  const [leftLiveRects, setLeftLiveRects] = useState<Record<string, LiveRect>>({});
  const [rightLiveRects, setRightLiveRects] = useState<Record<string, LiveRect>>({});
  // Flips true once the live pane's measurement agent has sent its "ready" message;
  // gates sendAnchorsToAgent (no point posting anchors before the agent is listening).
  const [leftAgentReady, setLeftAgentReady] = useState(false);
  const [rightAgentReady, setRightAgentReady] = useState(false);
  // "コメント追加" armed state: while true, the next "pick" message from that pane's
  // agent opens the comment composer instead of being ignored. Auto-disarms after one pick.
  const [leftArmed, setLeftArmed] = useState(false);
  const [rightArmed, setRightArmed] = useState(false);
  // Comment id to briefly flash-highlight on its sticky-note card (set once a
  // /#/comment/<id> link has been resolved and its pane/anchor located).
  const [flashCommentId, setFlashCommentId] = useState<string | null>(null);

  const splitViewRef = useRef<HTMLDivElement>(null);
  const leftPaneRef = useRef<HTMLDivElement>(null);
  const rightPaneRef = useRef<HTMLDivElement>(null);
  const leftContentRef = useRef<HTMLDivElement>(null);
  const rightContentRef = useRef<HTMLDivElement>(null);
  const leftIframeRef = useRef<HTMLIFrameElement>(null);
  const rightIframeRef = useRef<HTMLIFrameElement>(null);
  // Tracks the currently-registered contextmenu handler (and the document it
  // was attached to) per pane, so handleIframeLoad can remove the previous
  // listener before adding a new one instead of stacking duplicates if the
  // same document fires 'load' more than once.
  const iframeContextMenuRef = useRef<
    Partial<Record<'left' | 'right', { doc: Document; handler: (e: MouseEvent) => void }>>
  >({});
  // Read by the single window 'message' listener (registered once, below) to validate
  // incoming postMessage events against the live pane's current nonce (and read the
  // pane's current path/armed-for-pick state) without re-adding the listener every time
  // a pane's mode/nonce/comments/armed-state changes.
  const liveBridgeRef = useRef<Partial<Record<'left' | 'right', { nonce: string; path: string; armed: boolean }>>>(
    {}
  );

  const leftPath = viewState.path || viewState.left;
  const rightPath = viewState.right;

  // Per-pane handshake token for the live-mode measurement agent. Regenerated whenever the
  // pane switches to a new path or (re-)enters live mode, so each fresh agent instance gets
  // its own nonce; the iframe is remounted (key change) in lockstep via viewMode+nonce below.
  const leftNonce = useMemo(
    () => (leftViewMode === 'live' && leftPath ? crypto.randomUUID() : ''),
    [leftViewMode, leftPath]
  );
  const rightNonce = useMemo(
    () => (rightViewMode === 'live' && rightPath ? crypto.randomUUID() : ''),
    [rightViewMode, rightPath]
  );

  // Load each pane's persisted view mode when its path changes (new file = re-check
  // localStorage; a path with no saved preference falls back to 'static').
  useEffect(() => {
    setLeftViewMode(leftPath ? getViewMode(leftPath) : 'static');
  }, [leftPath]);

  useEffect(() => {
    setRightViewMode(rightPath ? getViewMode(rightPath) : 'static');
  }, [rightPath]);

  const handleSetViewMode = (pane: 'left' | 'right', mode: ViewMode) => {
    const path = pane === 'left' ? leftPath : rightPath;
    if (!path) return;
    persistViewMode(path, mode);
    if (pane === 'left') {
      setLeftViewMode(mode);
    } else {
      setRightViewMode(mode);
    }
  };

  // Keep the bridge ref in sync with each pane's current live nonce/path/armed-state so
  // the message listener below (added once on mount) always validates and reads against
  // the latest values without needing to re-add itself.
  useEffect(() => {
    liveBridgeRef.current.left =
      leftViewMode === 'live' && leftNonce && leftData
        ? { nonce: leftNonce, path: leftData.path, armed: leftArmed }
        : undefined;
  }, [leftViewMode, leftNonce, leftData, leftArmed]);

  useEffect(() => {
    liveBridgeRef.current.right =
      rightViewMode === 'live' && rightNonce && rightData
        ? { nonce: rightNonce, path: rightData.path, armed: rightArmed }
        : undefined;
  }, [rightViewMode, rightNonce, rightData, rightArmed]);

  // Resets stale bridge state whenever a fresh agent instance is about to mount (new nonce
  // = new iframe key), so a leftover "ready"/rects/armed from a previous pane/agent never
  // leaks into the new one.
  useEffect(() => {
    setLeftAgentReady(false);
    setLeftLiveRects({});
    setLeftArmed(false);
  }, [leftNonce]);

  useEffect(() => {
    setRightAgentReady(false);
    setRightLiveRects({});
    setRightArmed(false);
  }, [rightNonce]);

  // Basic structural validation for numeric fields coming from the agent over postMessage
  // (untrusted-ish: same nonce/source as us, but still worth bounding before use in layout math).
  const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

  // Single window-level listener for the whole SplitView lifetime: verifies
  // event.source === the pane's iframe.contentWindow and the nonce matches before trusting
  // the message. Non-matching messages (wrong source, wrong/missing nonce, foreign origin
  // payload shape) are silently ignored rather than acted on.
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const panes: Array<'left' | 'right'> = ['left', 'right'];
      for (const pane of panes) {
        const bridge = liveBridgeRef.current[pane];
        if (!bridge) continue;
        const iframe = pane === 'left' ? leftIframeRef.current : rightIframeRef.current;
        if (!iframe || event.source !== iframe.contentWindow) continue;
        const data = event.data;
        if (!data || typeof data !== 'object' || data.mdmiel !== true || data.nonce !== bridge.nonce) continue;

        if (data.type === 'ready') {
          if (pane === 'left') setLeftAgentReady(true);
          else setRightAgentReady(true);
        } else if (data.type === 'rects' && Array.isArray(data.rects)) {
          const map: Record<string, LiveRect> = {};
          for (const entry of data.rects) {
            if (!entry || typeof entry.id !== 'string') continue;
            if (entry.found === true && entry.rect) {
              const r = entry.rect;
              if (!isFiniteNumber(r.top) || !isFiniteNumber(r.left) || !isFiniteNumber(r.width) || !isFiniteNumber(r.height)) {
                continue;
              }
              map[entry.id] = {
                found: true,
                rect: { top: r.top, left: r.left, width: r.width, height: r.height },
                visible: entry.visible === true,
              };
            } else {
              map[entry.id] = { found: false, visible: false };
            }
          }
          if (pane === 'left') setLeftLiveRects(map);
          else setRightLiveRects(map);
        } else if (data.type === 'pick' && bridge.armed) {
          if (
            typeof data.selector !== 'string' ||
            typeof data.snippet !== 'string' ||
            typeof data.snippetHash !== 'string' ||
            !data.rect ||
            !isFiniteNumber(data.rect.top) ||
            !isFiniteNumber(data.rect.left)
          ) {
            continue;
          }
          const container = pane === 'left' ? leftContentRef.current : rightContentRef.current;
          if (!container) continue;
          const containerRect = container.getBoundingClientRect();
          const iframeRect = iframe.getBoundingClientRect();
          setCommentDraft({
            pane,
            path: bridge.path,
            line: 0,
            top: iframeRect.top - containerRect.top + data.rect.top,
            left: iframeRect.left - containerRect.left + data.rect.left,
            body: '',
            submitting: false,
            error: null,
            domAnchor: { selector: data.selector, snippet: data.snippet, snippetHash: data.snippetHash },
          });
          if (pane === 'left') setLeftArmed(false);
          else setRightArmed(false);
        }
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // Sends the pane's current DOM-anchored comments to its live agent for (re-)resolution.
  // Called once the agent has signalled "ready" and again whenever the comment list changes
  // (e.g. a new DOM comment was just created) while the pane stays in live mode.
  const sendAnchorsToAgent = (pane: 'left' | 'right') => {
    const iframe = pane === 'left' ? leftIframeRef.current : rightIframeRef.current;
    const nonce = pane === 'left' ? leftNonce : rightNonce;
    const comments = pane === 'left' ? leftComments : rightComments;
    if (!iframe?.contentWindow || !nonce) return;
    const anchors = comments
      .filter((c) => c.anchor.type === 'dom' && !!c.anchor.selector)
      .map((c) => ({
        id: c.id,
        selector: c.anchor.selector,
        snippet: c.anchor.snippet,
        snippetHash: c.anchor.snippetHash,
      }));
    iframe.contentWindow.postMessage({ mdmiel: true, nonce, type: 'anchors', anchors }, '*');
  };

  useEffect(() => {
    if (leftViewMode === 'live' && leftAgentReady) sendAnchorsToAgent('left');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leftViewMode, leftAgentReady, leftComments, leftNonce]);

  useEffect(() => {
    if (rightViewMode === 'live' && rightAgentReady) sendAnchorsToAgent('right');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rightViewMode, rightAgentReady, rightComments, rightNonce]);

  const handleToggleArmed = (pane: 'left' | 'right') => {
    if (pane === 'left') setLeftArmed((v) => !v);
    else setRightArmed((v) => !v);
  };

  const showToast = (message: string) => {
    setToastMessage(message);
    setTimeout(() => setToastMessage(null), 3000);
  };

  const fetchFile = async (filePath: string): Promise<PaneData> => {
    const res = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`);
    if (!res.ok) {
      throw new Error(`ファイルの取得に失敗しました: ${filePath}`);
    }
    const data = await res.json();
    let rendered = '';
    if (data.type === 'markdown') {
      rendered = renderMarkdown(data.content);
    } else if (data.type === 'html') {
      rendered = renderHtml(data.content, filePath);
    }
    return {
      path: data.path,
      type: data.type as 'markdown' | 'html',
      content: data.content,
      renderedHtml: rendered,
    };
  };

  // Load left pane data
  useEffect(() => {
    if (leftPath) {
      setLeftError(null);
      fetchFile(leftPath)
        .then((data) => setLeftData(data))
        .catch((err) => setLeftError(err.message));
    } else {
      setLeftData(null);
    }
  }, [leftPath]);

  // Load right pane data
  useEffect(() => {
    if (rightPath) {
      setRightError(null);
      fetchFile(rightPath)
        .then((data) => setRightData(data))
        .catch((err) => setRightError(err.message));
    } else {
      setRightData(null);
    }
  }, [rightPath]);

  // Share loaded pane content (path/type/content) with the parent so it can
  // pass raw file content down to CommentSidebar for rematchLine().
  useEffect(() => {
    onPaneContentChange?.(
      'left',
      leftData ? { path: leftData.path, type: leftData.type, content: leftData.content } : null
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leftData]);

  useEffect(() => {
    onPaneContentChange?.(
      'right',
      rightData ? { path: rightData.path, type: rightData.type, content: rightData.content } : null
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rightData]);

  const scrollToLine = (
    paneRef: React.RefObject<HTMLDivElement>,
    iframeRef: React.RefObject<HTMLIFrameElement>,
    type: 'markdown' | 'html',
    line: number,
    selectorOverride?: string
  ) => {
    const performScroll = (container: HTMLElement | Document) => {
      // selectorOverride lets comment-link navigation (App -> #/comment/<id>) target a
      // DOM-anchored comment's element directly, since it has no data-source-line to key on
      // (used for the DirectDomResolver path: a DOM anchor being viewed in a static pane).
      const el = (
        selectorOverride
          ? container.querySelector(selectorOverride)
          : container.querySelector(`[data-source-line="${line}"]`)
      ) as HTMLElement | null;
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.remove('source-line-highlight');
        // Force reflow
        void el.offsetHeight;
        el.classList.add('source-line-highlight');

        setTimeout(() => {
          el.classList.remove('source-line-highlight');
        }, 3000);
      }
    };

    if (type === 'markdown' && paneRef.current) {
      performScroll(paneRef.current);
    } else if (type === 'html' && iframeRef.current) {
      const iframe = iframeRef.current;
      const run = () => {
        if (iframe.contentDocument) {
          performScroll(iframe.contentDocument.body || iframe.contentDocument.documentElement);
        }
      };
      if (iframe.contentDocument && iframe.contentDocument.readyState === 'complete') {
        run();
      } else {
        iframe.addEventListener('load', run, { once: true });
      }
    }
  };

  // Scroll left pane when target line changes
  useEffect(() => {
    if (leftData) {
      const targetLine = viewState.path ? viewState.line : viewState.leftLine;
      if (targetLine) {
        const timer = setTimeout(() => {
          scrollToLine(leftPaneRef, leftIframeRef, leftData.type, targetLine);
        }, 150);
        return () => clearTimeout(timer);
      }
    }
  }, [leftData, viewState.line, viewState.leftLine]);

  // Scroll right pane when target line changes
  useEffect(() => {
    if (rightData && viewState.rightLine) {
      const timer = setTimeout(() => {
        scrollToLine(rightPaneRef, rightIframeRef, rightData.type, viewState.rightLine!);
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [rightData, viewState.rightLine]);

  // Comment-link navigation (App resolved "#/comment/<id>" -> getComment -> redirected here
  // via "#/view?path=<comment.path>" + focusCommentId): once the target comment's pane and
  // comments list have both loaded, scroll to its anchor and flash-highlight its sticky-note
  // card. Static/markdown reuses the existing line-scroll mechanism (or, for a DOM-anchored
  // comment being viewed in a static pane, DirectDomResolver's selector lookup); a live pane
  // instead asks its agent to scroll via the "scrollTo" postMessage.
  useEffect(() => {
    if (!focusCommentId) return;

    const leftHit = leftComments.find((c) => c.id === focusCommentId);
    const rightHit = !leftHit ? rightComments.find((c) => c.id === focusCommentId) : undefined;
    const pane: 'left' | 'right' | null = leftHit ? 'left' : rightHit ? 'right' : null;
    if (!pane) return; // Comments haven't loaded for either pane yet; effect re-runs when they do.

    const comment = (leftHit ?? rightHit)!;
    const data = pane === 'left' ? leftData : rightData;
    if (!data) return; // Pane content not loaded yet; effect re-runs once it is.

    const mode = pane === 'left' ? leftViewMode : rightViewMode;
    if (data.type === 'html' && mode === 'live' && comment.anchor.type === 'dom') {
      const selector = comment.anchor.selector;
      if (!selector) return;
      const nonce = pane === 'left' ? leftNonce : rightNonce;
      const ready = pane === 'left' ? leftAgentReady : rightAgentReady;
      const iframe = pane === 'left' ? leftIframeRef.current : rightIframeRef.current;
      if (!iframe?.contentWindow || !nonce || !ready) return; // Waits for the agent; effect re-runs on ready.
      // Force a fresh anchor resolution right before scrolling: the pane may have been
      // sitting on a different SPA screen since its last resolve, and while the agent's
      // own MutationObserver should already keep liveRects current, re-requesting here
      // is a cheap defensive measure so a followed sticky-note link never scrolls to (or
      // flashes) a stale/incorrect position.
      sendAnchorsToAgent(pane);
      iframe.contentWindow.postMessage({ mdmiel: true, nonce, type: 'scrollTo', selector }, '*');
      setFlashCommentId(focusCommentId);
      onFocusHandled?.();
      return;
    }

    const { line } = resolvePlacements([comment], data.content)[0];
    const paneRef = pane === 'left' ? leftPaneRef : rightPaneRef;
    const targetIframeRef = pane === 'left' ? leftIframeRef : rightIframeRef;
    const selectorOverride = comment.anchor.type === 'dom' ? comment.anchor.selector : undefined;
    const scrollTimer = window.setTimeout(() => {
      scrollToLine(paneRef, targetIframeRef, data.type, line, selectorOverride);
    }, 150);
    setFlashCommentId(focusCommentId);
    onFocusHandled?.();
    return () => window.clearTimeout(scrollTimer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    focusCommentId,
    leftComments,
    rightComments,
    leftData,
    rightData,
    leftViewMode,
    rightViewMode,
    leftAgentReady,
    rightAgentReady,
    leftNonce,
    rightNonce,
  ]);

  // Auto-dismisses the flash-highlight exactly 3s after it was last set, independent of the
  // focus-navigation effect above: that effect has several volatile dependencies (comments
  // lists, agent-ready flags, ...) that can legitimately re-run within the 3s window for
  // reasons unrelated to the flash itself, and tying the clear-timer to *that* effect's
  // cleanup would cancel it on every such re-run, leaving the flash stuck on indefinitely.
  useEffect(() => {
    if (!flashCommentId) return;
    const timer = window.setTimeout(() => {
      setFlashCommentId((cur) => (cur === flashCommentId ? null : cur));
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [flashCommentId]);

  const handleMarkdownContextMenu = (e: React.MouseEvent<HTMLDivElement>, pane: 'left' | 'right') => {
    const target = e.target as HTMLElement;
    const el = target.closest('[data-source-line]');
    if (!el) {
      // No anchorable element under the cursor: let the native context menu show.
      return;
    }
    const line = parseInt(el.getAttribute('data-source-line') || '', 10);
    if (isNaN(line)) {
      return;
    }

    e.preventDefault();

    const rect = el.getBoundingClientRect();
    const container = splitViewRef.current;
    if (container) {
      const containerRect = container.getBoundingClientRect();
      setMenuState({
        pane,
        line,
        top: rect.top - containerRect.top + container.scrollTop,
        left: rect.left - containerRect.left - 60,
      });
    }
  };

  const handleIframeLoad = (pane: 'left' | 'right', iframeRef: React.RefObject<HTMLIFrameElement>) => {
    const iframe = iframeRef.current;
    if (!iframe || !iframe.contentDocument) return;

    const doc = iframe.contentDocument;

    // Remove any previously-registered handler for this pane before adding a
    // new one, keeping add/remove symmetric even across repeated load events.
    const prev = iframeContextMenuRef.current[pane];
    if (prev) {
      prev.doc.removeEventListener('contextmenu', prev.handler);
    }

    const onIframeContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const el = target.closest('[data-source-line]');
      if (!el) {
        // No anchorable element under the cursor: let the native context menu show.
        return;
      }
      const line = parseInt(el.getAttribute('data-source-line') || '', 10);
      if (isNaN(line)) {
        return;
      }

      e.preventDefault();

      const rect = el.getBoundingClientRect();
      const iframeRect = iframe.getBoundingClientRect();
      const container = splitViewRef.current;
      if (container) {
        const containerRect = container.getBoundingClientRect();
        setMenuState({
          pane,
          line,
          top: iframeRect.top - containerRect.top + rect.top + container.scrollTop,
          left: iframeRect.left - containerRect.left + rect.left - 60,
        });
      }
    };

    doc.addEventListener('contextmenu', onIframeContextMenu);
    iframeContextMenuRef.current[pane] = { doc, handler: onIframeContextMenu };
  };

  const handleCopyLink = () => {
    if (!menuState) return;

    const currentHashState: ViewState = {};

    if (rightData) {
      // Split mode
      currentHashState.left = leftData?.path;
      currentHashState.right = rightData.path;
      if (menuState.pane === 'left') {
        currentHashState.leftLine = menuState.line;
        currentHashState.rightLine = viewState.rightLine;
      } else {
        currentHashState.leftLine = viewState.leftLine;
        currentHashState.rightLine = menuState.line;
      }
    } else {
      // Single mode
      currentHashState.path = leftData?.path;
      currentHashState.line = menuState.line;
    }

    const hash = generateHash(currentHashState);
    const url = `${window.location.origin}${window.location.pathname}${hash}`;

    // Update location hash as well for current context
    window.location.hash = hash;

    navigator.clipboard.writeText(url)
      .then(() => {
        showToast(`行リンクをコピーしました ( 行: ${menuState.line} )`);
      })
      .catch((err) => {
        console.error('Failed to copy', err);
      });
  };

  // Returns the raw source-file text for a given pane/line (1-based), used as
  // the material for computeSnippet() when creating a comment.
  //
  // IMPORTANT: this must read the *raw source line* (content split on '\n'),
  // not the rendered DOM textContent. rematchLine() re-derives the snippet
  // hash from raw source lines, so the creation-time snippet has to come from
  // the same source. Both markdown (markdown-it token.map) and html (parse5
  // sourceCodeLocation.startLine) map data-source-line directly onto 1-based
  // raw source line numbers, so line N corresponds to content lines[N - 1].
  const getLineText = (pane: 'left' | 'right', line: number): string => {
    const data = pane === 'left' ? leftData : rightData;
    if (!data) return '';
    const lines = data.content.split('\n');
    return lines[line - 1] ?? '';
  };

  const handleOpenCommentForm = () => {
    if (!menuState) return;
    const path = menuState.pane === 'left' ? leftData?.path : rightData?.path;
    if (!path) return;

    setCommentDraft({
      pane: menuState.pane,
      path,
      line: menuState.line,
      top: menuState.top,
      left: menuState.left,
      body: '',
      submitting: false,
      error: null,
    });
  };

  // Dismiss the pinned context menu on any click outside of it, on Escape, or
  // when a pane scrolls (the menu is pinned to a line's coordinates at the
  // time it opened, so it would otherwise be left behind as the target line
  // scrolls away). Capture-phase is required for scroll because scroll events
  // on the inner .pane-content container don't bubble.
  useEffect(() => {
    if (!menuState) return;

    const handleDocClick = () => setMenuState(null);
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuState(null);
    };
    const handleScroll = () => setMenuState(null);

    document.addEventListener('click', handleDocClick);
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('scroll', handleScroll, true);
    return () => {
      document.removeEventListener('click', handleDocClick);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('scroll', handleScroll, true);
    };
  }, [menuState]);

  const handleCancelComment = () => {
    setCommentDraft(null);
  };

  const handleCommentBodyChange = (value: string) => {
    setCommentDraft((prev) => (prev ? { ...prev, body: value } : prev));
  };

  const handleSubmitComment = async () => {
    if (!commentDraft || !commentDraft.body.trim() || commentDraft.submitting) return;

    setCommentDraft((prev) => (prev ? { ...prev, submitting: true, error: null } : prev));

    try {
      let anchor: CommentAnchor;
      if (commentDraft.domAnchor) {
        anchor = {
          line: 0,
          snippet: commentDraft.domAnchor.snippet,
          snippetHash: commentDraft.domAnchor.snippetHash,
          type: 'dom',
          selector: commentDraft.domAnchor.selector,
        };
      } else {
        const snippet = computeSnippet(getLineText(commentDraft.pane, commentDraft.line));
        anchor = { line: commentDraft.line, snippet, snippetHash: snippetHash(snippet) };
      }

      await createComment({
        path: commentDraft.path,
        anchor,
        body: commentDraft.body,
      });

      setCommentDraft(null);
      showToast(
        commentDraft.domAnchor ? 'コメントを追加しました ( DOM要素 )' : `コメントを追加しました ( 行: ${commentDraft.line} )`
      );
      onCommentAdded?.();
    } catch (err) {
      setCommentDraft((prev) =>
        prev ? { ...prev, submitting: false, error: (err as Error).message } : prev
      );
    }
  };

  if (!leftPath) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-muted)' }}>
        サイドバーからファイルを選択してください。
      </div>
    );
  }

  // 行リンクはmd側のみ維持し、html側は付箋リンク ( /#/comment/<id> ) に一本化する
  // ( working/idea-live-prototype-review.md の決定事項 )。行コメントの追加自体はhtml静的
  // ペインでも引き続き可能なので、gutter-comment-btnはpane種別を問わず表示する。
  const menuPaneType = menuState ? (menuState.pane === 'left' ? leftData?.type : rightData?.type) : undefined;

  return (
    <div className="split-view-container" ref={splitViewRef}>
      {/* Toast */}
      {toastMessage && <div className="toast">{toastMessage}</div>}

      {/* Floating Gutter Actions (link copy + add comment), pinned via right-click */}
      {menuState && (
        <div
          className="gutter-actions"
          style={{ top: `${menuState.top}px`, left: `${Math.max(menuState.left, 0)}px` }}
        >
          {menuPaneType === 'markdown' && (
            <button
              className="gutter-link-btn"
              onClick={handleCopyLink}
              title={`行リンクをコピー ( 行: ${menuState.line} )`}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
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
          )}
          <button
            className="gutter-comment-btn"
            onClick={handleOpenCommentForm}
            title={`コメントを追加 ( 行: ${menuState.line} )`}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
            </svg>
          </button>
        </div>
      )}

      {/* Comment composer popover */}
      {commentDraft && (
        <div
          className="comment-popover"
          style={{ top: `${commentDraft.top}px`, left: `${Math.max(commentDraft.left, 0)}px` }}
        >
          <div className="comment-popover-header">
            <span>{commentDraft.domAnchor ? 'コメントを追加 ( DOM要素 )' : `コメントを追加 ( 行: ${commentDraft.line} )`}</span>
            <button className="comment-popover-close" onClick={handleCancelComment} title="閉じる">
              ✕
            </button>
          </div>
          <textarea
            className="comment-popover-textarea"
            value={commentDraft.body}
            autoFocus
            placeholder="コメントを入力..."
            onChange={(e) => handleCommentBodyChange(e.target.value)}
            disabled={commentDraft.submitting}
          />
          {commentDraft.error && <div className="comment-popover-error">エラー: {commentDraft.error}</div>}
          <div className="comment-popover-actions">
            <button className="btn-secondary" onClick={handleCancelComment} disabled={commentDraft.submitting}>
              キャンセル
            </button>
            <button
              className="btn-primary"
              onClick={handleSubmitComment}
              disabled={commentDraft.submitting || !commentDraft.body.trim()}
            >
              {commentDraft.submitting ? '送信中...' : '送信'}
            </button>
          </div>
        </div>
      )}

      {/* Left Pane */}
      <div className="pane" ref={leftPaneRef}>
        <div className="pane-header">
          <div className="pane-title">
            <span>{leftData?.type === 'markdown' ? '📝' : '🌐'}</span>
            <span>{leftPath}</span>
          </div>
          <div className="pane-actions">
            {leftData?.type === 'html' && (
              <ViewModeSwitcher mode={leftViewMode} onChange={(mode) => handleSetViewMode('left', mode)} />
            )}
            {leftData?.type === 'html' && leftViewMode === 'live' && (
              <button
                className={`pane-add-comment-btn ${leftArmed ? 'active' : ''}`}
                onClick={() => handleToggleArmed('left')}
                title={leftArmed ? 'クリックでキャンセル' : '次の1クリックで付箋を配置'}
              >
                {leftArmed ? 'クリックして配置...' : 'コメント追加'}
              </button>
            )}
            {rightPath && (
              <button className="close-btn" onClick={() => onClosePane('left')} title="左ペインを閉じる">
                ✕
              </button>
            )}
          </div>
        </div>
        <div
          ref={leftContentRef}
          className={`pane-content ${leftData?.type === 'html' ? 'pane-content-iframe' : ''}`}
          onContextMenu={leftData?.type === 'markdown' ? (e) => handleMarkdownContextMenu(e, 'left') : undefined}
        >
          {leftError && <div style={{ padding: '16px', color: 'var(--color-danger)' }}>エラー: {leftError}</div>}
          {!leftError && leftData?.type === 'markdown' && (
            <div className="markdown-body" dangerouslySetInnerHTML={{ __html: leftData.renderedHtml }} />
          )}
          {!leftError && leftData?.type === 'html' && leftViewMode === 'static' && (
            <iframe
              key={`static-${leftData.path}`}
              ref={leftIframeRef}
              className="preview-iframe"
              sandbox="allow-same-origin"
              srcDoc={leftData.renderedHtml}
              onLoad={() => handleIframeLoad('left', leftIframeRef)}
            />
          )}
          {!leftError && leftData?.type === 'html' && leftViewMode === 'live' && leftNonce && (
            <iframe
              key={`live-${leftData.path}-${leftNonce}`}
              ref={leftIframeRef}
              className="preview-iframe"
              sandbox="allow-scripts"
              srcDoc={renderHtmlLive(leftData.content, leftData.path, leftNonce)}
            />
          )}
          {!leftError && leftData && (
            <StickyNoteLayer
              type={leftData.type}
              content={leftData.content}
              comments={leftComments}
              containerRef={leftContentRef}
              iframeRef={leftIframeRef}
              viewMode={leftData.type === 'html' ? leftViewMode : 'static'}
              liveRects={leftLiveRects}
              onCopyLink={showToast}
              flashCommentId={flashCommentId}
              onChanged={() => onCommentsChanged?.()}
            />
          )}
        </div>
      </div>

      {/* Right Pane */}
      {rightPath && (
        <div className="pane" ref={rightPaneRef}>
          <div className="pane-header">
            <div className="pane-title">
              <span>{rightData?.type === 'markdown' ? '📝' : '🌐'}</span>
              <span>{rightPath}</span>
            </div>
            <div className="pane-actions">
              {rightData?.type === 'html' && (
                <ViewModeSwitcher mode={rightViewMode} onChange={(mode) => handleSetViewMode('right', mode)} />
              )}
              {rightData?.type === 'html' && rightViewMode === 'live' && (
                <button
                  className={`pane-add-comment-btn ${rightArmed ? 'active' : ''}`}
                  onClick={() => handleToggleArmed('right')}
                  title={rightArmed ? 'クリックでキャンセル' : '次の1クリックで付箋を配置'}
                >
                  {rightArmed ? 'クリックして配置...' : 'コメント追加'}
                </button>
              )}
              <button className="close-btn" onClick={() => onClosePane('right')} title="右ペインを閉じる">
                ✕
              </button>
            </div>
          </div>
          <div
            ref={rightContentRef}
            className={`pane-content ${rightData?.type === 'html' ? 'pane-content-iframe' : ''}`}
            onContextMenu={rightData?.type === 'markdown' ? (e) => handleMarkdownContextMenu(e, 'right') : undefined}
          >
            {rightError && <div style={{ padding: '16px', color: 'var(--color-danger)' }}>エラー: {rightError}</div>}
            {!rightError && rightData?.type === 'markdown' && (
              <div className="markdown-body" dangerouslySetInnerHTML={{ __html: rightData.renderedHtml }} />
            )}
            {!rightError && rightData?.type === 'html' && rightViewMode === 'static' && (
              <iframe
                key={`static-${rightData.path}`}
                ref={rightIframeRef}
                className="preview-iframe"
                sandbox="allow-same-origin"
                srcDoc={rightData.renderedHtml}
                onLoad={() => handleIframeLoad('right', rightIframeRef)}
              />
            )}
            {!rightError && rightData?.type === 'html' && rightViewMode === 'live' && rightNonce && (
              <iframe
                key={`live-${rightData.path}-${rightNonce}`}
                ref={rightIframeRef}
                className="preview-iframe"
                sandbox="allow-scripts"
                srcDoc={renderHtmlLive(rightData.content, rightData.path, rightNonce)}
              />
            )}
            {!rightError && rightData && (
              <StickyNoteLayer
                type={rightData.type}
                content={rightData.content}
                comments={rightComments}
                containerRef={rightContentRef}
                iframeRef={rightIframeRef}
                viewMode={rightData.type === 'html' ? rightViewMode : 'static'}
                liveRects={rightLiveRects}
                onCopyLink={showToast}
                flashCommentId={flashCommentId}
                onChanged={() => onCommentsChanged?.()}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
