import { useState } from 'react';
import { Comment } from '../lib/comments';
import { resolvePlacements } from '../lib/stickyLayout';
import { useCommentActions } from '../lib/useCommentActions';

export interface CommentSidebarPaneInfo {
  pane: 'left' | 'right';
  path: string;
  content: string;
}

export interface CommentSidebarProps {
  panes: CommentSidebarPaneInfo[];
  commentsByPane: { left: Comment[]; right: Comment[] };
  onJumpToLine: (pane: 'left' | 'right', line: number) => void;
  onChanged: () => void;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

/**
 * Auxiliary comment list. The overlay sticky notes are the primary view; this
 * panel is a toggleable list that reuses the same lifted comment data and the
 * shared mutation hook.
 */
export function CommentSidebar({ panes, commentsByPane, onJumpToLine, onChanged }: CommentSidebarProps) {
  const actions = useCommentActions(onChanged);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState('');

  const startEdit = (comment: Comment) => {
    setEditingId(comment.id);
    setEditBody(comment.body);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditBody('');
  };

  const saveEdit = async (comment: Comment) => {
    if (!editBody.trim()) return;
    await actions.saveBody(comment.id, editBody);
    setEditingId(null);
    setEditBody('');
  };

  if (panes.length === 0) {
    return (
      <aside className="comment-sidebar">
        <div className="comment-sidebar-title">コメント一覧</div>
        <div className="comment-sidebar-empty">ファイルを選択してください。</div>
      </aside>
    );
  }

  return (
    <aside className="comment-sidebar">
      <div className="comment-sidebar-title">コメント一覧</div>
      <div className="comment-sidebar-body">
        {panes.map((p) => {
          const comments = commentsByPane[p.pane] || [];
          const resolved = resolvePlacements(comments, p.content).sort((a, b) => a.line - b.line);

          return (
            <div key={p.pane} className="comment-pane-group">
              {panes.length > 1 && (
                <div className="comment-pane-group-title">
                  {p.pane === 'left' ? '左' : '右'}: {p.path}
                </div>
              )}
              {resolved.length === 0 && (
                <div className="comment-sidebar-empty">コメントはありません。</div>
              )}
              {resolved.map(({ comment, line, orphaned }) => {
                const isEditing = editingId === comment.id;
                const isBusy = actions.busyId === comment.id;

                return (
                  <div
                    key={comment.id}
                    className={`comment-item ${comment.resolved ? 'comment-item-resolved' : ''}`}
                    onClick={() => {
                      if (!isEditing && !orphaned) onJumpToLine(p.pane, line);
                    }}
                  >
                    <div className="comment-item-meta">
                      <span className="comment-item-line">行 {line}</span>
                      {orphaned && <span className="badge badge-orphaned">行が見つかりません</span>}
                      {comment.resolved && <span className="badge badge-resolved">解決済み</span>}
                    </div>

                    {isEditing ? (
                      <div className="comment-edit-form" onClick={(e) => e.stopPropagation()}>
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
                          <button
                            className="btn-primary"
                            onClick={() => saveEdit(comment)}
                            disabled={isBusy || !editBody.trim()}
                          >
                            保存
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="comment-item-body">{comment.body}</div>
                    )}

                    <div className="comment-item-footer">
                      <span className="comment-item-author">{comment.author}</span>
                      <span className="comment-item-date">{formatDate(comment.createdAt)}</span>
                    </div>

                    {!isEditing && (
                      <div className="comment-item-actions" onClick={(e) => e.stopPropagation()}>
                        <button className="btn-link" onClick={() => startEdit(comment)} disabled={isBusy}>
                          編集
                        </button>
                        <button
                          className="btn-link"
                          onClick={() => actions.toggleResolved(comment)}
                          disabled={isBusy}
                        >
                          {comment.resolved ? '未解決に戻す' : '解決済みにする'}
                        </button>
                        <button
                          className="btn-link btn-link-danger"
                          onClick={() => {
                            if (window.confirm('このコメントを削除しますか?')) {
                              actions.remove(comment.id);
                            }
                          }}
                          disabled={isBusy}
                        >
                          削除
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
