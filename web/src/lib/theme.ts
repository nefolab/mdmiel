// テーマ (paper/slate) の状態管理。
// 正本の色トークン定義は index.css の :root[data-theme="..."] ブロックを参照。

export type Theme = 'paper' | 'slate';

const STORAGE_KEY = 'mdmiel-theme';
const DEFAULT_THEME: Theme = 'slate';

function isTheme(value: string | null): value is Theme {
  return value === 'paper' || value === 'slate';
}

/** localStorageに保存済みの値があればそれを、無ければデフォルト ( slate ) を返す。 */
export function getInitialTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  return isTheme(stored) ? stored : DEFAULT_THEME;
}

/** documentElementにdata-theme属性を設定し、localStorageへ永続化する。 */
export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(STORAGE_KEY, theme);
}
