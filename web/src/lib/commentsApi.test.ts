import { describe, it, expect, vi, afterEach } from 'vitest';
import { getComment } from './commentsApi';
import { Comment } from './comments';

const sampleComment: Comment = {
  version: 1,
  id: 'abc123',
  path: 'mock.html',
  anchor: { line: 0, snippet: 'Submit', snippetHash: 'deadbeef', type: 'dom', selector: '#submit-btn' },
  body: 'looks good',
  author: 'nefo',
  createdAt: '2026-07-18T00:00:00Z',
  resolved: false,
};

describe('getComment', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GETs /api/comments/{id} and returns the parsed comment on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => sampleComment,
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await getComment('abc123');

    expect(fetchMock).toHaveBeenCalledWith('/api/comments/abc123');
    expect(result).toEqual(sampleComment);
  });

  it('URL-encodes the id in the request path', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => sampleComment });
    vi.stubGlobal('fetch', fetchMock);

    await getComment('id/with slash');

    expect(fetchMock).toHaveBeenCalledWith('/api/comments/id%2Fwith%20slash');
  });

  it('throws with the response body text when the request fails (e.g. 404)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => 'Not Found',
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getComment('missing')).rejects.toThrow('Not Found');
  });

  it('falls back to "HTTP <status>" when the error response has no body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getComment('bad-id')).rejects.toThrow('HTTP 400');
  });
});
