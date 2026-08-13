import light from 'highlight.js/styles/github.css?inline';
import dark from 'highlight.js/styles/github-dark.css?inline';

const STYLE_SELECTOR = 'style[data-mdmiel-code-theme]';

function scopedTheme(selector: string, css: string): string {
  return `${selector} {\n${css}\n}`;
}

/** Injects the two scoped highlight.js themes, reusing the style element for HMR. */
export function injectCodeTheme(): void {
  const style = document.head.querySelector<HTMLStyleElement>(STYLE_SELECTOR)
    ?? document.createElement('style');

  style.setAttribute('data-mdmiel-code-theme', '');
  const themes = [
    scopedTheme(':root[data-theme="paper"] .markdown-body', light),
    scopedTheme(':root[data-theme="slate"] .markdown-body', dark),
  ].join('\n');
  style.textContent = `@layer hljs-theme {\n${themes}\n}`;

  if (!style.isConnected) {
    document.head.appendChild(style);
  }
}
