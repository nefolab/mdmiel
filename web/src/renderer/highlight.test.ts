import hljs from 'highlight.js/lib/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { highlightCode, MAX_HIGHLIGHT_LENGTH } from './highlight';

describe('highlightCode', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['go', 'package main\nfunc main() {}'],
    ['typescript', 'const value: string = "text";'],
    ['javascript', 'const value = () => true;'],
    ['json', '{"enabled": true}'],
    ['bash', 'echo "$PATH"'],
    ['yaml', 'enabled: true'],
    ['xml', '<div class="item">text</div>'],
    ['css', '.item { color: red; }'],
    ['php', '<?php echo "text"; ?>'],
  ])('highlights registered language %s', (lang, code) => {
    const highlighted = highlightCode(code, lang);
    expect(highlighted).toMatch(/<span class="hljs-/);
    expect(highlighted?.startsWith('<pre')).toBe(false);
  });

  it.each([
    ['ts', 'const value: string = "text";'],
    ['tsx', 'const element = <div>text</div>;'],
    ['js', 'const value = true;'],
    ['jsx', 'const element = <div>text</div>;'],
    ['sh', 'echo "$PATH"'],
    ['html', '<div>text</div>'],
    ['yml', 'enabled: true'],
  ])('resolves registered alias %s', (lang, code) => {
    expect(highlightCode(code, lang)).toMatch(/<span class="hljs-/);
  });

  it.each(['brainfuck', ''])('returns null for unavailable language %j', (lang) => {
    expect(highlightCode('some code', lang)).toBeNull();
  });

  it('returns null when the code exceeds the size limit', () => {
    expect(MAX_HIGHLIGHT_LENGTH).toBe(100_000);
    expect(highlightCode('a'.repeat(100_001), 'javascript')).toBeNull();
  });

  it('highlights an incomplete code fragment', () => {
    const code = 'func main() { if x {';
    const highlightSpy = vi.spyOn(hljs, 'highlight');
    const highlighted = highlightCode(code, 'go');

    expect(highlighted).not.toBeNull();
    expect(highlighted).toContain('hljs-');
    expect(highlightSpy).toHaveBeenCalledWith(code, {
      language: 'go',
      ignoreIllegals: true,
    });
  });

  it('returns null when highlight.js throws', () => {
    vi.spyOn(hljs, 'highlight').mockImplementation(() => {
      throw new Error('highlight failed');
    });

    expect(highlightCode('const value = true;', 'javascript')).toBeNull();
  });
});
