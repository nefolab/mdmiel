import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from './Sidebar';

let root: Root;
let mount: HTMLDivElement;

beforeEach(() => {
  mount = document.createElement('div');
  document.body.append(mount);
  root = createRoot(mount);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  mount.remove();
  vi.restoreAllMocks();
});

async function renderSidebar(payload: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => payload,
    })
  );

  await act(async () => {
    root.render(<Sidebar revision={0} onSelectFile={() => {}} />);
  });
}

function title(): HTMLElement {
  return mount.querySelector<HTMLElement>('.sidebar-title')!;
}

const files = [{ path: 'doc.md', type: 'markdown' }];

// 見出しを大文字化しない ( .sidebar-title から text-transform: uppercase を外した ) ことは
// ここでは検査できない。jsdomは外部CSSを適用せず、text-transform は textContent を変えない
// ため。表示上の確認は実機で行う。
describe('サイドバーの見出し', () => {
  it('配信中のディレクトリ名を出す', async () => {
    await renderSidebar({ files, rootName: 'Workspace' });

    expect(title().textContent?.trim()).toBe('Workspace');
  });

  it('ファイルが1件も無くても見出しは出す', async () => {
    await renderSidebar({ files: [], rootName: 'Workspace' });

    expect(title().textContent?.trim()).toBe('Workspace');
    expect(mount.textContent).toContain('ファイルがありません');
  });

  it('rootNameが空なら既定文言にフォールバックする', async () => {
    await renderSidebar({ files, rootName: '' });

    expect(title().textContent?.trim()).toBe('ファイル一覧');
  });

  it('rootNameを返さない旧サーバーでも既定文言を出す', async () => {
    await renderSidebar({ files });

    expect(title().textContent?.trim()).toBe('ファイル一覧');
  });

  it('省略表示に備えてtitle属性に全体を持つ', async () => {
    await renderSidebar({ files, rootName: 'very-long-directory-name' });

    expect(title().getAttribute('title')).toBe('very-long-directory-name');
  });

  it('ファイル一覧の描画は従来どおり', async () => {
    await renderSidebar({ files, rootName: 'Workspace' });

    expect(mount.querySelectorAll('.file-item').length).toBe(1);
    expect(mount.textContent).toContain('doc.md');
  });
});
