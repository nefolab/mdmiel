import { useState, useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { SplitView, PaneContentInfo } from './components/SplitView';
import { CommentSidebar, CommentSidebarPaneInfo } from './components/CommentSidebar';
import { parseHash, generateHash, ViewState } from './lib/anchor';
import { Comment } from './lib/comments';
import { listComments } from './lib/commentsApi';
import { Theme, getInitialTheme, applyTheme } from './lib/theme';

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

  const leftPath = viewState.path || viewState.left;
  const rightPath = viewState.right;

  useEffect(() => {
    const handleHashChange = () => {
      setViewState(parseHash(window.location.hash));
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
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
