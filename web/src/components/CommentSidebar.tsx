import { useEffect, useRef, useState } from 'react';
import { Comment } from '../lib/comments';
import { resolvePlacements, collectUnresolvedComments, UnresolvedIdsByPane } from '../lib/stickyLayout';
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
  /**
   * Per-pane unresolved (orphaned + missing) comment ids, as reported by each pane's
   * StickyNoteLayer (lifted through SplitView -> App -> here). Renders the 未解決 section
   * at the bottom of the list — see collectUnresolvedComments for how ids are resolved
   * into full Comment objects and how stale ids (e.g. a just-closed pane) are dropped.
   */
  unresolvedIdsByPane: UnresolvedIdsByPane;
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
export function CommentSidebar({
  panes,
  commentsByPane,
  onJumpToLine,
  onChanged,
  unresolvedIdsByPane,
}: CommentSidebarProps) {
  const actions = useCommentActions(onChanged);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState('');
  // "リンクをコピー" confirmation, local to this panel (there's no toast channel reachable
  // from here — SplitView's toast is internal to SplitView, which sits outside this panel).
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copiedTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    };
  }, []);

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

  const copyLink = (commentId: string) => {
    const url = `${window.location.origin}${window.location.pathname}#/comment/${encodeURIComponent(commentId)}`;
    navigator.clipboard
      .writeText(url)
      .then(() => {
        setCopiedId(commentId);
        if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = window.setTimeout(() => {
          copiedTimerRef.current = null;
          setCopiedId((cur) => (cur === commentId ? null : cur));
        }, 2000);
      })
      .catch((err) => console.error('Failed to copy', err));
  };

  // Shared card markup for both the per-pane line list and the 未解決 section below it.
  // `meta` renders the badges/line-number row; `onClick`/`showCopyLink` toggle the two
  // behaviors that differ between the two contexts (jump-to-line vs. not pinnable at all;
  // no link-copy action on the regular list vs. required on 未解決 cards).
  const renderCard = (comment: Comment, meta: React.ReactNode, onClick?: () => void, showCopyLink?: boolean) => {
    const isEditing = editingId === comment.id;
    const isBusy = actions.busyId === comment.id;

    return (
      <div
        key={comment.id}
        className={`comment-item ${comment.resolved ? 'comment-item-resolved' : ''} ${onClick ? '' : 'comment-item-static'}`}
        onClick={() => {
          if (!isEditing && onClick) onClick();
        }}
      >
        <div className="comment-item-meta">{meta}</div>

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
            <button className="btn-link" onClick={() => actions.toggleResolved(comment)} disabled={isBusy}>
              {comment.resolved ? '未解決に戻す' : '解決済みにする'}
            </button>
            {showCopyLink && (
              <button className="btn-link" onClick={() => copyLink(comment.id)}>
                {copiedId === comment.id ? 'コピーしました' : 'リンクをコピー'}
              </button>
            )}
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
  };

  if (panes.length === 0) {
    return (
      <aside className="comment-sidebar">
        <div className="comment-sidebar-title">コメント一覧</div>
        <div className="comment-sidebar-empty">ファイルを選択してください。</div>
      </aside>
    );
  }

  const unresolvedEntries = collectUnresolvedComments(commentsByPane, unresolvedIdsByPane);

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
              {resolved.map(({ comment, line, orphaned }) =>
                renderCard(
                  comment,
                  <>
                    <span className="comment-item-line">行 {line}</span>
                    {orphaned && <span className="badge badge-orphaned">行が見つかりません</span>}
                    {comment.resolved && <span className="badge badge-resolved">解決済み</span>}
                  </>,
                  orphaned ? undefined : () => onJumpToLine(p.pane, line)
                )
              )}
            </div>
          );
        })}

        {unresolvedEntries.length > 0 && (
          <div className="comment-unresolved-section">
            <div className="comment-unresolved-title">
              未解決 ( orphaned )
              <span className="comment-unresolved-count">{unresolvedEntries.length}</span>
            </div>
            <div className="comment-unresolved-desc">
              今の画面に表示されていないコメントです ( 別画面・別モードなど )。
            </div>
            {unresolvedEntries.map(({ pane, comment }) =>
              renderCard(
                comment,
                <>
                  {panes.length > 1 && (
                    <span className="comment-item-pane-tag">{pane === 'left' ? '左' : '右'}</span>
                  )}
                  <span className="badge badge-orphaned">未解決</span>
                  {comment.resolved && <span className="badge badge-resolved">解決済み</span>}
                </>,
                undefined,
                true
              )
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
