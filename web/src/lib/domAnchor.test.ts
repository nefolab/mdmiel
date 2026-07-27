import { describe, expect, it } from 'vitest';
import { snippetHash } from './comments';
import { applyHoverHighlight, buildDomAnchorPick, buildDomSelector, clearHoverHighlight, extractAnchorText, isPickableElement } from './domAnchor';

describe('domAnchor', () => {
  it('builds id, test id, and full-path selectors', () => {
    document.body.innerHTML = '<div id="item"></div><div data-testid="save"></div><main><span></span><span id="target"></span></main>';
    expect(buildDomSelector(document.getElementById('item'))).toBe('#item');
    expect(buildDomSelector(document.querySelector('[data-testid]'))).toBe('[data-testid="save"]');
    const span = document.querySelector('main span')!;
    expect(buildDomSelector(span)).toBe('html > body:nth-of-type(1) > main:nth-of-type(1) > span:nth-of-type(1)');
  });

  it('counts only same-tag siblings and caps paths at depth 20', () => {
    document.body.innerHTML = '<div></div><p></p><div id="second"></div>';
    expect(buildDomSelector(document.getElementById('second'))).toBe('#second');
    let node = document.body as Element;
    for (let i = 0; i < 21; i++) { const child = document.createElement('div'); node.append(child); node = child; }
    expect(buildDomSelector(node).split(' > ')).toHaveLength(20);
    expect(buildDomSelector(node).startsWith('html >')).toBe(false);
  });

  it('handles detached/null/non-element inputs', () => {
    expect(buildDomSelector(null)).toBe('');
    expect(() => buildDomSelector(document.createElement('div'))).not.toThrow();
    expect(() => buildDomSelector(document.createTextNode('x') as unknown as Element)).not.toThrow();
  });

  it('normalizes and caps anchor text', () => {
    const el = document.createElement('div');
    el.textContent = `  a\n  b ${'x'.repeat(100)}`;
    expect(extractAnchorText(el)).toBe(`a b ${'x'.repeat(76)}`);
    expect(extractAnchorText(document.createElement('div'))).toBe('');
  });

  it('identifies pickable elements using their owner document', () => {
    const other = document.implementation.createHTMLDocument();
    expect(isPickableElement(null)).toBe(false);
    expect(isPickableElement(document.createTextNode('x'))).toBe(false);
    expect(isPickableElement(document.documentElement)).toBe(false);
    expect(isPickableElement(document.body)).toBe(false);
    expect(isPickableElement(document.createElement('div'))).toBe(true);
    expect(isPickableElement(other.body)).toBe(false);
    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    const iframeElement = iframe.contentDocument!.createElement('div');
    iframe.contentDocument!.body.append(iframeElement);
    expect(iframeElement instanceof Element).toBe(false);
    expect(isPickableElement(iframeElement)).toBe(true);
    iframe.remove();
  });

  it('builds a hashed pick and declines an empty selector', () => {
    const el = document.createElement('div'); el.textContent = ' hello ';
    const pick = buildDomAnchorPick(el);
    expect(pick?.snippetHash).toBe(snippetHash('hello'));
    expect(buildDomAnchorPick(document.createElementNS('http://www.w3.org/2000/svg', 'svg'))).not.toBeNull();
  });

  it('restores hover inline styles exactly', () => {
    const el = document.createElement('div');
    el.style.outline = '1px solid blue'; el.style.outlineOffset = '3px';
    const saved = applyHoverHighlight(el);
    expect(el.style.outline).toContain('rgba');
    clearHoverHighlight(saved);
    expect(el.style.outline).toBe('1px solid blue');
    expect(el.style.outlineOffset).toBe('3px');
    expect(el.style.backgroundColor).toBe('');
  });
});
