/**
 * Comment domain types and pure logic (snippet normalization, hashing, and
 * line re-matching after the underlying file has drifted).
 *
 * Kept separate from lib/anchor.ts (which owns ViewState/parseHash/generateHash)
 * so that anchor.ts and its existing tests remain untouched.
 */

export interface CommentAnchor {
  line: number;
  snippet: string;
  snippetHash: string;
}

export interface Comment {
  version: 1;
  id: string;
  path: string;
  anchor: CommentAnchor;
  body: string;
  author: string;
  createdAt: string; // RFC3339
  updatedAt?: string;
  links?: string[];
  resolved: boolean;
  noteOffset?: { dx: number; dy: number };
}

/**
 * Normalizes a line of text into a stable snippet: trims surrounding
 * whitespace and collapses any run of whitespace into a single space.
 */
export function computeSnippet(lineText: string): string {
  return lineText.trim().replace(/\s+/g, ' ');
}

/**
 * Deterministic, lightweight 32-bit FNV-1a hash rendered as an 8-char hex
 * string. Only needs to be internally consistent (generated and matched
 * entirely on the frontend); it does not need to match any backend hash.
 */
export function snippetHash(snippet: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < snippet.length; i++) {
    hash ^= snippet.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export interface RematchLineParams {
  /** Full current content of the target file. */
  content: string;
  /** Originally saved 1-based line number. */
  anchorLine: number;
  /** Originally saved snippet hash to search for. */
  snippetHash: string;
  /** Search radius in lines on either side of anchorLine. Default 200. */
  radius?: number;
}

export interface RematchLineResult {
  line: number;
  orphaned: boolean;
}

/**
 * Re-locates a previously anchored line inside the current file content.
 *
 * Splits `content` into lines and searches a window of `anchorLine` ± radius
 * (1-based, default radius 200). Every line in the window is normalized with
 * computeSnippet + snippetHash; among lines whose hash matches the saved
 * snippetHash, the one closest to anchorLine wins. If no line in the window
 * matches, the comment is considered orphaned and the original anchorLine is
 * returned unchanged.
 */
export function rematchLine(params: RematchLineParams): RematchLineResult {
  const { content, anchorLine, snippetHash: targetHash, radius = 200 } = params;
  const lines = content.split('\n');
  const total = lines.length;

  const lo = Math.max(1, anchorLine - radius);
  const hi = Math.min(total, anchorLine + radius);

  let bestLine: number | null = null;
  let bestDistance = Infinity;

  for (let ln = lo; ln <= hi; ln++) {
    const text = lines[ln - 1];
    const hash = snippetHash(computeSnippet(text));
    if (hash === targetHash) {
      const distance = Math.abs(ln - anchorLine);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestLine = ln;
      }
    }
  }

  if (bestLine === null) {
    return { line: anchorLine, orphaned: true };
  }
  return { line: bestLine, orphaned: false };
}
