import React, { useState, useEffect } from 'react';

interface FileItem {
  path: string;
  type: 'markdown' | 'html';
}

interface TreeNode {
  name: string;
  path: string;
  type?: 'markdown' | 'html';
  children: { [key: string]: TreeNode };
  isDir: boolean;
}

export interface SidebarProps {
  revision: number;
  activeLeft?: string;
  activeRight?: string;
  onSelectFile: (path: string, pane: 'left' | 'right') => void;
}

function buildTree(files: FileItem[]): TreeNode {
  const root: TreeNode = { name: 'root', path: '', children: {}, isDir: true };

  files.forEach((file) => {
    const parts = file.path.split('/');
    let current = root;
    let currentPath = '';

    parts.forEach((part, index) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isLast = index === parts.length - 1;

      if (!current.children[part]) {
        current.children[part] = {
          name: part,
          path: currentPath,
          children: {},
          isDir: !isLast,
          type: isLast ? file.type : undefined,
        };
      }
      current = current.children[part];
    });
  });

  return root;
}

export function Sidebar({ activeLeft, activeRight, onSelectFile, revision }: SidebarProps) {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<{ [path: string]: boolean }>({});

  useEffect(() => {
    let cancelled = false;
    fetch('/api/files')
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load files');
        return res.json();
      })
      .then((data) => {
        if (!cancelled) {
          setFiles(data.files || []);
          setError(null);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [revision]);

  const toggleCollapse = (path: string) => {
    setCollapsed((prev) => ({ ...prev, [path]: !prev[path] }));
  };

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    if (node.path === '') {
      return Object.values(node.children)
        .sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
        .map((child) => renderNode(child, 0));
    }

    const isCollapsed = collapsed[node.path];
    const isSelectedLeft = activeLeft === node.path;
    const isSelectedRight = activeRight === node.path;
    const isActive = isSelectedLeft || isSelectedRight;

    const handleClick = (e: React.MouseEvent) => {
      if (node.isDir) {
        toggleCollapse(node.path);
      } else {
        const pane = e.shiftKey ? 'right' : 'left';
        onSelectFile(node.path, pane);
      }
    };

    const handleOpenRight = (e: React.MouseEvent) => {
      e.stopPropagation();
      onSelectFile(node.path, 'right');
    };

    return (
      <div key={node.path} style={{ paddingLeft: `${depth > 0 ? 8 : 0}px` }}>
        <div
          className={`file-item ${isActive ? 'active' : ''}`}
          onClick={handleClick}
        >
          <div className="file-info">
            <span className="file-icon">
              {node.isDir ? (isCollapsed ? '📁' : '📂') : (node.type === 'markdown' ? '📝' : '🌐')}
            </span>
            <span className="file-name" title={node.name}>
              {node.name}
            </span>
          </div>
          {!node.isDir && (
            <div className="file-actions">
              <button
                className="btn-open-right"
                onClick={handleOpenRight}
                title="右ペインで開く ( Shift+クリック )"
              >
                右で開く
              </button>
            </div>
          )}
        </div>
        {node.isDir && !isCollapsed && (
          <div style={{ borderLeft: '1px solid var(--color-border)', marginLeft: '8px' }}>
            {Object.values(node.children)
              .sort((a, b) => {
                if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
                return a.name.localeCompare(b.name);
              })
              .map((child) => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const tree = buildTree(files);

  return (
    <aside className="sidebar">
      <div className="sidebar-title">ファイル一覧</div>
      {loading && <div style={{ padding: '16px', fontSize: '14px', color: 'var(--color-muted)' }}>読み込み中...</div>}
      {error && <div style={{ padding: '16px', fontSize: '14px', color: 'var(--color-danger)' }}>エラー: {error}</div>}
      {!loading && !error && files.length === 0 && (
        <div style={{ padding: '16px', fontSize: '14px', color: 'var(--color-muted)' }}>ファイルがありません</div>
      )}
      {!loading && !error && <div className="file-list">{renderNode(tree, 0)}</div>}
    </aside>
  );
}
