import React, { act, useRef } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLiveAgentBridge, UseLiveAgentBridgeResult } from './useLiveAgentBridge';
import { Comment } from '../lib/comments';

const domComment: Comment = {
  version: 1, id: 'c1', path: 'page.html', body: 'note', author: 'test', createdAt: '', resolved: false,
  anchor: { line: 0, type: 'dom', selector: '#item', snippet: 'item', snippetHash: 'hash' },
};

const contentWindow = { postMessage: vi.fn() };
const onPick = vi.fn();
let root: Root | undefined;
let container: HTMLDivElement | undefined;
let bridge: UseLiveAgentBridgeResult | undefined;
let sequence = 0;

function Probe({ revision = 1 }: { revision?: number }) {
  const iframeRef = useRef<HTMLIFrameElement>({ contentWindow } as unknown as HTMLIFrameElement);
  const containerRef = useRef<HTMLDivElement>({
    getBoundingClientRect: () => new DOMRect(10, 20),
  } as unknown as HTMLDivElement);
  bridge = useLiveAgentBridge({
    revision,
    path: 'page.html',
    viewMode: 'live',
    data: { path: 'page.html' },
    comments: [domComment],
    iframeRef,
    containerRef,
    onPick,
  });
  return React.createElement('output', {
    'data-ready': String(bridge.agentReady),
    'data-measured': String(bridge.measured),
    'data-blocked': String(bridge.blocked),
    'data-can-comment': String(bridge.canComment),
    'data-armed': String(bridge.armed),
  }, bridge.nonce);
}

function mount(revision = 1) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(React.createElement(Probe, { revision })));
}

function output() {
  return container!.querySelector('output')! as HTMLOutputElement;
}

function dispatch(nonce: string, type: string, extra: Record<string, unknown> = {}) {
  window.dispatchEvent(new MessageEvent('message', {
    source: contentWindow as unknown as Window,
    data: { mdmiel: true, nonce, type, ...extra },
  }));
}

beforeEach(() => {
  sequence = 0;
  vi.stubGlobal('crypto', { randomUUID: () => `nonce-${++sequence}` });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  bridge = undefined;
  contentWindow.postMessage.mockReset();
  onPick.mockReset();
  vi.unstubAllGlobals();
});

describe('useLiveAgentBridge live navigation generation', () => {
  it('changes nonce, clears old ready state, and re-sends anchors/comment mode after a revision', () => {
    mount();
    const first = output().textContent!;
    act(() => dispatch(first, 'ready'));
    expect(output().dataset.ready).toBe('true');
    expect(contentWindow.postMessage).toHaveBeenCalledWith(expect.objectContaining({ nonce: first, type: 'anchors' }), '*');
    act(() => dispatch(first, 'unload'));
    expect(output().dataset.blocked).toBe('true');

    act(() => root?.render(React.createElement(Probe, { revision: 2 })));
    const second = output().textContent!;
    expect(second).not.toBe(first);
    expect(output().dataset.ready).toBe('false');
    expect(output().dataset.blocked).toBe('false');
    contentWindow.postMessage.mockClear();
    act(() => dispatch(second, 'ready'));
    expect(contentWindow.postMessage).toHaveBeenCalledWith(expect.objectContaining({ nonce: second, type: 'anchors' }), '*');
    expect(contentWindow.postMessage).toHaveBeenCalledWith(expect.objectContaining({ nonce: second, type: 'commentMode', on: false }), '*');
  });

  it('blocks on unload and synchronously rejects later messages from the same nonce', () => {
    mount();
    const nonce = output().textContent!;
    act(() => dispatch(nonce, 'ready'));
    act(() => dispatch(nonce, 'rects', {
      rects: [{ id: 'c1', found: true, rect: { top: 1, left: 2, width: 3, height: 4 }, visible: true }],
    }));
    act(() => bridge?.toggleArmed());
    expect(output().dataset.measured).toBe('true');
    expect(output().dataset.armed).toBe('true');

    act(() => {
      dispatch(nonce, 'unload');
      dispatch(nonce, 'ready');
      dispatch(nonce, 'rects', { rects: [] });
      dispatch(nonce, 'pick', {
        selector: '#item', snippet: 'item', snippetHash: 'hash', rect: { top: 1, left: 2 },
      });
    });

    expect(output().dataset.blocked).toBe('true');
    expect(output().dataset.canComment).toBe('false');
    expect(output().dataset.ready).toBe('false');
    expect(output().dataset.measured).toBe('false');
    expect(output().dataset.armed).toBe('false');
    expect(onPick).not.toHaveBeenCalled();
  });

  it('blocks when unload arrives before ready', () => {
    mount();
    const nonce = output().textContent!;
    expect(output().dataset.ready).toBe('false');
    act(() => dispatch(nonce, 'unload'));
    expect(output().dataset.blocked).toBe('true');
    expect(output().dataset.canComment).toBe('false');
  });

  it('sets measured on rects and clears it again on unload', () => {
    mount();
    const nonce = output().textContent!;
    expect(output().dataset.measured).toBe('false');
    act(() => dispatch(nonce, 'rects', { rects: [] }));
    expect(output().dataset.measured).toBe('true');
    act(() => dispatch(nonce, 'unload'));
    expect(output().dataset.measured).toBe('false');
  });

  it('reloads with a fresh nonce and accepts the new generation immediately', () => {
    mount();
    const first = output().textContent!;
    act(() => dispatch(first, 'unload'));
    expect(output().dataset.blocked).toBe('true');

    act(() => bridge?.reload());
    const second = output().textContent!;
    expect(second).not.toBe(first);
    expect(output().dataset.blocked).toBe('false');
    expect(output().dataset.canComment).toBe('true');

    act(() => dispatch(second, 'ready'));
    expect(output().dataset.ready).toBe('true');
    act(() => dispatch(second, 'rects', { rects: [] }));
    expect(output().dataset.measured).toBe('true');
  });
});
