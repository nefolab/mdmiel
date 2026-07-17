import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './markdown';

describe('markdown renderer', () => {
  it('should render headings, paragraphs, and lists with correct data-source-line', () => {
    const md = `# Heading 1

This is a paragraph.

- Item 1
- Item 2
`;
    const html = renderMarkdown(md);

    // Check heading (1-based line 1)
    expect(html).toContain('<h1 data-source-line="1">Heading 1</h1>');

    // Check paragraph (1-based line 3)
    expect(html).toContain('<p data-source-line="3">This is a paragraph.</p>');

    // Check list items (1-based line 5 and 6)
    expect(html).toContain('<li data-source-line="5">Item 1</li>');
    expect(html).toContain('<li data-source-line="6">Item 2</li>');
  });

  it('should escape raw HTML tags', () => {
    const md = '<div>Hello</div>';
    const html = renderMarkdown(md);
    expect(html).not.toContain('<div>Hello</div>');
    expect(html).toContain('&lt;div&gt;Hello&lt;/div&gt;');
  });
});
