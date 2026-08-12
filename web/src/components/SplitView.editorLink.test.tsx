import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SplitView } from './SplitView';

vi.mock('./StickyNoteLayer', () => ({
  StickyNoteLayer: () => <div className="sticky-note-probe" />,
}));

let root: Root;
let mount: HTMLDivElement;

beforeEach(() => {
  mount = document.createElement('div');
  document.body.append(mount);
  root = createRoot(mount);
  localStorage.clear();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  mount.remove();
  localStorage.clear();
  vi.restoreAllMocks();
});

/**
 * 両ペインを開く。rootDir を渡すと、サーバーと同じくペインごとに異なる絶対パス
 * ( rootDir + 相対パス ) を返す。undefined を渡すと absPath 自体を返さない旧サーバー相当。
 */
async function renderPanes(rootDir: string | undefined, editorScheme?: string) {
  const extra = (path: string): Record<string, unknown> => {
    if (rootDir === undefined) return {};
    return { absPath: rootDir === '' ? '' : `${rootDir}/${path}`, editorScheme };
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/file?path=')) {
        const path = decodeURIComponent(url.slice('/api/file?path='.length));
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ path, type: 'markdown', content: '# doc', ...extra(path) }),
        } as Response);
      }
      throw new Error(`unexpected fetch: ${url}`);
    })
  );

  await act(async () => {
    root.render(
      <SplitView
        revision={1}
        viewState={{ left: 'docs/left.md', right: 'docs/right.md' }}
        onClosePane={() => {}}
      />
    );
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function editorLinks(): HTMLAnchorElement[] {
  return Array.from(mount.querySelectorAll('.pane-title a.pane-open-editor-btn'));
}

describe('ペインヘッダーの鉛筆ボタン', () => {
  it('absPathが返ればファイルパスの隣にエディタURLのリンクを描画する', async () => {
    await renderPanes('/Users/me/work', 'vscode');

    const links = editorLinks();
    expect(links).toHaveLength(2);
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'vscode://file/Users/me/work/docs/left.md',
      'vscode://file/Users/me/work/docs/right.md',
    ]);
  });

  it('リンクはファイルパスと同じ .pane-title の中に置かれる', async () => {
    await renderPanes('/Users/me/work', 'vscode');

    const title = mount.querySelector('.pane-title')!;
    expect(title.textContent).toContain('docs/left.md');
    expect(title.querySelector('a.pane-open-editor-btn')).not.toBeNull();
  });

  it('editorSchemeを差し替えるとURLのスキームが変わる', async () => {
    await renderPanes('/Users/me/work', 'cursor');

    expect(editorLinks()[0].getAttribute('href')).toBe(
      'cursor://file/Users/me/work/docs/left.md'
    );
  });

  it('absPathが空 ( 公開構成 ) ならリンクを描画しない', async () => {
    await renderPanes('', 'vscode');

    expect(editorLinks()).toHaveLength(0);
    // ヘッダー自体は従来どおり出ること ( 巻き添えで消えていない )
    expect(mount.querySelectorAll('.pane-title').length).toBe(2);
  });

  it('absPath/editorSchemeを返さない旧サーバーでもリンクを描画しない', async () => {
    await renderPanes(undefined);

    expect(editorLinks()).toHaveLength(0);
  });

  it('危険なスキームが返ってきてもリンクを描画しない', async () => {
    await renderPanes('/Users/me/work', 'javascript');

    expect(editorLinks()).toHaveLength(0);
  });

  it('アイコン表示でも用途が読み取れる名前を持つ', async () => {
    await renderPanes('/Users/me/work', 'vscode');

    const link = editorLinks()[0];
    expect(link.getAttribute('aria-label')).toBe('エディタで開く');
    expect(link.getAttribute('title')).toBe('エディタで開く');
  });

  it('クリックの既定動作を止めない ( 止めるとエディタが起動しない )', async () => {
    await renderPanes('/Users/me/work', 'vscode');

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => {
      editorLinks()[0].dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
  });
});
