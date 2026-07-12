import { describe, it, expect } from 'vitest';
import { computeSnippet, snippetHash, rematchLine } from './comments';

describe('computeSnippet', () => {
  it('trims surrounding whitespace', () => {
    expect(computeSnippet('   hello world   ')).toBe('hello world');
  });

  it('collapses internal runs of whitespace into a single space', () => {
    expect(computeSnippet('foo   bar\t\tbaz')).toBe('foo bar baz');
  });

  it('handles empty and whitespace-only lines', () => {
    expect(computeSnippet('')).toBe('');
    expect(computeSnippet('   \t  ')).toBe('');
  });
});

describe('snippetHash', () => {
  it('is deterministic for the same input', () => {
    const a = snippetHash('ユーザーは仕様書を確認する');
    const b = snippetHash('ユーザーは仕様書を確認する');
    expect(a).toBe(b);
  });

  it('returns an 8-char hex string', () => {
    expect(snippetHash('hello')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('differs for different inputs (basic collision sanity check)', () => {
    const hashes = new Set(
      ['hello', 'world', 'foo bar', 'baz qux', '仕様書1', '仕様書2'].map(snippetHash)
    );
    expect(hashes.size).toBe(6);
  });
});

describe('rematchLine', () => {
  const buildContent = (lines: string[]) => lines.join('\n');

  it('returns the same line when content is unchanged', () => {
    const content = buildContent(['line1', 'line2', 'target line', 'line4']);
    const result = rematchLine({
      content,
      anchorLine: 3,
      snippetHash: snippetHash(computeSnippet('target line')),
    });
    expect(result).toEqual({ line: 3, orphaned: false });
  });

  it('follows the target line when lines are inserted before it', () => {
    const hash = snippetHash(computeSnippet('target line'));
    // Insert two new lines before the target, shifting it from line 3 to line 5.
    const after = buildContent(['line1', 'inserted A', 'inserted B', 'line2', 'target line', 'line4']);

    const result = rematchLine({ content: after, anchorLine: 3, snippetHash: hash });
    expect(result).toEqual({ line: 5, orphaned: false });
  });

  it('picks the closest match to anchorLine when the snippet appears multiple times', () => {
    const hash = snippetHash(computeSnippet('dup'));
    const content = buildContent(['dup', 'a', 'b', 'c', 'dup', 'd', 'e', 'dup']);
    // anchorLine 5 sits exactly on the middle occurrence.
    const result = rematchLine({ content, anchorLine: 5, snippetHash: hash });
    expect(result).toEqual({ line: 5, orphaned: false });
  });

  it('returns orphaned when no line within the radius matches', () => {
    const content = buildContent(['line1', 'line2', 'line3']);
    const result = rematchLine({
      content,
      anchorLine: 2,
      snippetHash: snippetHash(computeSnippet('this text no longer exists anywhere')),
    });
    expect(result).toEqual({ line: 2, orphaned: true });
  });

  it('does not search outside of the configured radius', () => {
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) lines.push(`filler ${i}`);
    lines[490] = 'far away target'; // line 491 (1-based)
    const content = buildContent(lines);
    const hash = snippetHash(computeSnippet('far away target'));

    // anchorLine 1 is far more than 200 lines away from line 491.
    const result = rematchLine({ content, anchorLine: 1, snippetHash: hash, radius: 200 });
    expect(result).toEqual({ line: 1, orphaned: true });
  });

  // Regression: the create-time snippet must be derived from the *raw source
  // line* (same source rematchLine uses), not the rendered DOM textContent.
  // Otherwise headings/lists/quotes/HTML tags hash differently and every
  // comment on them would be orphaned even when the file is unchanged.
  it.each([
    ['heading', '# Spec Title'],
    ['list item', '- first item'],
    ['blockquote', '> important quote'],
    ['html paragraph', '<p>hello world</p>'],
    ['indented line with tabs', '\t\tconst x = 1;  // note'],
    ['table row', '| col A | col B |'],
  ])('matches a %s line against unchanged content', (_name, targetLine) => {
    const content = buildContent(['intro', targetLine, 'outro']);
    // Snippet is computed from the raw source line, as SplitView.getLineText does.
    const hash = snippetHash(computeSnippet(targetLine));
    const result = rematchLine({ content, anchorLine: 2, snippetHash: hash });
    expect(result).toEqual({ line: 2, orphaned: false });
  });

  it('respects a custom radius', () => {
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) lines.push(`filler ${i}`);
    lines[15] = 'nearby target'; // line 16 (1-based)
    const content = buildContent(lines);
    const hash = snippetHash(computeSnippet('nearby target'));

    const found = rematchLine({ content, anchorLine: 10, snippetHash: hash, radius: 10 });
    expect(found).toEqual({ line: 16, orphaned: false });

    const notFound = rematchLine({ content, anchorLine: 10, snippetHash: hash, radius: 5 });
    expect(notFound).toEqual({ line: 10, orphaned: true });
  });
});
