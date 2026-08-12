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

/** /api/files の応答を固定してSidebarを描画する */
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

function editorLinks(): HTMLAnchorElement[] {
  return Array.from(mount.querySelectorAll('a.btn-open-editor'));
}

const filesPayload = {
  files: [
    { path: 'doc.md', type: 'markdown' },
    { path: 'sub/page.html', type: 'html' },
  ],
};

describe('Sidebar の「開く」ボタン', () => {
  it('rootが返ればファイルごとにエディタURLのリンクを描画する', async () => {
    await renderSidebar({ ...filesPayload, root: '/Users/me/work', editorScheme: 'vscode' });

    const links = editorLinks();
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'vscode://file/Users/me/work/sub/page.html',
      'vscode://file/Users/me/work/doc.md',
    ]);
  });

  it('editorSchemeを差し替えるとURLのスキームが変わる', async () => {
    await renderSidebar({
      files: [{ path: 'doc.md', type: 'markdown' }],
      root: '/Users/me/work',
      editorScheme: 'cursor',
    });

    expect(editorLinks()[0].getAttribute('href')).toBe('cursor://file/Users/me/work/doc.md');
  });

  it('rootが空 ( 公開構成 ) ならリンクを描画しない', async () => {
    await renderSidebar({ ...filesPayload, root: '', editorScheme: 'vscode' });

    expect(editorLinks()).toHaveLength(0);
    // 一覧そのものは従来どおり出ること ( 巻き添えで消えていない )
    expect(mount.querySelectorAll('.file-item').length).toBeGreaterThan(0);
  });

  it('root/editorSchemeを返さない旧サーバーでもリンクを描画しない', async () => {
    await renderSidebar(filesPayload);

    expect(editorLinks()).toHaveLength(0);
  });

  it('ディレクトリ行にはリンクを描画しない', async () => {
    await renderSidebar({
      files: [{ path: 'sub/page.html', type: 'html' }],
      root: '/Users/me/work',
      editorScheme: 'vscode',
    });

    expect(editorLinks()).toHaveLength(1);
  });

  it('リンクのクリックはファイル選択に伝播しない', async () => {
    const onSelectFile = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          files: [{ path: 'doc.md', type: 'markdown' }],
          root: '/Users/me/work',
          editorScheme: 'vscode',
        }),
      })
    );
    await act(async () => {
      root.render(<Sidebar revision={0} onSelectFile={onSelectFile} />);
    });

    const link = editorLinks()[0];
    // jsdomはカスタムスキームへの遷移を実装していないため、既定動作は抑止して伝播だけ見る
    link.addEventListener('click', (e) => e.preventDefault());
    await act(async () => {
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(onSelectFile).not.toHaveBeenCalled();
  });
});
