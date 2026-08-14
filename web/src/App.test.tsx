import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { getComment, listComments } from './lib/commentsApi';
import { Comment } from './lib/comments';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// App itself is the unit under test here: every child is stubbed so the assertions can
// watch what App hands down, not what the children render. SplitView is the only stub
// that reports anything back — the navNonce prop, which is what these tests are about.
vi.mock('./components/Sidebar', () => ({
  Sidebar: ({ sidebarOpen, query }: { sidebarOpen: boolean; query: string }) => (
    <aside
      id="file-sidebar"
      className={`sidebar-probe ${sidebarOpen ? '' : 'collapsed'}`}
      data-query={query}
    />
  ),
}));
vi.mock('./components/CommentSidebar', () => ({
  CommentSidebar: () => <div className="comment-sidebar-probe" />,
}));
vi.mock('./components/SplitView', () => ({
  SplitView: ({ navNonce, leftComments }: { navNonce?: number; leftComments?: Comment[] }) => (
    <div
      className="split-view-probe"
      data-nav-nonce={String(navNonce ?? '')}
      data-left-comments={String(leftComments?.length ?? 0)}
    />
  ),
}));
vi.mock('./lib/liveReload', () => ({
  useLiveReload: () => 0,
}));
vi.mock('./lib/commentsApi', () => ({
  listComments: vi.fn(async () => []),
  getComment: vi.fn(),
}));

let root: Root | undefined;
let mount: HTMLDivElement | undefined;

function currentNavNonce(): string {
  const probe = mount?.querySelector('.split-view-probe');
  return probe?.getAttribute('data-nav-nonce') ?? '';
}

/**
 * Mirrors a browser hash navigation with exactly one hashchange.
 *
 * Assigning window.location.hash makes jsdom queue its own hashchange asynchronously,
 * which lands outside the act() window and leaks into the next test. replaceState changes
 * the URL without firing anything, so dispatching the event by hand keeps the count exact.
 */
