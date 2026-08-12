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

/** ペインごとに ( 表示パス, リンクのhref一覧 ) を取り出す。左右の取り違えを検出するため */
function panes(): { path: string; hrefs: (string | null)[] }[] {
  return Array.from(mount.querySelectorAll('.pane')).map((pane) => {
    const title = pane.querySelector('.pane-title')!;
    return {
      path: title.querySelector('.pane-title-path')!.textContent ?? '',
      hrefs: Array.from(title.querySelectorAll('a.pane-open-editor-btn')).map((a) =>
        a.getAttribute('href')
      ),
    };
  });
}

describe('ペインヘッダーの鉛筆ボタン', () => {
  it('各ペインが自分のファイルのリンクを1本ずつ持つ', async () => {
    await renderPanes('/Users/me/work', 'vscode');

    // ペイン単位で照合する。DOM順に並べるだけの検査だと、片方のヘッダーに2本
    // 入って他方が0本という壊れ方を見逃す
    expect(panes()).toEqual([
      { path: 'docs/left.md', hrefs: ['vscode://file/Users/me/work/docs/left.md'] },
      { path: 'docs/right.md', hrefs: ['vscode://file/Users/me/work/docs/right.md'] },
    ]);
  });

  it('リンクはファイルパスと同じ .pane-title の中に置かれる', async () => {
    await renderPanes('/Users/me/work', 'vscode');

    const title = mount.querySelector('.pane-title')!;
    expect(title.textContent).toContain('docs/left.md');
    expect(title.querySelector('a.pane-open-editor-btn')).not.toBeNull();
  });

  it('ファイル切替の途中で前のファイルのリンクを残さない', async () => {
    await renderPanes('/Users/me/work', 'vscode');
    expect(panes()[0].hrefs).toEqual(['vscode://file/Users/me/work/docs/left.md']);

    // 新しいパスの取得を未解決のままにして、切替途中の状態で止める
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    await act(async () => {
      root.render(
        <SplitView
          revision={1}
          viewState={{ left: 'docs/next.md', right: 'docs/right.md' }}
          onClosePane={() => {}}
        />
      );
      await Promise.resolve();
    });

    const left = panes()[0];
    expect(left.path).toBe('docs/next.md');
    // 表示は next.md なのに left.md が開くリンクが残っていてはいけない
    expect(left.hrefs).toEqual([]);
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
