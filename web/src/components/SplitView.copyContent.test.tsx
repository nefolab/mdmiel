import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SplitView } from './SplitView';
import { ViewState } from '../lib/anchor';

vi.mock('./StickyNoteLayer', () => ({
  StickyNoteLayer: () => <div className="sticky-note-probe" />,
}));

let root: Root;
let mount: HTMLDivElement;
let writeText: ReturnType<typeof vi.fn>;

const LEFT_MD = '# Left unique marker alpha';
const RIGHT_MD = '# Right unique marker beta';
const LEFT_HTML = '<!DOCTYPE html><html><body><p>Raw unique gamma</p></body></html>';
const RIGHT_HTML = '<!DOCTYPE html><html><body><p>Raw unique delta</p></body></html>';

beforeEach(() => {
  mount = document.createElement('div');
  document.body.append(mount);
  root = createRoot(mount);
  localStorage.clear();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  act(() => root.unmount());
  mount.remove();
  localStorage.clear();
  vi.restoreAllMocks();
});

type FileSpec = { type: 'markdown' | 'html' | 'csv'; content: string };

/**
 * 指定したファイル集合で SplitView を描画する。rootDir を渡すと absPath を付け、
 * 空文字なら公開構成相当、undefined なら absPath 自体を返さない旧サーバー相当。
 */