async function navigate(hash: string) {
  window.history.replaceState(null, '', hash);
  await act(async () => {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

/** Lets jsdom's own queued hashchange (from a location.hash assignment) reach the listener. */
async function flushNativeHashChange() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mountApp() {
  mount = document.createElement('div');
  document.body.appendChild(mount);
  root = createRoot(mount);
  await act(async () => {
    root!.render(<App />);
  });
}

async function unmountApp() {
  await act(async () => {
    root?.unmount();
  });
  mount?.remove();
  root = undefined;
  mount = undefined;
}

beforeEach(async () => {
  vi.mocked(getComment).mockReset();
  // A rejecting listComments left over from an error test would otherwise leak into the
  // next one, so the default (an empty list) is restored per test.
  vi.mocked(listComments).mockReset();
  vi.mocked(listComments).mockResolvedValue([]);
  localStorage.clear();
  window.history.replaceState(null, '', '#');
  await mountApp();
});

afterEach(async () => {
  await unmountApp();
  window.history.replaceState(null, '', '#');
});

function sidebarProbe(): HTMLElement {
  return mount!.querySelector<HTMLElement>('.sidebar-probe')!;
}

function sidebarToggle(): HTMLButtonElement {
  return mount!.querySelector<HTMLButtonElement>('[aria-controls="file-sidebar"]')!;
}

function searchInput(): HTMLInputElement {
  return mount!.querySelector<HTMLInputElement>('input[aria-label="ファイルを検索"]')!;
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function typeSearch(value: string) {
  act(() => {
    const input = searchInput();
    const nativeValueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )?.set;
    nativeValueSetter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('App header', () => {
  it('ロゴのアイコンとラベルを描画しない', () => {
    expect(mount?.querySelector('.logo-icon')).toBeNull();
    expect(mount?.querySelector('.logo-title')).toBeNull();
    expect(mount?.textContent).not.toContain('📝');
  });

  it('localStorageに保存された閉じた状態を初回描画で復元する', async () => {
    await unmountApp();
    localStorage.clear();
    localStorage.setItem('mdmiel-sidebar-open', 'false');
    await mountApp();

    expect(sidebarProbe().classList.contains('collapsed')).toBe(true);
    expect(sidebarToggle().getAttribute('aria-expanded')).toBe('false');
  });

  it('開閉ボタンでサイドバーの表示を切り替える', () => {
    expect(sidebarProbe().classList.contains('collapsed')).toBe(false);
    expect(sidebarToggle().getAttribute('aria-expanded')).toBe('true');
    expect(sidebarToggle().getAttribute('aria-label')).toBe('サイドバーの表示切替');
    expect(sidebarToggle().querySelector('span')?.getAttribute('aria-hidden')).toBe('true');

    click(sidebarToggle());

    expect(sidebarProbe().classList.contains('collapsed')).toBe(true);
    expect(sidebarToggle().getAttribute('aria-expanded')).toBe('false');
  });

  it('開閉状態をlocalStorageに永続化する', () => {
    click(sidebarToggle());
    expect(localStorage.getItem('mdmiel-sidebar-open')).toBe('false');

    click(sidebarToggle());
    expect(localStorage.getItem('mdmiel-sidebar-open')).toBe('true');
  });

  it('検索ボックスの入力をサイドバーに渡す', () => {
    typeSearch('docs');
    expect(sidebarProbe().dataset.query).toBe('docs');
  });

  it('閉じた状態で検索するとサイドバーを自動で開く', () => {
    click(sidebarToggle());
    expect(sidebarProbe().classList.contains('collapsed')).toBe(true);

    typeSearch('spec');

    expect(sidebarProbe().classList.contains('collapsed')).toBe(false);
    expect(sidebarToggle().getAttribute('aria-expanded')).toBe('true');
    expect(localStorage.getItem('mdmiel-sidebar-open')).toBe('false');
  });

  it('閉じた状態で検索語を空にしてもサイドバーを開かない', () => {
    typeSearch('spec');
    click(sidebarToggle());
    expect(sidebarProbe().classList.contains('collapsed')).toBe(true);

    typeSearch('');

    expect(sidebarProbe().classList.contains('collapsed')).toBe(true);
    expect(sidebarToggle().getAttribute('aria-expanded')).toBe('false');
  });

  it('閉じた状態で空白だけを入力してもサイドバーを開かない', () => {
    click(sidebarToggle());
    expect(sidebarProbe().classList.contains('collapsed')).toBe(true);

    typeSearch('   ');

    expect(sidebarProbe().classList.contains('collapsed')).toBe(true);
    expect(sidebarToggle().getAttribute('aria-expanded')).toBe('false');
  });
});

describe('App navNonce', () => {
  it('counts the initial hash processing', () => {
    expect(currentNavNonce()).toBe('1');
  });

  it('increments when the hash changes to a different view route', async () => {
    await navigate('#/view?path=a.md&line=3');
    expect(currentNavNonce()).toBe('2');

    await navigate('#/view?path=b.md&line=7');
    expect(currentNavNonce()).toBe('3');
  });

  // The reason navNonce exists: re-clicking a link whose hash is already current produces
  // an identical ViewState, so every dependency of SplitView's scroll effects stays equal
  // and the scroll never re-runs. Without this increment the second click does nothing.
  it('increments even when the hash is re-processed unchanged', async () => {
    await navigate('#/view?path=a.md&line=3');
    expect(currentNavNonce()).toBe('2');

    await act(async () => {
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(currentNavNonce()).toBe('3');
  });

  // "#/comment/<id>" is a two-step route: App resolves the comment, then rewrites the hash
  // to "#/view?path=...", which is the step that actually changes what's on screen. Counting
  // the comment route as well would re-run the scroll effects for the page being left.
  describe('comment route', () => {
    it('does not count the comment route while the lookup is still pending', async () => {
      vi.mocked(getComment).mockReturnValue(new Promise(() => {}));

      await navigate('#/comment/abc');

      expect(currentNavNonce()).toBe('1');
    });

    it('counts exactly once, when the resolved comment redirects to a view route', async () => {
      let resolveComment: ((comment: Comment) => void) | undefined;
      vi.mocked(getComment).mockReturnValue(
        new Promise<Comment>((resolve) => {
          resolveComment = resolve;
        })
      );

      await navigate('#/comment/abc');
      expect(currentNavNonce()).toBe('1');

      await act(async () => {
        // A line anchor (no `type`), so App takes the plain redirect path rather than
        // forcing the target file into live view mode the way a dom anchor would.
        resolveComment!({
          version: 1,
          id: 'abc',
          path: 'a.md',
          body: 'x',
          author: 'me',
          createdAt: '',
          resolved: false,
          anchor: { line: 3, snippet: '', snippetHash: '' },
        });
      });
      // App assigned window.location.hash; jsdom queues the hashchange, so wait for it.
      await flushNativeHashChange();

      expect(window.location.hash).toBe('#/view?path=a.md');
      expect(currentNavNonce()).toBe('2');
    });
  });
});

// コメント取得の失敗はconsole.errorだけで、画面上は「コメントが0件のファイル」と
// 区別が付かなかった ( 2026-08-15の実バグ )。付箋が出ない理由を利用者に見せることを固定する。
describe('App comment loading errors', () => {
  function errorBanner(): HTMLElement | null {
    return mount!.querySelector<HTMLElement>('.app-error-banner');
  }

  function leftCommentCount(): string {
    return mount!.querySelector('.split-view-probe')?.getAttribute('data-left-comments') ?? '';
  }

  const comment = (id: string, path: string): Comment => ({
    version: 1,
    id,
    path,
    body: 'x',
    author: 'me',
    createdAt: '',
    resolved: false,
    anchor: { line: 1, snippet: '', snippetHash: '' },
  });

  it('コメント取得に失敗したらエラーを表示する', async () => {
    vi.mocked(listComments).mockRejectedValue(new Error('network down'));

    await navigate('#/view?path=a.md');
    await flushNativeHashChange();

    expect(errorBanner()).not.toBeNull();
    expect(errorBanner()!.textContent).toContain('コメントの取得に失敗しました');
    expect(errorBanner()!.getAttribute('role')).toBe('alert');
  });

  it('取得に失敗したペインに前のファイルの付箋を残さない', async () => {
    vi.mocked(listComments).mockResolvedValue([comment('c1', 'a.md')]);
    await navigate('#/view?path=a.md');
    await flushNativeHashChange();
    expect(leftCommentCount()).toBe('1');

    vi.mocked(listComments).mockRejectedValue(new Error('network down'));
    await navigate('#/view?path=b.md');
    await flushNativeHashChange();

    // 別ファイルの付箋が残ると、b.mdに存在しないコメントを表示してしまう
    expect(leftCommentCount()).toBe('0');
    expect(errorBanner()).not.toBeNull();
  });

  it('再取得に成功したらエラー表示を消す', async () => {
    vi.mocked(listComments).mockRejectedValue(new Error('network down'));
    await navigate('#/view?path=a.md');
    await flushNativeHashChange();
    expect(errorBanner()).not.toBeNull();

    vi.mocked(listComments).mockResolvedValue([comment('c1', 'b.md')]);
    await navigate('#/view?path=b.md');
    await flushNativeHashChange();

    expect(errorBanner()).toBeNull();
    expect(leftCommentCount()).toBe('1');
  });

  it('コメントリンクの解決に失敗したらエラーを表示する', async () => {
    vi.mocked(getComment).mockRejectedValue(new Error('not found'));

    await navigate('#/comment/missing');
    await flushNativeHashChange();

    expect(errorBanner()).not.toBeNull();
    expect(errorBanner()!.textContent).toContain('コメントへのリンクを開けませんでした');
  });

  // 取得が終わるまで前のファイルの付箋を渡し続けると、SplitViewはそれを現在の文書上に
  // 配置してしまう ( 別文書のコメントが貼られて見える )。失敗時だけでなく、切替した瞬間に
  // 空にすることを固定する。
  it('切替直後の取得中に前のファイルの付箋を渡さない', async () => {
    vi.mocked(listComments).mockResolvedValue([comment('c1', 'a.md')]);
    await navigate('#/view?path=a.md');
    await flushNativeHashChange();
    expect(leftCommentCount()).toBe('1');

    // b.mdの取得を未完了のまま保留する
    vi.mocked(listComments).mockReturnValue(new Promise(() => {}));
    await navigate('#/view?path=b.md');
    await flushNativeHashChange();

    expect(leftCommentCount()).toBe('0');
  });

  // 2つのエラー発生源が同じ状態を共有していると、無関係な成功が直前のリンクエラーを
  // 消してしまう。発生源ごとに独立していることを固定する。
  it('ペイン取得の成功でコメントリンクのエラーを消さない', async () => {
    let resolveList: ((comments: Comment[]) => void) | undefined;
    vi.mocked(listComments).mockReturnValue(
      new Promise<Comment[]>((resolve) => {
        resolveList = resolve;
      })
    );
    await navigate('#/view?path=a.md');
    await flushNativeHashChange();

    // 保留中に、解決できないコメントリンクへ移動する
    vi.mocked(getComment).mockRejectedValue(new Error('not found'));
    await navigate('#/comment/missing');
    await flushNativeHashChange();
    expect(errorBanner()?.textContent).toContain('コメントへのリンクを開けませんでした');

    // 保留していたペイン取得が後から成功しても、リンクのエラーは残る
    await act(async () => {
      resolveList!([]);
    });
    await flushNativeHashChange();

    expect(errorBanner()?.textContent).toContain('コメントへのリンクを開けませんでした');
  });
});
