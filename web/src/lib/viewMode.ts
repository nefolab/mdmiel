// HTMLプレビューの表示モード (static/live) の状態管理。
// static: 既存のスクリプト無効iframe描画。live: allow-scriptsのiframeでモックをそのまま実行する ( L0 PoC )。
// キーはファイルパスごとに独立させ、モックごとに選択を記憶する。

export type ViewMode = 'static' | 'live';

const STORAGE_PREFIX = 'mdmiel-view-mode:';
const DEFAULT_VIEW_MODE: ViewMode = 'static';

function isViewMode(value: string | null): value is ViewMode {
  return value === 'static' || value === 'live';
}

function storageKey(path: string): string {
  return `${STORAGE_PREFIX}${path}`;
}

/** 指定パスにlocalStorage保存済みの値があればそれを、無ければデフォルト ( static ) を返す。 */
export function getViewMode(path: string): ViewMode {
  const stored = localStorage.getItem(storageKey(path));
  return isViewMode(stored) ? stored : DEFAULT_VIEW_MODE;
}

/** 指定パスの表示モードをlocalStorageへ永続化する。 */
export function setViewMode(path: string, mode: ViewMode): void {
  localStorage.setItem(storageKey(path), mode);
}
