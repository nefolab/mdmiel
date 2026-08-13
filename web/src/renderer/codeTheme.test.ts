import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { injectCodeTheme } from './codeTheme';

const STYLE_SELECTOR = 'style[data-mdmiel-code-theme]';

describe('injectCodeTheme', () => {
  beforeEach(() => {
    document.querySelectorAll(STYLE_SELECTOR).forEach((element) => element.remove());
  });

  afterEach(() => {
    document.querySelectorAll(STYLE_SELECTOR).forEach((element) => element.remove());
  });

  it('injects scoped paper and slate theme blocks', () => {
    injectCodeTheme();

    const style = document.head.querySelector<HTMLStyleElement>(STYLE_SELECTOR);
    const css = style?.textContent ?? '';
    expect(style).not.toBeNull();
    expect(css).toContain('@layer hljs-theme {');
    expect(css).toContain(':root[data-theme="paper"] .markdown-body {');
    expect(css).toContain(':root[data-theme="slate"] .markdown-body {');
  });

  it('keeps the light and dark themes in the correct, valid blocks', () => {
    injectCodeTheme();

    const css = document.head.querySelector<HTMLStyleElement>(STYLE_SELECTOR)?.textContent ?? '';
    const paperIndex = css.indexOf(':root[data-theme="paper"] .markdown-body {');
    const slateIndex = css.indexOf(':root[data-theme="slate"] .markdown-body {');
    const paperBlock = css.slice(paperIndex, slateIndex);
    const slateBlock = css.slice(slateIndex);

    expect(paperIndex).toBeGreaterThan(-1);
    expect(slateIndex).toBeGreaterThan(paperIndex);
    expect(paperBlock).toContain('#d73a49');
    expect(slateBlock).toContain('#ff7b72');
    expect(css.match(/{/g)).toHaveLength(css.match(/}/g)?.length ?? 0);
  });

  it('reuses the style element when called twice', () => {
    injectCodeTheme();
    const firstStyle = document.head.querySelector<HTMLStyleElement>(STYLE_SELECTOR);

    injectCodeTheme();

    const styles = document.head.querySelectorAll<HTMLStyleElement>(STYLE_SELECTOR);
    expect(styles).toHaveLength(1);
    expect(styles[0]).toBe(firstStyle);
  });
});
