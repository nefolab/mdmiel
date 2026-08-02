import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommentBody } from './CommentBody';

let root: Root;
let mount: HTMLDivElement;

beforeEach(() => {
  mount = document.createElement('div');
  document.body.append(mount);
  root = createRoot(mount);
  window.history.replaceState({}, '', '/');
  localStorage.clear();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  mount.remove();
  vi.restoreAllMocks();
});

function renderCommentBody(body: string, onParentClick?: () => void) {
  act(() => {
    root.render(
      <div onClick={onParentClick}>
        <CommentBody body={body} />
      </div>
    );
  });
}

function clickLink(link: HTMLAnchorElement, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...init,
  });
  act(() => {
    link.dispatchEvent(event);
  });
  return event;
}

describe('CommentBody', () => {
  it('renders a URL as a link whose href is the full original URL', () => {
    const url = 'https://example.com/path?query=1#result';
    renderCommentBody(`参照: ${url}`);

    const link = mount.querySelector<HTMLAnchorElement>('a')!;
    expect(link).not.toBeNull();
    expect(link.getAttribute('href')).toBe(url);
    expect(link.textContent).toBe(url);
  });

  it('opens an external link in a protected new tab', () => {
    renderCommentBody('https://example.com/path');

    const link = mount.querySelector<HTMLAnchorElement>('a')!;
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener noreferrer');
  });

  it('shows the parsed origin in the link title', () => {
    renderCommentBody('http://127.0.0.1@evil.com/#/view?path=a.md');

    const link = mount.querySelector<HTMLAnchorElement>('a')!;
    expect(link.title).toBe('http://evil.com');
  });

  it('does not add a target to an internal link', () => {
    const url = `${window.location.origin}/#/view?path=a.md`;
    renderCommentBody(url);

    const link = mount.querySelector<HTMLAnchorElement>('a')!;
    expect(link.getAttribute('target')).toBeNull();
    expect(link.getAttribute('rel')).toBeNull();
  });

  it('updates the current hash and prevents the default action for an internal link', () => {
    const targetHash = '#/view?path=a.md&line=42';
    renderCommentBody(`${window.location.origin}/${targetHash}`);

    const event = clickLink(mount.querySelector<HTMLAnchorElement>('a')!);

    expect(event.defaultPrevented).toBe(true);
    expect(window.location.hash).toBe(targetHash);
  });

  it('dispatches hashchange when an internal link targets the current hash', () => {
    const targetHash = '#/view?path=a.md&line=42';
    window.history.replaceState({}, '', targetHash);
    renderCommentBody(`${window.location.origin}/${targetHash}`);
    const onHashChange = vi.fn();
    window.addEventListener('hashchange', onHashChange);

    clickLink(mount.querySelector<HTMLAnchorElement>('a')!);

    expect(onHashChange).toHaveBeenCalledTimes(1);
    window.removeEventListener('hashchange', onHashChange);
  });

  // The synthetic event above only covers the same-hash case. For a different hash the
  // navigation depends on assigning window.location.hash and letting the browser fire
  // hashchange on its own — swap that assignment for history.replaceState and App would
  // never hear about the click. jsdom queues the event, hence the await.
  it('lets the browser fire hashchange when an internal link targets a different hash', async () => {
    window.history.replaceState({}, '', '#/view?path=other.md');
    // Earlier tests change the hash synchronously and never await, so their queued
    // hashchange events are still pending. Drain them before the spy goes on.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const targetHash = '#/view?path=a.md&line=42';
    renderCommentBody(`${window.location.origin}/${targetHash}`);
    const onHashChange = vi.fn();
    window.addEventListener('hashchange', onHashChange);

    clickLink(mount.querySelector<HTMLAnchorElement>('a')!);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.location.hash).toBe(targetHash);
    expect(onHashChange).toHaveBeenCalledTimes(1);
    window.removeEventListener('hashchange', onHashChange);
  });

  it('leaves a modified internal click to the browser', () => {
    const url = `${window.location.origin}/#/comment/abc`;
    renderCommentBody(url);

    const event = clickLink(mount.querySelector<HTMLAnchorElement>('a')!, { metaKey: true });

    expect(event.defaultPrevented).toBe(false);
  });

  it('stops a link click from propagating to the parent card', () => {
    const onParentClick = vi.fn();
    renderCommentBody('https://example.com/path', onParentClick);

    clickLink(mount.querySelector<HTMLAnchorElement>('a')!);

    expect(onParentClick).not.toHaveBeenCalled();
  });

  it('renders a body without URLs as unchanged text', () => {
    const body = '<strong>リンクなし</strong> のコメントです。';
    renderCommentBody(body);

    expect(mount.textContent).toBe(body);
    expect(mount.querySelector('a')).toBeNull();
    expect(mount.querySelector('strong')).toBeNull();
  });
});
