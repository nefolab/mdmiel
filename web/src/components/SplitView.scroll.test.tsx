import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SplitView } from './SplitView';

vi.mock('./StickyNoteLayer', () => ({
  StickyNoteLayer: () => <div className="sticky-note-probe" />,
}));

let root: Root;
let mount: HTMLDivElement;
/** [対象要素, 代入された値] の記録 */
let scrollTopWrites: [Element, number][];
const originalScrollTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop');

beforeEach(() => {
  mount = document.createElement('div');
  document.body.append(mount);
  root = createRoot(mount);
  localStorage.clear();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  // jsdomはレイアウトを持たず、代入した scrollTop が読み出すと0へ丸められる。
  // そのため「どの要素に何が代入されたか」をセッター側で記録して観測する
  scrollTopWrites = [];
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get() {
      return 0;
    },
    set(value: number) {
      scrollTopWrites.push([this as Element, value]);
    },
  });

  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/file?path=')) {
        const path = decodeURIComponent(url.slice('/api/file?path='.length));
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ path, type: 'markdown', content: `# ${path}` }),
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
  if (originalScrollTop) {
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', originalScrollTop);
  } else {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollTop;
  }
  vi.restoreAllMocks();
});

async function render(left: string, right: string, revision = 1) {
  await act(async () => {
    root.render(
      <SplitView
        revision={revision}
        viewState={{ left, right }}
        onClosePane={() => {}}
      />
    );
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

/** 指定ペインの .pane-content に対する scrollTop 代入だけを取り出す */
function resetCallsFor(paneIndex: number): number[] {
  const pane = mount.querySelectorAll('.pane')[paneIndex];
  const content = pane.querySelector('.pane-content')!;
  return scrollTopWrites.filter(([el]) => el === content).map(([, value]) => value);
}

describe('ペインのスクロール位置', () => {
  it('別のファイルを開いたら先頭へ戻す', async () => {
    await render('docs/a.md', 'docs/right.md');
    scrollTopWrites = [];

    await render('docs/b.md', 'docs/right.md');

    const calls = resetCallsFor(0);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]).toBe(0);
  });

  it('左ペインの切替で右ペインは戻さない', async () => {
    await render('docs/a.md', 'docs/right.md');
    scrollTopWrites = [];

    await render('docs/b.md', 'docs/right.md');

    expect(resetCallsFor(1)).toHaveLength(0);
  });

  it('右ペインの切替で右ペインを戻す', async () => {
    await render('docs/a.md', 'docs/r1.md');
    scrollTopWrites = [];

    await render('docs/a.md', 'docs/r2.md');

    expect(resetCallsFor(1).length).toBeGreaterThan(0);
    expect(resetCallsFor(0)).toHaveLength(0);
  });

  it('ライブリロード ( revision変化 ) では位置を戻さない', async () => {
    await render('docs/a.md', 'docs/right.md', 1);
    scrollTopWrites = [];

    // 同じファイルのまま revision だけ進む = 編集して保存した状況
    await render('docs/a.md', 'docs/right.md', 2);

    expect(resetCallsFor(0)).toHaveLength(0);
    expect(resetCallsFor(1)).toHaveLength(0);
  });
});
