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

  it.each([
    ['registered language', '```go\npackage main\n```'],
    ['unregistered language', '```brainfuck\n+++\n```'],
    ['no language', '```\nplain text\n```'],
  ])('preserves the source line on a code block with %s', (_case, markdown) => {
    const container = document.createElement('div');
    container.innerHTML = renderMarkdown(markdown);

    const codeBlocks = container.querySelectorAll('pre > code[data-source-line="1"]');
    expect(codeBlocks).toHaveLength(1);
    expect(codeBlocks[0].querySelector('pre')).toBeNull();
  });

  it('adds highlight.js and language classes to registered code blocks', () => {
    const container = document.createElement('div');
    container.innerHTML = renderMarkdown('```go\npackage main\n```');

    const code = container.querySelector('pre > code[data-source-line="1"]');
    expect(code?.classList.contains('hljs')).toBe(true);
    expect(code?.classList.contains('language-go')).toBe(true);
  });

  it('renders highlighted spans only for registered languages', () => {
    const highlightedContainer = document.createElement('div');
    highlightedContainer.innerHTML = renderMarkdown('```go\npackage main\nfunc main() {}\n```');

    const fallbackContainer = document.createElement('div');
    fallbackContainer.innerHTML = renderMarkdown('```brainfuck\n+++\n```');

    expect(highlightedContainer.querySelectorAll('code [class^="hljs-"]').length)
      .toBeGreaterThan(0);
    expect(fallbackContainer.querySelectorAll('code [class^="hljs-"]')).toHaveLength(0);
  });

  it.each(['xml', 'brainfuck'])('escapes code content for language %s', (lang) => {
    const source = '<script>alert(1)</script>';
    const container = document.createElement('div');
    container.innerHTML = renderMarkdown(`\`\`\`${lang}\n${source}\n\`\`\``);

    const code = container.querySelector('pre > code');
    expect(container.querySelector('script')).toBeNull();
    expect(code?.textContent).toBe(`${source}\n`);
  });
});
