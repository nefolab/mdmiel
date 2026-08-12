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

// 見た目にしか現れない性質 ( 大文字化しない・長い名前を折り返す ) はここでは検査できない。
// jsdomは外部CSSを適用せず、text-transform も overflow-wrap も textContent を変えないため。
// ここで固定するのは「文字列を切り詰めていない」ことまでで、表示の確認は実機で行う。
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

  it('長いディレクトリ名も省略せず全部出す', async () => {
    const name = 'very-long-project-directory-name-that-wraps';
    await renderSidebar({ files, rootName: name });

    // 折り返して全文を見せる方針なので、切り詰めや ... を入れない
    expect(title().textContent?.trim()).toBe(name);
  });

  it('ファイル一覧の描画は従来どおり', async () => {
    await renderSidebar({ files, rootName: 'Workspace' });

    expect(mount.querySelectorAll('.file-item').length).toBe(1);
    expect(mount.textContent).toContain('doc.md');
  });
});
