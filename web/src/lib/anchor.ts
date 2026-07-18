export interface ViewState {
  path?: string;
  line?: number;
  left?: string;
  leftLine?: number;
  right?: string;
  rightLine?: number;
}

/**
 * Parses the hash section of the URL into a ViewState object.
 * Safe for Japanese and spaces via URLSearchParams (which handles decoding).
 */
export function parseHash(hash: string): ViewState {
  if (!hash || !hash.startsWith('#/view')) {
    return {};
  }
  const queryIndex = hash.indexOf('?');
  if (queryIndex === -1) {
    return {};
  }
  const queryString = hash.substring(queryIndex + 1);
  const params = new URLSearchParams(queryString);
  const state: ViewState = {};

  const path = params.get('path');
  if (path !== null) {
    state.path = path;
  }

  const line = params.get('line');
  if (line !== null) {
    const n = parseInt(line, 10);
    if (!isNaN(n)) state.line = n;
  }

  const left = params.get('left');
  if (left !== null) {
    state.left = left;
  }

  const leftLine = params.get('leftLine');
  if (leftLine !== null) {
    const n = parseInt(leftLine, 10);
    if (!isNaN(n)) state.leftLine = n;
  }

  const right = params.get('right');
  if (right !== null) {
    state.right = right;
  }

  const rightLine = params.get('rightLine');
  if (rightLine !== null) {
    const n = parseInt(rightLine, 10);
    if (!isNaN(n)) state.rightLine = n;
  }

  return state;
}

/**
 * Generates a URL hash string from a ViewState object.
 * Safe for Japanese and spaces via URLSearchParams.
 * URLSearchParams encodes spaces as "+" (application/x-www-form-urlencoded),
 * so we normalize back to "%20" to keep the classic percent-encoded form.
 */
export function generateHash(state: ViewState): string {
  const params = new URLSearchParams();

  if (state.path) {
    params.set('path', state.path);
    if (state.line !== undefined) {
      params.set('line', String(state.line));
    }
  } else {
    if (state.left) {
      params.set('left', state.left);
      if (state.leftLine !== undefined) {
        params.set('leftLine', String(state.leftLine));
      }
    }
    if (state.right) {
      params.set('right', state.right);
      if (state.rightLine !== undefined) {
        params.set('rightLine', String(state.rightLine));
      }
    }
  }

  const queryString = params.toString().replace(/\+/g, '%20');
  return queryString ? `#/view?${queryString}` : '#/';
}

export interface CommentRoute {
  id: string;
}

/**
 * Parses a "#/comment/<id>" style hash produced by the sticky-note card's
 * "リンクをコピー" button. Returns null for any hash that isn't this route
 * (including the "#/view..." route handled by parseHash above).
 *
 * The id segment is URL-decoded and truncated at the first '/' or '?' so
 * trailing path noise can't leak into the id passed to getComment().
 */
export function parseCommentRoute(hash: string): CommentRoute | null {
  const prefix = '#/comment/';
  if (!hash || !hash.startsWith(prefix)) {
    return null;
  }
  const rest = hash.slice(prefix.length);
  const idPart = rest.split(/[/?]/, 1)[0];
  if (!idPart) {
    return null;
  }
  let id: string;
  try {
    id = decodeURIComponent(idPart);
  } catch {
    return null;
  }
  if (!id) {
    return null;
  }
  return { id };
}
