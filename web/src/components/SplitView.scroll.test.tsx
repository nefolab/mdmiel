import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SplitView } from './SplitView';

vi.mock('./StickyNoteLayer', () => ({
  StickyNoteLayer: () => <div className="sticky-note-probe" />,
}));

let root: Root;
let mount: HTMLDivElement;
/** [対象要素, プロパティ名, 代入された値] の記録 */
let scrollWrites: [Element, 'scrollTop' | 'scrollLeft', number][];
const originalDescriptors = {
  scrollTop: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop'),
  scrollLeft: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollLeft'),
};

/** 応答のtypeを切り替えられるfetchスタブ */
let fileType: 'markdown' | 'html' = 'markdown';

beforeEach(() => {
  mount = document.createElement('div');
  document.body.append(mount);
  root = createRoot(mount);
  localStorage.clear();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  // jsdomはレイアウトを持たず、代入した scrollTop が読み出すと0へ丸められる。
  // そのため「どの要素に何が代入されたか」をセッター側で記録して観測する
  scrollWrites = [];
  fileType = 'markdown';
  for (const prop of ['scrollTop', 'scrollLeft'] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get() {
        return 0;
      },
      set(value: number) {
        scrollWrites.push([this as Element, prop, value]);
      },
    });
  }

  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/file?path=')) {
        const path = decodeURIComponent(url.slice('/api/file?path='.length));
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            path,
            type: fileType,
            content: fileType === 'html' ? '<p>body</p>' : `# ${path}`,
          }),
        } as Response);
      }
      throw new Error(`unexpected fetch: ${url}`);
    })
  );
});

afterEach(() => {
  act(() => root.unmount());
  mount.remove();
  localStorage.clear();
  for (const prop of ['scrollTop', 'scrollLeft'] as const) {
    const original = originalDescriptors[prop];
    if (original) {
      Object.defineProperty(HTMLElement.prototype, prop, original);
    } else {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
    }
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(
  left: string,
  right: string | undefined,
  revision = 1,
  navNonce = 0
) {
  await act(async () => {
    root.render(
      <SplitView
        revision={revision}
        navNonce={navNonce}
        viewState={right ? { left, right } : { path: left }}
        onClosePane={() => {}}
      />
    );
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

/** 指定ペインの .pane-content に対する代入を [プロパティ, 値] で取り出す */
function resetCallsFor(paneIndex: number): [string, number][] {
  const pane = mount.querySelectorAll('.pane')[paneIndex];
  const content = pane.querySelector('.pane-content')!;
  return scrollWrites
    .filter(([el]) => el === content)
    .map(([, prop, value]) => [prop, value]);
}

describe('ペインのスクロール位置', () => {
  it('別のファイルを開いたら先頭へ戻す', async () => {
    await render('docs/a.md', 'docs/right.md');
    scrollWrites = [];

    await render('docs/b.md', 'docs/right.md');

    // 縦横の両方を戻すこと、そして最後の代入が0であること ( 途中で戻して
    // 直後に書き戻す実装を素通ししないため )
    expect(resetCallsFor(0)).toEqual([
      ['scrollTop', 0],
      ['scrollLeft', 0],
    ]);
  });

  it('左ペインの切替で右ペインは戻さない', async () => {
    await render('docs/a.md', 'docs/right.md');
    scrollWrites = [];

    await render('docs/b.md', 'docs/right.md');

    expect(resetCallsFor(1)).toHaveLength(0);
  });

  it('右ペインの切替で右ペインを戻す', async () => {
    await render('docs/a.md', 'docs/r1.md');
    scrollWrites = [];

    await render('docs/a.md', 'docs/r2.md');

    expect(resetCallsFor(1).length).toBeGreaterThan(0);
    expect(resetCallsFor(0)).toHaveLength(0);
  });

  it('HTMLペインでも切替時に外側コンテナを戻す', async () => {
    fileType = 'html';
    await render('docs/a.html', 'docs/right.html');
    scrollWrites = [];

    await render('docs/b.html', 'docs/right.html');

    // markdownのときだけリセットする実装を素通ししないため
    expect(resetCallsFor(0)).toEqual([
      ['scrollTop', 0],
      ['scrollLeft', 0],
    ]);
  });

  it('同じファイルへの再ナビゲーション ( navNonceのみ変化 ) では戻さない', async () => {
    await render('docs/a.md', 'docs/right.md', 1, 1);
    scrollWrites = [];

    await render('docs/a.md', 'docs/right.md', 1, 2);

    expect(resetCallsFor(0)).toHaveLength(0);
  });

  it('右ペインを閉じて別ファイルで開き直したら先頭から始まる', async () => {
    await render('docs/a.md', 'docs/r1.md');

    // 閉じる ( 単一ペイン表示に戻る )
    await render('docs/a.md', undefined);
    expect(mount.querySelectorAll('.pane')).toHaveLength(1);
    scrollWrites = [];

    await render('docs/a.md', 'docs/r2.md');

    expect(resetCallsFor(1)).toEqual([
      ['scrollTop', 0],
      ['scrollLeft', 0],
    ]);
  });

  it('ライブリロード ( revision変化 ) では位置を戻さない', async () => {
    await render('docs/a.md', 'docs/right.md', 1);
    scrollWrites = [];

    // 同じファイルのまま revision だけ進む = 編集して保存した状況
    await render('docs/a.md', 'docs/right.md', 2);

    expect(resetCallsFor(0)).toHaveLength(0);
    expect(resetCallsFor(1)).toHaveLength(0);
  });
});
