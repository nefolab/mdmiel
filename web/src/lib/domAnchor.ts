import { snippetHash } from './comments';

/** agent.ts の extractText と同じ80文字上限。両実装で同じ値を使う。 */
export const MAX_SNIPPET_LENGTH = 80;

/** agent.ts の buildSelector と同一仕様。 */
export function buildDomSelector(el: Element | null): string {
  if (!el || el.nodeType !== 1) return '';
  if (el.id) {
    const escapedId = window.CSS && typeof window.CSS.escape === 'function' ? window.CSS.escape(el.id) : el.id;
    return `#${escapedId}`;
  }
  const testId = el.getAttribute && el.getAttribute('data-testid');
  if (testId) return `[data-testid=${JSON.stringify(testId)}]`;

  const path: string[] = [];
  let node: Element | null = el;
  let depth = 0;
  while (node && node.nodeType === 1 && depth < 20) {
    const tag = node.tagName.toLowerCase();
    const parent: Element | null = node.parentElement;
    if (!parent) {
      path.unshift(tag);
      break;
    }
    const siblings: Element[] = [];
    for (let i = 0; i < parent.children.length; i++) {
      if (parent.children[i].tagName === node.tagName) siblings.push(parent.children[i]);
    }
    const index = siblings.indexOf(node) + 1;
    path.unshift(`${tag}:nth-of-type(${index})`);
    node = parent;
    depth++;
  }
  return path.join(' > ');
}

/** agent.ts の extractText と同一仕様。 */
export function extractAnchorText(el: Element | null): string {
  const raw = el?.textContent || '';
  const text = raw.replace(/\s+/g, ' ').trim();
  return text.length > MAX_SNIPPET_LENGTH ? text.slice(0, MAX_SNIPPET_LENGTH) : text;
}

/** pick対象として妥当か。非Element・html・body を除外する。 */
export function isPickableElement(target: EventTarget | null): target is Element {
  if (!target || (target as Node).nodeType !== 1) return false;
  const el = target as Element;
  return el !== el.ownerDocument.documentElement && el !== el.ownerDocument.body;
}

export interface DomAnchorPick {
  selector: string;
  snippet: string;
  snippetHash: string;
}

/** static/liveのpick結果としてコンポーザーへ渡す座標付きアンカー。 */
export interface PanePickResult extends DomAnchorPick {
  path: string;
  top: number;
  left: number;
}

/** 要素から保存用アンカー3点を作る。 */
export function buildDomAnchorPick(el: Element): DomAnchorPick | null {
  const selector = buildDomSelector(el);
  if (!selector) return null;
  const snippet = extractAnchorText(el);
  return { selector, snippet, snippetHash: snippetHash(snippet) };
}

export interface HoverHighlight {
  el: Element;
  outline: string;
  outlineOffset: string;
  backgroundColor: string;
}

/** ホバーハイライトの適用。 */
export function applyHoverHighlight(el: Element): HoverHighlight {
  const styled = el as HTMLElement;
  const saved = {
    el,
    outline: styled.style.outline,
    outlineOffset: styled.style.outlineOffset,
    backgroundColor: styled.style.backgroundColor,
  };
  styled.style.outline = '2px solid rgba(255, 149, 0, 0.9)';
  styled.style.outlineOffset = '-2px';
  styled.style.backgroundColor = 'rgba(255, 149, 0, 0.15)';
  return saved;
}

/** ホバーハイライトを元のinline styleへ戻す。 */
export function clearHoverHighlight(saved: HoverHighlight | null): void {
  if (!saved) return;
  const styled = saved.el as HTMLElement;
  styled.style.outline = saved.outline;
  styled.style.outlineOffset = saved.outlineOffset;
  styled.style.backgroundColor = saved.backgroundColor;
}
