import { useState } from 'react';
import { patchComment, deleteComment } from './commentsApi';

/**
 * Shared comment mutation helpers used by both the sticky-note cards and the
 * (demoted) sidebar list. Each action calls the API, then invokes `onChanged`
 * so the parent can re-fetch and keep every view in sync.
 */
export function useCommentActions(onChanged: () => void) {
  const [busyId, setBusyId] = useState<string | null>(null);

  const run = async (id: string, fn: () => Promise<unknown>, errPrefix: string) => {
    setBusyId(id);
    try {
      await fn();
      onChanged();
    } catch (err) {
      window.alert(`${errPrefix}: ${(err as Error).message}`);
    } finally {
      setBusyId(null);
    }
  };

  return {
    busyId,
    saveBody: (id: string, body: string) =>
      run(id, () => patchComment(id, { body }), '更新に失敗しました'),
    toggleResolved: (comment: { id: string; resolved: boolean }) =>
      run(comment.id, () => patchComment(comment.id, { resolved: !comment.resolved }), '更新に失敗しました'),
    saveOffset: (id: string, dx: number, dy: number) =>
      run(id, () => patchComment(id, { noteOffset: { dx, dy } }), '更新に失敗しました'),
    remove: (id: string) => run(id, () => deleteComment(id), '削除に失敗しました'),
  };
}
