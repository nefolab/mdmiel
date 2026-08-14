import { useState, useEffect, type ChangeEvent } from 'react';
import { Sidebar } from './components/Sidebar';
import { SplitView, PaneContentInfo } from './components/SplitView';
import { CommentSidebar, CommentSidebarPaneInfo } from './components/CommentSidebar';
import { parseHash, generateHash, parseCommentRoute, ViewState } from './lib/anchor';
import { Comment } from './lib/comments';
import { collectUnresolvedComments, UnresolvedIdsByPane } from './lib/stickyLayout';
import { listComments, getComment } from './lib/commentsApi';
import { Theme, getInitialTheme, applyTheme } from './lib/theme';
import { setViewMode } from './lib/viewMode';
import { useLiveReload } from './lib/liveReload';
import { getSidebarOpen, setSidebarOpen as persistSidebarOpen } from './lib/sidebarState';

export default function App() {
  const revision = useLiveReload();
  const [viewState, setViewState] = useState<ViewState>(() => parseHash(window.location.hash));
  const [navNonce, setNavNonce] = useState(0);
  const [theme, setTheme] = useState<Theme>(() => getInitialTheme());
  const [commentsPanelOpen, setCommentsPanelOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => getSidebarOpen());
  const [query, setQuery] = useState('');
  const [commentsRefreshKey, setCommentsRefreshKey] = useState(0);
  const [paneContents, setPaneContents] = useState<{
    left?: PaneContentInfo;
    right?: PaneContentInfo;
  }>({});
  const [commentsByPane, setCommentsByPane] = useState<{ left: Comment[]; right: Comment[] }>({
    left: [],
    right: [],
  });
  // Comment loading is the one fetch with no visible surface of its own: a failed load
  // just yields no sticky notes, which is indistinguishable from a file that has none.
  // This message makes that difference visible; it is cleared by the next successful load.
  const [commentsError, setCommentsError] = useState<string | null>(null);
  // Per-pane unresolved (orphaned + missing) comment ids, reported by each pane's
  // StickyNoteLayer via SplitView's onUnresolvedChange. Stale ids left behind by a pane
  // that closed or switched files are harmless: collectUnresolvedComments filters ids
  // against commentsByPane, so they simply resolve to nothing once that pane's comment
  // list has moved on.
  const [unresolvedIdsByPane, setUnresolvedIdsByPane] = useState<UnresolvedIdsByPane>({
    left: [],
    right: [],
  });
  // Set when the current URL was a "/#/comment/<id>" link, once getComment(id) has resolved
  // and the hash has been redirected to "#/view?path=<comment.path>". Consumed by SplitView
  // to scroll to + flash-highlight the target comment's sticky-note card once its pane loads;
  // SplitView clears it back via onFocusHandled.
  const [focusCommentId, setFocusCommentId] = useState<string | null>(null);

  const leftPath = viewState.path || viewState.left;
  const rightPath = viewState.right;

  // Handles both the regular "#/view?..." route and the "#/comment/<id>" sticky-note-link
  // route. The latter isn't a real view state by itself: it resolves the comment via the API,
  // then rewrites the hash to "#/view?path=<comment.path>" (which re-enters this same handler
  // and falls through to the normal parseHash path) while remembering the target comment id
  // for SplitView's scroll+flash. Unknown ids stay on the "select a file" fallback screen
  // and report themselves through the error banner (SplitView's toast is out of reach here).
  useEffect(() => {
    let cancelled = false;
    const processHash = () => {
      const hash = window.location.hash;
      const route = parseCommentRoute(hash);
      if (route) {
        getComment(route.id)
          .then((comment) => {
            if (cancelled) return; // Unmounted while the fetch was in flight; drop the result.
            // A DOM-anchored comment only resolves in a 'live' pane (BridgeResolver):
            // the static pane never executes the prototype's JS, so the element the
            // comment refers to typically doesn't even exist in the raw HTML. Force
            // the target file's persisted view mode to 'live' before opening it, so
            // the link works even with an empty localStorage (e.g. private browsing)
            // instead of silently landing on the default 'static' mode.
            if (comment.anchor.type === 'dom') {
              setViewMode(comment.path, 'live');
            }
            setFocusCommentId(comment.id);
            window.location.hash = generateHash({ path: comment.path });
          })
          .catch((err) => {
            console.error('コメントの取得に失敗しました:', err);
            if (!cancelled) {
              setCommentsError(
                'コメントへのリンクを開けませんでした。削除済みか、URLが正しくない可能性があります。'
              );
            }
          });
        return;
      }
      setViewState(parseHash(hash));
      setNavNonce((value) => value + 1);
    };
    processHash();
    window.addEventListener('hashchange', processHash);
    return () => {
      cancelled = true;
      window.removeEventListener('hashchange', processHash);
    };
  }, []);

  // 起動時・切替時にdata-theme属性とlocalStorageへ反映する。
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Fetch comments per pane whenever the shown files or a refresh signal change.
  // Lifted here so both the overlay sticky notes and the sidebar share one source.
  //
  // A failed load empties that pane instead of keeping what was already there: the
  // leftover list belongs to the file shown before the switch, so keeping it would
  // pin another document's sticky notes onto the current one. The banner below
  // reports the failure rather than leaving the empty pane looking comment-free.
  useEffect(() => {
    let cancelled = false;
    const load = async (pane: 'left' | 'right', path?: string): Promise<boolean> => {
      if (!path) {
        setCommentsByPane((prev) => (prev[pane].length ? { ...prev, [pane]: [] } : prev));
        return true;
      }
      try {
        const comments = await listComments(path);
        if (!cancelled) setCommentsByPane((prev) => ({ ...prev, [pane]: comments }));
        return true;
      } catch (err) {
        console.error('コメント取得に失敗しました', err);
        if (!cancelled) setCommentsByPane((prev) => (prev[pane].length ? { ...prev, [pane]: [] } : prev));
        return false;
      }
    };
    void Promise.all([load('left', leftPath), load('right', rightPath)]).then((results) => {
      if (cancelled) return;
      const failed = results.some((ok) => !ok);
      setCommentsError(failed ? 'コメントの取得に失敗しました。付箋は表示できていません。' : null);
    });
    return () => {
      cancelled = true;
    };
  }, [leftPath, rightPath, commentsRefreshKey]);

  const reloadComments = () => setCommentsRefreshKey((k) => k + 1);

  const handleToggleSidebar = () => {
    const nextOpen = !sidebarOpen;
    setSidebarOpen(nextOpen);
    persistSidebarOpen(nextOpen);
  };

  const handleQueryChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextQuery = event.target.value;
    setQuery(nextQuery);
    if (nextQuery.trim() !== '') {
      setSidebarOpen(true);
    }
  };

  const handleSelectFile = (path: string, pane: 'left' | 'right') => {
    let newState: ViewState = {};
    if (pane === 'left') {
      if (viewState.right) {
        newState = {
          left: path,
          right: viewState.right,
          rightLine: viewState.rightLine,
        };
      } else {
        newState = {
          path: path,
        };
      }
    } else {
      // pane === 'right'
      const currentLeft = viewState.path || viewState.left;
      if (currentLeft) {
        newState = {
          left: currentLeft,
          leftLine: viewState.path ? viewState.line : viewState.leftLine,
          right: path,
        };
      } else {
        newState = {
          path: path,
        };
      }
    }
    window.location.hash = generateHash(newState);
  };

  const handlePaneContentChange = (pane: 'left' | 'right', data: PaneContentInfo | null) => {
    setPaneContents((prev) => ({ ...prev, [pane]: data ?? undefined }));
  };

  const handleUnresolvedChange = (pane: 'left' | 'right', commentIds: string[]) => {
    setUnresolvedIdsByPane((prev) => ({ ...prev, [pane]: commentIds }));
  };

  const handleCommentAdded = () => {
    reloadComments();
  };

  const handleJumpToLine = (pane: 'left' | 'right', line: number) => {
    let newState: ViewState;
    if (viewState.path !== undefined) {
      // Single-file mode: only the left pane can exist.
      newState = { path: viewState.path, line };
    } else {
      newState = {
        left: viewState.left,
        right: viewState.right,
        leftLine: pane === 'left' ? line : viewState.leftLine,
        rightLine: pane === 'right' ? line : viewState.rightLine,
      };
    }
    window.location.hash = generateHash(newState);
    // Setting the hash may not fire 'hashchange' if the resulting hash string
    // is identical to the current one (e.g. re-clicking the same comment),
    // so update state directly as well to guarantee the scroll effect runs.
    setViewState(newState);
  };

  const handleClosePane = (pane: 'left' | 'right') => {
    let newState: ViewState = {};
    if (pane === 'left') {
      if (viewState.right) {
        newState = {
          path: viewState.right,
          line: viewState.rightLine,
        };
      }
    } else {
      // pane === 'right'
      const currentLeft = viewState.path || viewState.left;
      if (currentLeft) {
        newState = {
          path: currentLeft,
          line: viewState.path ? viewState.line : viewState.leftLine,
        };
      }
    }
    window.location.hash = generateHash(newState);
  };

  const commentPanes: CommentSidebarPaneInfo[] = [];
  if (leftPath && paneContents.left && paneContents.left.path === leftPath) {
    commentPanes.push({ pane: 'left', path: leftPath, content: paneContents.left.content });
  }
  if (rightPath && paneContents.right && paneContents.right.path === rightPath) {
    commentPanes.push({ pane: 'right', path: rightPath, content: paneContents.right.content });
  }

  const totalCommentCount = commentsByPane.left.length + commentsByPane.right.length;
  const unresolvedCount = collectUnresolvedComments(commentsByPane, unresolvedIdsByPane).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <header className="app-header">
        <div className="header-navigation">
          <button
            className="sidebar-toggle-btn"
            onClick={handleToggleSidebar}
            aria-expanded={sidebarOpen}
            aria-controls="file-sidebar"
            aria-label="サイドバーの表示切替"
            title={sidebarOpen ? 'サイドバーを閉じる' : 'サイドバーを開く'}
          >
            <span aria-hidden="true">☰</span>
          </button>
          <input
            className="file-search-input"
            type="search"
            value={query}
            onChange={handleQueryChange}
            placeholder="ファイルを検索"
            aria-label="ファイルを検索"
          />
        </div>
        <div className="header-actions">
          <div className="theme-switcher">
            <span className="theme-switcher-label">theme</span>
            <div className="theme-switcher-track">
              <button
                className={`theme-switcher-btn ${theme === 'paper' ? 'active' : ''}`}
                onClick={() => setTheme('paper')}
                title="paperテーマに切替"
              >
                paper
              </button>
              <button
                className={`theme-switcher-btn ${theme === 'slate' ? 'active' : ''}`}
                onClick={() => setTheme('slate')}
                title="slateテーマに切替"
              >
                slate
              </button>
            </div>
          </div>
          <button
            className={`comments-toggle-btn ${commentsPanelOpen ? 'active' : ''}`}
            onClick={() => setCommentsPanelOpen((v) => !v)}
            title="コメントパネルの表示切替"
          >
            <span className="comments-toggle-label">💬 コメント</span>
            <span className="comments-toggle-count">{totalCommentCount}</span>
            {unresolvedCount > 0 && (
              <span
                className="comments-toggle-unresolved"
                title={`未解決 ( orphaned ) のコメントが${unresolvedCount}件あります`}
              >
                <span className="comments-toggle-unresolved-dot" />
                {unresolvedCount}
              </span>
            )}
          </button>
        </div>
      </header>
      {commentsError && (
        <div className="app-error-banner" role="alert">
          <span aria-hidden="true">⚠</span> {commentsError}
          <button
            className="app-error-banner-dismiss"
            onClick={() => setCommentsError(null)}
            aria-label="エラー表示を閉じる"
          >
            ✕
          </button>
        </div>
      )}
      <div className="app-container">
        <Sidebar
          revision={revision}
          sidebarOpen={sidebarOpen}
          query={query}
          activeLeft={viewState.path || viewState.left}
          activeRight={viewState.right}
          onSelectFile={handleSelectFile}
        />
        <SplitView
          revision={revision}
          viewState={viewState}
          navNonce={navNonce}
          onClosePane={handleClosePane}
          onPaneContentChange={handlePaneContentChange}
          onCommentAdded={handleCommentAdded}
          leftComments={commentsByPane.left}
          rightComments={commentsByPane.right}
          onCommentsChanged={reloadComments}
          focusCommentId={focusCommentId ?? undefined}
          onFocusHandled={() => setFocusCommentId(null)}
          onUnresolvedChange={handleUnresolvedChange}
        />
        {commentsPanelOpen && leftPath && (
          <CommentSidebar
            panes={commentPanes}
            commentsByPane={commentsByPane}
            onJumpToLine={handleJumpToLine}
            onChanged={reloadComments}
            unresolvedIdsByPane={unresolvedIdsByPane}
          />
        )}
      </div>
    </div>
  );
}
