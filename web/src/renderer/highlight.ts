import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import php from 'highlight.js/lib/languages/php';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

/**
 * ハイライトを諦める入力サイズ。同期処理でメインスレッドを占有するため、
 * 巨大なコードブロックでペインが固まるのを防ぐ。
 *
 * 単位はバイトではなくUTF-16コードユニット数 ( String.length )。日本語コメントが
 * 多いコードは実バイト数がこれより大きくなるが、体感を決めるのは解析対象の
 * 文字数なのでこのままでよい。
 */
export const MAX_HIGHLIGHT_LENGTH = 100_000;

hljs.registerLanguage('go', go);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('php', php);

/** Returns highlighted code markup, or null when plain rendering is safer. */
export function highlightCode(code: string, lang: string): string | null {
  if (!lang || !hljs.getLanguage(lang) || code.length > MAX_HIGHLIGHT_LENGTH) {
    return null;
  }

  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}
