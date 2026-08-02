import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Comment, computeSnippet, snippetHash } from '../lib/comments';
import { ViewState } from '../lib/anchor';
import { SplitView } from './SplitView';

vi.mock('./StickyNoteLayer', () => ({
  StickyNoteLayer: ({ flashCommentId }: { flashCommentId?: string | null }) => (
    <div className="sticky-note-probe" data-flash-comment-id={flashCommentId ?? ''} />
  ),
}));

let root: Root | undefined;
let mount: HTMLDivElement | undefined;
let sequence = 0;
let resolveCreate: ((response: Response) => void) | undefined;
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');

function successfulJson(value: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => value,
  } as Response;
}

async function renderSplit(right = true) {
  await act(async () => {
    root?.render(
      <SplitView
        revision={1}
        viewState={right ? { left: 'left.html', right: 'right.html' } : { path: 'left.html' }}
        onClosePane={() => {}}
      />
    );
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function nonceOf(iframe: HTMLIFrameElement): string {
  const match = iframe.srcdoc.match(/var NONCE = "([^"]+)"/);
  if (!match) throw new Error('agent nonce not found in live iframe srcdoc');
  return match[1];
}

function sendAgentMessage(iframe: HTMLIFrameElement, type: string, extra: Record<string, unknown> = {}) {
  window.dispatchEvent(new MessageEvent('message', {
    source: iframe.contentWindow,
    data: { mdmiel: true, nonce: nonceOf(iframe), type, ...extra },
  }));
}

function openComposer(paneIndex: number) {
  const pane = mount!.querySelectorAll<HTMLElement>('.pane')[paneIndex];
  const iframe = pane.querySelector('iframe')!;
  const addButton = pane.querySelector<HTMLButtonElement>('.pane-add-comment-btn')!;
  act(() => addButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  act(() => sendAgentMessage(iframe, 'pick', {
    selector: '#target',
    snippet: 'Target',
    snippetHash: 'hash',
    rect: { top: 10, left: 20 },
  }));
  expect(mount!.querySelector('.comment-popover')).not.toBeNull();
  return iframe;
}

beforeEach(() => {
  mount = document.createElement('div');
  document.body.append(mount);
  root = createRoot(mount);
  sequence = 0;
  resolveCreate = undefined;
  localStorage.clear();
  localStorage.setItem('mdmiel-view-mode:left.html', 'live');
  localStorage.setItem('mdmiel-view-mode:right.html', 'live');
  vi.stubGlobal('crypto', { randomUUID: () => `nonce-${++sequence}` });
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/file?path=')) {
      const path = decodeURIComponent(url.slice('/api/file?path='.length));
      return Promise.resolve(successfulJson({
        path,
        type: 'html',
        content: '<button id="target">Target</button>',
      }));
    }
    if (url === '/api/comments' && init?.method === 'POST') {
      return new Promise<Response>((resolve) => {
        resolveCreate = resolve;
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  mount?.remove();
  mount = undefined;
  localStorage.clear();
  if (originalScrollIntoView) {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
  } else {
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('SplitView live navigation guard', () => {
  it('closes only the composer belonging to the pane that unloads', async () => {
    await renderSplit(true);
    const panes = mount!.querySelectorAll<HTMLElement>('.pane');
    const leftIframe = panes[0].querySelector('iframe')!;
    const rightIframe = openComposer(1);

    act(() => sendAgentMessage(leftIframe, 'unload'));
    expect(mount!.querySelector('.comment-popover')).not.toBeNull();
    expect(panes[0].querySelector('.live-nav-guard-banner')?.textContent).toContain(
      'モック内で画面遷移したためコメントを追加できません。'
    );
    expect(panes[0].querySelector<HTMLButtonElement>('.pane-add-comment-btn')?.disabled).toBe(true);

    const oldLeftNonce = nonceOf(leftIframe);
    act(() => panes[0].querySelector<HTMLButtonElement>('.live-nav-guard-banner button')?.click());
    const reloadedLeftIframe = panes[0].querySelector('iframe')!;
    expect(nonceOf(reloadedLeftIframe)).not.toBe(oldLeftNonce);
    expect(panes[0].querySelector('.live-nav-guard-banner')).toBeNull();
    expect(panes[0].querySelector<HTMLButtonElement>('.pane-add-comment-btn')?.disabled).toBe(false);
    expect(mount!.querySelector('.comment-popover')).not.toBeNull();

    act(() => sendAgentMessage(rightIframe, 'unload'));
    expect(mount!.querySelector('.comment-popover')).toBeNull();
  });

  it('closes a submitting composer and reports a later save failure when its pane unloads', async () => {
    await renderSplit(false);
    const iframe = openComposer(0);
    const textarea = mount!.querySelector<HTMLTextAreaElement>('.comment-popover-textarea')!;
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      valueSetter.call(textarea, 'send this');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const submit = mount!.querySelector<HTMLButtonElement>('.btn-primary')!;
    expect(submit.disabled).toBe(false);
    act(() => submit.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(submit.textContent).toBe('送信中...');

    act(() => sendAgentMessage(iframe, 'unload'));
    expect(mount!.querySelector('.comment-popover')).toBeNull();

    await act(async () => {
      resolveCreate?.({
        ok: false,
        status: 500,
        text: async () => 'storage unavailable',
      } as Response);
      await Promise.resolve();
    });
    expect(mount!.querySelector('.comment-popover')).toBeNull();
    expect(mount!.querySelector('.toast')?.textContent).toBe(
      'コメントの保存に失敗しました: storage unavailable'
    );
  });
});

const source = '# Target';

function focusComment(body = 'focus body'): Comment {
  const snippet = computeSnippet(source);
  return {
    version: 1,
    id: 'focus-id',
    path: 'target.md',
    anchor: { line: 1, snippet, snippetHash: snippetHash(snippet) },
    body,
    author: 'test',
    createdAt: '2026-08-02T00:00:00Z',
    resolved: false,
  };
}

function installMarkdownStubs() {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const path = decodeURIComponent(url.slice('/api/file?path='.length));
    return Promise.resolve(successfulJson({
      path,
      type: 'markdown',
      content: source,
    }));
  }));
}

function scheduledScrollCount(calls: readonly (readonly unknown[])[]): number {
  return calls.filter((call) => call[1] === 150).length;
}

async function renderFocusedSplitView(
  focusCommentId: string | undefined,
  comments: Comment[],
  onFocusHandled: () => void
) {
  await act(async () => {
    root?.render(
      <SplitView
        revision={1}
        viewState={{ path: 'target.md' }}
        onClosePane={() => {}}
        leftComments={comments}
        focusCommentId={focusCommentId}
        onFocusHandled={onFocusHandled}
      />
    );
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe('SplitView line navigation', () => {
  it.each([
    {
      name: 'left',
      viewState: { left: 'left.md', leftLine: 1, right: 'right.md' } satisfies ViewState,
    },
    {
      name: 'right',
      viewState: { left: 'left.md', right: 'right.md', rightLine: 1 } satisfies ViewState,
    },
  ])('scrolls the $name pane again when navNonce changes for the same line', async ({ viewState }) => {
    vi.useFakeTimers();
    installMarkdownStubs();
    const scrollIntoView = HTMLElement.prototype.scrollIntoView as ReturnType<typeof vi.fn>;

    await act(async () => {
      root?.render(
        <SplitView
          revision={1}
          viewState={viewState}
          navNonce={1}
          onClosePane={() => {}}
        />
      );
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    act(() => vi.advanceTimersByTime(150));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    await act(async () => {
      root?.render(
        <SplitView
          revision={1}
          viewState={viewState}
          navNonce={2}
          onClosePane={() => {}}
        />
      );
    });
    act(() => vi.advanceTimersByTime(150));

    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });
});

describe('SplitView comment focus guard', () => {
  it('runs again for the same id after focusCommentId returns to null', async () => {
    vi.useFakeTimers();
    installMarkdownStubs();
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
    const onFocusHandled = vi.fn();
    const comments = [focusComment()];

    await renderFocusedSplitView('focus-id', comments, onFocusHandled);
    expect(onFocusHandled).toHaveBeenCalledTimes(1);
    expect(mount!.querySelector('[data-flash-comment-id="focus-id"]')).not.toBeNull();
    expect(mount!.querySelector('[data-source-line="1"]')).not.toBeNull();
    expect(scheduledScrollCount(setTimeoutSpy.mock.calls)).toBe(1);

    await renderFocusedSplitView(undefined, comments, onFocusHandled);
    act(() => vi.advanceTimersByTime(3000));
    expect(mount!.querySelector('[data-flash-comment-id="focus-id"]')).toBeNull();

    await renderFocusedSplitView('focus-id', comments, onFocusHandled);
    expect(onFocusHandled).toHaveBeenCalledTimes(2);
    expect(mount!.querySelector('[data-flash-comment-id="focus-id"]')).not.toBeNull();
    expect(scheduledScrollCount(setTimeoutSpy.mock.calls)).toBe(2);
  });

  it('does not run again while the same id remains focused and another dependency changes', async () => {
    vi.useFakeTimers();
    installMarkdownStubs();
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
    const onFocusHandled = vi.fn();

    await renderFocusedSplitView('focus-id', [focusComment()], onFocusHandled);
    expect(mount!.querySelector('[data-source-line="1"]')).not.toBeNull();
    expect(onFocusHandled).toHaveBeenCalledTimes(1);
    expect(scheduledScrollCount(setTimeoutSpy.mock.calls)).toBe(1);

    await renderFocusedSplitView('focus-id', [focusComment('changed dependency')], onFocusHandled);
    expect(onFocusHandled).toHaveBeenCalledTimes(1);
    expect(scheduledScrollCount(setTimeoutSpy.mock.calls)).toBe(1);
  });
});
