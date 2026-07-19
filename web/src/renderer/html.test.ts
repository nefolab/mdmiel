import { describe, it, expect } from 'vitest';
import { renderHtml, renderHtmlLive } from './html';

describe('html renderer', () => {
  it('should inject base tag and data-source-line attributes', () => {
    const rawHtml = `<!DOCTYPE html>
<html>
<head>
  <title>Test Page</title>
</head>
<body>
  <h1>Hello World</h1>
  <div>
    <p>A paragraph</p>
  </div>
</body>
</html>`;

    const processed = renderHtml(rawHtml, 'sub/folder/file.html');

    // 1. Check base tag injection with correct path
    expect(processed).toContain('<base href="/raw/sub/folder/">');

    // 2. Check data-source-line injection (1-based lines from parse5)
    expect(processed).toContain('<h1 data-source-line="7">Hello World</h1>');
    expect(processed).toContain('<div data-source-line="8">');
    expect(processed).toContain('<p data-source-line="9">A paragraph</p>');
  });

  it('should fallback to correct base path for root-level files', () => {
    const rawHtml = `<html><head></head><body><p>root</p></body></html>`;
    const processed = renderHtml(rawHtml, 'file.html');
    expect(processed).toContain('<base href="/raw/">');
  });
});

describe('renderHtmlLive', () => {
  const rawHtml = `<!DOCTYPE html>
<html>
<head>
  <title>Test Page</title>
</head>
<body>
  <h1>Hello World</h1>
</body>
</html>`;

  it('injects the base tag with the correct path', () => {
    const processed = renderHtmlLive(rawHtml, 'sub/folder/file.html', 'nonce-abc');
    expect(processed).toContain('<base href="/raw/sub/folder/">');
  });

  it('injects the agent script as the first child of head, before the base tag, with the nonce embedded', () => {
    const processed = renderHtmlLive(rawHtml, 'file.html', 'nonce-xyz-123');
    expect(processed).toContain('data-mdmiel-agent');
    expect(processed).toContain('window.__mdmielAgent');
    expect(processed).toContain('"nonce-xyz-123"');

    const headStart = processed.indexOf('<head>');
    const scriptIndex = processed.indexOf('data-mdmiel-agent');
    const baseIndex = processed.indexOf('<base');
    expect(scriptIndex).toBeGreaterThan(headStart);
    expect(scriptIndex).toBeLessThan(baseIndex);
  });

  it('does not inject data-source-line attributes or the highlight style (those are static-mode-only concerns)', () => {
    const processed = renderHtmlLive(rawHtml, 'file.html', 'nonce-1');
    expect(processed).not.toContain('data-source-line');
    expect(processed).not.toContain('highlightPulse');
    expect(processed).not.toContain('source-line-highlight');
  });

  it('is idempotent-safe: does not double-inject base/agent when called on already-processed head markup', () => {
    const alreadyHasBase = `<html><head><base href="/other/"></head><body><p>x</p></body></html>`;
    const processed = renderHtmlLive(alreadyHasBase, 'file.html', 'nonce-2');
    expect(processed.match(/<base/g)?.length).toBe(1);
  });

  it('serializes the agent script as raw text, not HTML-entity-escaped (regression: manually-built parse5 nodes need namespaceURI/parentNode or the JS gets corrupted)', () => {
    const processed = renderHtmlLive(rawHtml, 'file.html', 'nonce-3');
    // These substrings only survive intact if parse5 treated <script> as a raw-text
    // element. If escaping leaks in, "&&" becomes "&amp;&amp;" and ">" becomes "&gt;",
    // which is a JS syntax error at runtime (the bug this test guards against).
    expect(processed).toContain('parentOrigin && event.origin !== parentOrigin');
    expect(processed).toContain('depth < 20');
    expect(processed).not.toContain('&amp;');
    expect(processed).not.toContain('&gt;');
    expect(processed).not.toContain('&lt;');
  });
});
