import MarkdownIt from 'markdown-it';

/**
 * A markdown-it plugin that injects `data-source-line` attributes
 * to block-level tokens using the token's map (source line range).
 */
export function sourceLinePlugin(md: MarkdownIt) {
  md.core.ruler.push('source_line', (state) => {
    // Only top-level (block) tokens are annotated; inline children tokens
    // don't render their own attrs, so recursing into them has no effect.
    for (const token of state.tokens) {
      if (token.map) {
        const line = token.map[0] + 1; // 1-based line number
        token.attrSet('data-source-line', String(line));
      }
    }
    return true;
  });
}

const md = new MarkdownIt({
  html: false, // Ensure raw HTML is escaped for security as per specs
  linkify: true,
});

md.use(sourceLinePlugin);

/**
 * Renders markdown text to HTML with `data-source-line` attributes.
 */
export function renderMarkdown(content: string): string {
  return md.render(content);
}