async function renderPanes(
  files: Record<string, FileSpec>,
  viewState: ViewState,
  rootDir?: string
) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/file?path=')) {
        const path = decodeURIComponent(url.slice('/api/file?path='.length));
        const file = files[path];
        if (!file) throw new Error(`unexpected fetch path: ${path}`);
        const extra: Record<string, unknown> = {};
        if (rootDir !== undefined) {
          extra.absPath = rootDir === '' ? '' : `${rootDir}/${path}`;
          extra.editorScheme = 'vscode';
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ path, type: file.type, content: file.content, ...extra }),
        } as Response);
      }
      throw new Error(`unexpected fetch: ${url}`);
    })
  );

  await act(async () => {
    root.render(<SplitView revision={1} viewState={viewState} onClosePane={() => {}} />);
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function panes(): { path: string; copyButtons: HTMLButtonElement[]; editorCount: number }[] {
  return Array.from(mount.querySelectorAll('.pane')).map((pane) => {
    const title = pane.querySelector('.pane-title')!;
    return {
      path: title.querySelector('.pane-title-path')!.textContent ?? '',
      copyButtons: Array.from(title.querySelectorAll<HTMLButtonElement>('button.pane-copy-content-btn')),
      editorCount: title.querySelectorAll('a.pane-open-editor-btn').length,
    };
  });
}

async function clickCopy(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
}

describe('ペインヘッダーのコピーボタン', () => {
  it('各ペインが自分の生ソースをコピーする', async () => {
    await renderPanes(
      {
        'docs/left.md': { type: 'markdown', content: LEFT_MD },
        'docs/right.md': { type: 'markdown', content: RIGHT_MD },
      },
      { left: 'docs/left.md', right: 'docs/right.md' },
      '/Users/me/work'
    );

    const shown = panes();
    expect(shown).toEqual([
      expect.objectContaining({ path: 'docs/left.md', editorCount: 1 }),
      expect.objectContaining({ path: 'docs/right.md', editorCount: 1 }),
    ]);
    expect(shown[0].copyButtons).toHaveLength(1);
    expect(shown[1].copyButtons).toHaveLength(1);

    await clickCopy(shown[0].copyButtons[0]);
    await clickCopy(shown[1].copyButtons[0]);

    expect(writeText).toHaveBeenNthCalledWith(1, LEFT_MD);
    expect(writeText).toHaveBeenNthCalledWith(2, RIGHT_MD);
    expect(writeText.mock.calls[0][0]).not.toContain('<h1');
    expect(writeText.mock.calls[1][0]).not.toContain('<h1');
  });

  it('htmlはレンダリング後ではなく生ソースをコピーする', async () => {
    await renderPanes(
      {
        'docs/left.html': { type: 'html', content: LEFT_HTML },
        'docs/right.html': { type: 'html', content: RIGHT_HTML },
      },
      { left: 'docs/left.html', right: 'docs/right.html' },
      '/Users/me/work'
    );

    const shown = panes();
    expect(shown[0].copyButtons).toHaveLength(1);
    expect(shown[1].copyButtons).toHaveLength(1);

    await clickCopy(shown[0].copyButtons[0]);
    await clickCopy(shown[1].copyButtons[0]);

    expect(writeText).toHaveBeenNthCalledWith(1, LEFT_HTML);
    expect(writeText).toHaveBeenNthCalledWith(2, RIGHT_HTML);
    expect(writeText.mock.calls[0][0]).not.toContain('data-source-line');
    expect(writeText.mock.calls[0][0]).not.toContain('data-mdmiel-style');
    expect(writeText.mock.calls[1][0]).not.toContain('data-source-line');
  });

  it('csvは表ではなく生ソースをコピーする', async () => {
    const raw = 'name,qty\npen,2\n';
    await renderPanes(
      { 'docs/items.csv': { type: 'csv', content: raw } },
      { path: 'docs/items.csv' },
      '/Users/me/work'
    );

    const shown = panes();
    expect(shown[0].copyButtons).toHaveLength(1);
    expect(mount.querySelector('.csv-table')).not.toBeNull();
    expect(mount.querySelector('.view-mode-switcher-track')).toBeNull();
    expect(mount.querySelector('.pane-add-comment-btn')).toBeNull();
    expect(mount.querySelector('.sticky-note-probe')).toBeNull();

    await clickCopy(shown[0].copyButtons[0]);
    expect(writeText).toHaveBeenCalledWith(raw);
    expect(writeText.mock.calls[0][0]).not.toContain('<table');
  });

  it('ボタンはファイルパスと同じ .pane-title の中、鉛筆の次に置かれる', async () => {
    await renderPanes(
      { 'docs/left.md': { type: 'markdown', content: LEFT_MD } },
      { path: 'docs/left.md' },
      '/Users/me/work'
    );

    const title = mount.querySelector('.pane-title')!;
    const actions = title.querySelector('.pane-title-file-actions');
    expect(actions).not.toBeNull();
    const children = Array.from(actions!.children);
    const editorIdx = children.findIndex((el) => el.classList.contains('pane-open-editor-btn'));
    const copyIdx = children.findIndex((el) => el.classList.contains('pane-copy-content-btn'));
    expect(editorIdx).toBeGreaterThanOrEqual(0);
    expect(copyIdx).toBe(editorIdx + 1);

    const titleChildren = Array.from(title.children);
    const pathIdx = titleChildren.findIndex((el) => el.classList.contains('pane-title-path'));
    const actionsIdx = titleChildren.findIndex((el) => el.classList.contains('pane-title-file-actions'));
    expect(pathIdx).toBeGreaterThanOrEqual(0);
    expect(actionsIdx).toBe(pathIdx + 1);
  });

  it('ファイル切替の途中で前のファイルのコピーボタンを残さない', async () => {
    await renderPanes(
      {
        'docs/left.md': { type: 'markdown', content: LEFT_MD },
        'docs/right.md': { type: 'markdown', content: RIGHT_MD },
      },
      { left: 'docs/left.md', right: 'docs/right.md' },
      '/Users/me/work'
    );
    expect(panes()[0].copyButtons).toHaveLength(1);

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
    expect(left.copyButtons).toHaveLength(0);
  });

  it('absPathが空 ( 公開構成 ) でもコピーボタンは描画する', async () => {
    await renderPanes(
      {
        'docs/left.md': { type: 'markdown', content: LEFT_MD },
        'docs/right.md': { type: 'markdown', content: RIGHT_MD },
      },
      { left: 'docs/left.md', right: 'docs/right.md' },
      ''
    );

    const shown = panes();
    expect(shown[0].copyButtons).toHaveLength(1);
    expect(shown[1].copyButtons).toHaveLength(1);
    expect(shown[0].editorCount).toBe(0);
    expect(shown[1].editorCount).toBe(0);

    await clickCopy(shown[0].copyButtons[0]);
    expect(writeText).toHaveBeenCalledWith(LEFT_MD);
  });

  it('成功するとtoastが出る', async () => {
    await renderPanes(
      { 'docs/left.md': { type: 'markdown', content: LEFT_MD } },
      { path: 'docs/left.md' },
      '/Users/me/work'
    );

    await clickCopy(panes()[0].copyButtons[0]);
    expect(mount.querySelector('.toast')?.textContent).toBe('内容をコピーしました');
  });

  it('writeTextが失敗すると失敗toastが出る', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await renderPanes(
      { 'docs/left.md': { type: 'markdown', content: LEFT_MD } },
      { path: 'docs/left.md' },
      '/Users/me/work'
    );

    await clickCopy(panes()[0].copyButtons[0]);
    expect(mount.querySelector('.toast')?.textContent).toBe('コピーに失敗しました');
    expect(errorSpy).toHaveBeenCalled();
  });

  it('clipboard APIが無いと失敗toastが出る', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await renderPanes(
      { 'docs/left.md': { type: 'markdown', content: LEFT_MD } },
      { path: 'docs/left.md' },
      '/Users/me/work'
    );

    await clickCopy(panes()[0].copyButtons[0]);
    expect(mount.querySelector('.toast')?.textContent).toBe('コピーに失敗しました');
    expect(errorSpy).toHaveBeenCalled();
  });

  it('アイコン表示でも用途が読み取れる名前を持つ', async () => {
    await renderPanes(
      { 'docs/left.md': { type: 'markdown', content: LEFT_MD } },
      { path: 'docs/left.md' },
      '/Users/me/work'
    );

    const button = panes()[0].copyButtons[0];
    expect(button.getAttribute('aria-label')).toBe('内容をコピー');
    expect(button.getAttribute('title')).toBe('内容をコピー');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.querySelector('span[aria-hidden="true"]')).not.toBeNull();
  });

  it('空ファイルでもボタンが出て空文字をコピーする', async () => {
    await renderPanes(
      { 'docs/empty.md': { type: 'markdown', content: '' } },
      { path: 'docs/empty.md' },
      '/Users/me/work'
    );

    const shown = panes();
    expect(shown[0].copyButtons).toHaveLength(1);
    await clickCopy(shown[0].copyButtons[0]);
    expect(writeText).toHaveBeenCalledWith('');
    expect(mount.querySelector('.toast')?.textContent).toBe('内容をコピーしました');
  });

  it('absPath/editorSchemeを返さない旧サーバーでもコピーボタンは描画する', async () => {
    await renderPanes(
      {
        'docs/left.md': { type: 'markdown', content: LEFT_MD },
        'docs/right.md': { type: 'markdown', content: RIGHT_MD },
      },
      { left: 'docs/left.md', right: 'docs/right.md' }
    );

    const shown = panes();
    expect(shown[0].copyButtons).toHaveLength(1);
    expect(shown[1].copyButtons).toHaveLength(1);
    expect(shown[0].editorCount).toBe(0);
    expect(shown[1].editorCount).toBe(0);

    await clickCopy(shown[0].copyButtons[0]);
    expect(writeText).toHaveBeenCalledWith(LEFT_MD);
  });
});
