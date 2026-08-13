const STORAGE_KEY = 'mdmiel-sidebar-open';
const DEFAULT_SIDEBAR_OPEN = true;

function isStoredBoolean(value: string | null): value is 'true' | 'false' {
  return value === 'true' || value === 'false';
}

/** 保存済みの開閉状態を返す。未保存・不正値の場合は開いた状態を既定とする。 */
export function getSidebarOpen(): boolean {
  const stored = localStorage.getItem(STORAGE_KEY);
  return isStoredBoolean(stored) ? stored === 'true' : DEFAULT_SIDEBAR_OPEN;
}

/** サイドバーの開閉状態をlocalStorageへ永続化する。 */
export function setSidebarOpen(open: boolean): void {
  localStorage.setItem(STORAGE_KEY, String(open));
}
