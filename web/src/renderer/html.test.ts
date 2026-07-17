import { describe, it, expect } from 'vitest';
import { renderHtml } from './html';

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
