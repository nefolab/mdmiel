import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar, type SidebarProps } from './Sidebar';

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

async function renderSidebar(payload: unknown, props: Partial<SidebarProps> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => payload,
    })
  );

  await act(async () => {
    root.render(
      <Sidebar
        revision={0}
        sidebarOpen
        query=""
        onSelectFile={() => {}}
        {...props}
      />
    );
  });
}

function rerenderSidebar(props: Partial<SidebarProps>) {
  act(() => {
    root.render(
      <Sidebar
        revision={0}
        sidebarOpen
        query=""
        onSelectFile={() => {}}
        {...props}
      />
    );
  });
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
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
  it('配信中のディレクトリ名を末尾スラッシュ付きで出す', async () => {
    await renderSidebar({ files, rootName: 'Workspace' });

    expect(title().textContent?.trim()).toBe('Workspace/');
  });

  it('ファイルが1件も無くても見出しは出す', async () => {
    await renderSidebar({ files: [], rootName: 'Workspace' });

    expect(title().textContent?.trim()).toBe('Workspace/');
    expect(mount.textContent).toContain('ファイルがありません');
    expect(mount.textContent).not.toContain('該当なし');
  });

  it('ファイルが1件も無ければ検索中でも「ファイルがありません」だけを出す', async () => {
    await renderSidebar({ files: [], rootName: 'Workspace' }, { query: 'spec' });

    expect(mount.textContent).toContain('ファイルがありません');
    expect(mount.textContent).not.toContain('該当なし');
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
    expect(title().textContent?.trim()).toBe(`${name}/`);
  });

  it('ファイル一覧の描画は従来どおり', async () => {
    await renderSidebar({ files, rootName: 'Workspace' });

    expect(mount.querySelectorAll('.file-item').length).toBe(1);
    expect(mount.textContent).toContain('doc.md');
  });
});

describe('ファイル検索', () => {
  const nestedFiles = [
    { path: 'docs/design/spec.md', type: 'markdown' },
    { path: 'docs/guide.md', type: 'markdown' },
    { path: 'other.html', type: 'html' },
  ];

  it('一致しないファイルを描画しない', async () => {
    await renderSidebar({ files: nestedFiles }, { query: 'spec' });

    expect(mount.textContent).toContain('spec.md');
    expect(mount.textContent).not.toContain('guide.md');
    expect(mount.textContent).not.toContain('other.html');
  });

  it('ヒットしたファイルの祖先ディレクトリを自動展開する', async () => {
    await renderSidebar({ files: nestedFiles });
    click(Array.from(mount.querySelectorAll('.file-name')).find((node) => node.textContent === 'docs')!);

    rerenderSidebar({ query: 'spec' });

    expect(mount.textContent).toContain('design');
    expect(mount.textContent).toContain('spec.md');
    expect(
      Array.from(mount.querySelectorAll('.file-item')).find((item) => item.textContent?.includes('docs'))
        ?.querySelector('.file-icon')?.textContent
    ).toBe('📂');
  });

  it('ヒットが0件なら「該当なし」を表示する', async () => {
    await renderSidebar({ files: nestedFiles }, { query: 'missing' });

    expect(mount.textContent).toContain('該当なし');
    expect(mount.textContent).not.toContain('ファイルがありません');
    expect(mount.querySelectorAll('.file-item')).toHaveLength(0);
  });

  it('検索中のディレクトリクリックは折りたたみ状態を変更しない', async () => {
    await renderSidebar({ files: nestedFiles }, { query: 'spec' });
    const docs = Array.from(mount.querySelectorAll('.file-item')).find((item) =>
      item.textContent?.includes('docs')
    )!;

    expect(docs.classList.contains('search-expanded')).toBe(true);
    click(docs);
    rerenderSidebar({ query: '' });

    expect(mount.textContent).toContain('spec.md');
    expect(docs.querySelector('.file-icon')?.textContent).toBe('📂');
  });

  it('検索中もファイル行を選択できる', async () => {
    const onSelectFile = vi.fn();
    await renderSidebar(
      { files: nestedFiles },
      { query: 'spec', onSelectFile }
    );

    click(Array.from(mount.querySelectorAll('.file-item')).find((item) =>
      item.textContent?.includes('spec.md')
    )!);

    expect(onSelectFile).toHaveBeenCalledWith('docs/design/spec.md', 'left');
  });

  it('検索を解除してもユーザーの折りたたみ状態を維持する', async () => {
    await renderSidebar({ files: nestedFiles });
    click(Array.from(mount.querySelectorAll('.file-name')).find((node) => node.textContent === 'docs')!);
    expect(mount.textContent).not.toContain('spec.md');

    rerenderSidebar({ query: 'spec' });
    expect(mount.textContent).toContain('spec.md');

    rerenderSidebar({ query: '' });
    expect(mount.textContent).not.toContain('spec.md');
    expect(
      Array.from(mount.querySelectorAll('.file-item')).find((item) => item.textContent?.includes('docs'))
        ?.querySelector('.file-icon')?.textContent
    ).toBe('📁');
  });
});

describe('サイドバーの開閉', () => {
  it('aria-controlsの参照先になるIDを持つ', async () => {
    await renderSidebar({ files });

    expect(mount.querySelector('aside')?.id).toBe('file-sidebar');
  });

  it('閉じてもDOMからは削除しない', async () => {
    await renderSidebar({ files }, { sidebarOpen: false });

    const sidebar = mount.querySelector('.sidebar');
    expect(sidebar).not.toBeNull();
    expect(sidebar?.classList.contains('collapsed')).toBe(true);
    expect(mount.textContent).toContain('doc.md');
  });
});
