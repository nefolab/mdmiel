import { useState, useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { SplitView, PaneContentInfo } from './components/SplitView';
import { CommentSidebar, CommentSidebarPaneInfo } from './components/CommentSidebar';
import { parseHash, generateHash, parseCommentRoute, ViewState } from './lib/anchor';
import { Comment } from './lib/comments';
import { listComments, getComment } from './lib/commentsApi';
import { Theme, getInitialTheme, applyTheme } from './lib/theme';
import { setViewMode } from './lib/viewMode';

export default function App() {
  const [viewState, setViewState] = useState<ViewState>(() => parseHash(window.location.hash));
  const [theme, setTheme] = useState<Theme>(() => getInitialTheme());
  const [commentsPanelOpen, setCommentsPanelOpen] = useState(false);
  const [commentsRefreshKey, setCommentsRefreshKey] = useState(0);
  const [paneContents, setPaneContents] = useState<{
    left?: PaneContentInfo;
    right?: PaneContentInfo;
  }>({});
  const [commentsByPane, setCommentsByPane] = useState<{ left: Comment[]; right: Comment[] }>({
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
  // for SplitView's scroll+flash. Unknown ids are logged and otherwise left on the "select a
  // file" fallback screen (no toast mechanism exists at this level).
  useEffect(() => {
    const processHash = () => {
      const hash = window.location.hash;
      const route = parseCommentRoute(hash);
      if (route) {
        getComment(route.id)
          .then((comment) => {
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
          });
        return;
      }
      setViewState(parseHash(hash));
    };
    processHash();
    window.addEventListener('hashchange', processHash);
    return () => window.removeEventListener('hashchange', processHash);
  }, []);

  // 起動時・切替時にdata-theme属性とlocalStorageへ反映する。
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Fetch comments per pane whenever the shown files or a refresh signal change.
  // Lifted here so both the overlay sticky notes and the sidebar share one source.
  useEffect(() => {
    let cancelled = false;
    const load = (pane: 'left' | 'right', path?: string) => {
      if (!path) {
        setCommentsByPane((prev) => (prev[pane].length ? { ...prev, [pane]: [] } : prev));
        return;
      }
      listComments(path)
        .then((comments) => {
          if (!cancelled) setCommentsByPane((prev) => ({ ...prev, [pane]: comments }));
        })
        .catch((err) => {
          if (!cancelled) console.error('コメント取得に失敗しました', err);
        });
    };
    load('left', leftPath);
    load('right', rightPath);
    return () => {
      cancelled = true;
    };
  }, [leftPath, rightPath, commentsRefreshKey]);

  const reloadComments = () => setCommentsRefreshKey((k) => k + 1);

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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <header className="app-header">
        <div className="logo-container">
          <span className="logo-icon">📝</span>
          <span className="logo-title">mdmiel</span>
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
            💬 コメント
          </button>
        </div>
      </header>
      <div className="app-container">
        <Sidebar
          activeLeft={viewState.path || viewState.left}
          activeRight={viewState.right}
          onSelectFile={handleSelectFile}
        />
        <SplitView
          viewState={viewState}
          onClosePane={handleClosePane}
          onPaneContentChange={handlePaneContentChange}
          onCommentAdded={handleCommentAdded}
          leftComments={commentsByPane.left}
          rightComments={commentsByPane.right}
          onCommentsChanged={reloadComments}
          focusCommentId={focusCommentId ?? undefined}
          onFocusHandled={() => setFocusCommentId(null)}
        />
        {commentsPanelOpen && leftPath && (
          <CommentSidebar
            panes={commentPanes}
            commentsByPane={commentsByPane}
            onJumpToLine={handleJumpToLine}
            onChanged={reloadComments}
          />
        )}
      </div>
    </div>
  );
}
