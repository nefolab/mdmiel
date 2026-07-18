import { Comment, CommentAnchor } from './comments';

export interface CreateCommentPayload {
  path: string;
  anchor: CommentAnchor;
  body: string;
  links?: string[];
}

export interface PatchCommentPayload {
  body?: string;
  resolved?: boolean;
  noteOffset?: { dx: number; dy: number };
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (text) return text;
  } catch {
    // ignore body read failures, fall back to status
  }
  return `HTTP ${res.status}`;
}

async function parseJsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  return res.json() as Promise<T>;
}

/** GET /api/comments?path=<rel> */
export async function listComments(path: string): Promise<Comment[]> {
  const res = await fetch(`/api/comments?path=${encodeURIComponent(path)}`);
  const data = await parseJsonOrThrow<{ comments: Comment[] }>(res);
  return data.comments;
}

/** GET /api/comments/{id} */
export async function getComment(id: string): Promise<Comment> {
  const res = await fetch(`/api/comments/${encodeURIComponent(id)}`);
  return parseJsonOrThrow<Comment>(res);
}

/** POST /api/comments */
export async function createComment(payload: CreateCommentPayload): Promise<Comment> {
  const res = await fetch('/api/comments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return parseJsonOrThrow<Comment>(res);
}

/** PATCH /api/comments/{id} */
export async function patchComment(id: string, patch: PatchCommentPayload): Promise<Comment> {
  const res = await fetch(`/api/comments/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return parseJsonOrThrow<Comment>(res);
}

/** DELETE /api/comments/{id} (204 No Content on success) */
export async function deleteComment(id: string): Promise<void> {
  const res = await fetch(`/api/comments/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
}
