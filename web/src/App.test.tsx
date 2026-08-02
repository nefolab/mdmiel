import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

// App itself is the unit under test here: every child is stubbed so the assertions can
// watch what App hands down, not what the children render. SplitView is the only stub
// that reports anything back — the navNonce prop, which is what these tests are about.
vi.mock('./components/Sidebar', () => ({
  Sidebar: () => <div className="sidebar-probe" />,
}));
vi.mock('./components/CommentSidebar', () => ({
  CommentSidebar: () => <div className="comment-sidebar-probe" />,
}));
vi.mock('./components/SplitView', () => ({
  SplitView: ({ navNonce }: { navNonce?: number }) => (
    <div className="split-view-probe" data-nav-nonce={String(navNonce ?? '')} />
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

beforeEach(async () => {
  window.history.replaceState(null, '', '#');
  mount = document.createElement('div');
  document.body.appendChild(mount);
  root = createRoot(mount);
  await act(async () => {
    root!.render(<App />);
  });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  mount?.remove();
  root = undefined;
  mount = undefined;
  window.history.replaceState(null, '', '#');
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
});
