import React, { act, useRef } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useLiveAgentBridge } from './useLiveAgentBridge';
import { Comment } from '../lib/comments';

const domComment: Comment = {
  version: 1, id: 'c1', path: 'page.html', body: 'note', author: 'test', createdAt: '', resolved: false,
  anchor: { line: 0, type: 'dom', selector: '#item', snippet: 'item', snippetHash: 'hash' },
};

const contentWindow = { postMessage: vi.fn() };
let root: Root | undefined;
let container: HTMLDivElement | undefined;

function Probe({ revision }: { revision: number }) {
  const iframeRef = useRef<HTMLIFrameElement>({ contentWindow } as unknown as HTMLIFrameElement);
  const containerRef = useRef<HTMLDivElement>({ getBoundingClientRect: () => new DOMRect() } as unknown as HTMLDivElement);
  const bridge = useLiveAgentBridge({
    revision,
    path: 'page.html',
    viewMode: 'live',
    data: { path: 'page.html' },
    comments: [domComment],
    iframeRef,
    containerRef,
    onPick: vi.fn(),
  });
  return React.createElement('output', { 'data-ready': String(bridge.agentReady) }, bridge.nonce);
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  contentWindow.postMessage.mockReset();
  vi.unstubAllGlobals();
});

describe('useLiveAgentBridge live reload generation', () => {
  it('changes nonce, clears old ready state, and re-sends anchors/comment mode after new ready', () => {
    let sequence = 0;
    vi.stubGlobal('crypto', { randomUUID: () => `nonce-${++sequence}` });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root?.render(React.createElement(Probe, { revision: 1 })));
    const first = container.textContent!;
    act(() => window.dispatchEvent(new MessageEvent('message', { source: contentWindow as unknown as Window, data: { mdmiel: true, nonce: first, type: 'ready' } })));
    expect(container.querySelector('output')?.dataset.ready).toBe('true');
    expect(contentWindow.postMessage).toHaveBeenCalledWith(expect.objectContaining({ nonce: first, type: 'anchors' }), '*');

    act(() => root?.render(React.createElement(Probe, { revision: 2 })));
    const second = container.textContent!;
    expect(second).not.toBe(first);
    expect(container.querySelector('output')?.dataset.ready).toBe('false');
    contentWindow.postMessage.mockClear();
    act(() => window.dispatchEvent(new MessageEvent('message', { source: contentWindow as unknown as Window, data: { mdmiel: true, nonce: second, type: 'ready' } })));
    expect(contentWindow.postMessage).toHaveBeenCalledWith(expect.objectContaining({ nonce: second, type: 'anchors' }), '*');
    expect(contentWindow.postMessage).toHaveBeenCalledWith(expect.objectContaining({ nonce: second, type: 'commentMode', on: false }), '*');
  });
});
