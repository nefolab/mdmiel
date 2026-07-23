import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useLiveReload } from './liveReload';

class MockEventSource {
  static instances: MockEventSource[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();

  constructor(public url: string) {
    MockEventSource.instances.push(this);
  }
}

function Probe() {
  return React.createElement('output', null, String(useLiveReload()));
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  root = undefined;
  container?.remove();
  container = undefined;
  MockEventSource.instances = [];
  vi.unstubAllGlobals();
});

describe('useLiveReload', () => {
  it('updates for newer revisions, ignores invalid/backward values, and closes on unmount', () => {
    vi.stubGlobal('EventSource', MockEventSource);
    // React's act warning is enabled by the test environment otherwise.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root?.render(React.createElement(Probe)));

    const stream = MockEventSource.instances[0];
    expect(stream.url).toBe('/api/events');
    expect(container.textContent).toBe('0');
    act(() => stream.onmessage?.({ data: '3' } as MessageEvent));
    expect(container.textContent).toBe('3');
    act(() => stream.onmessage?.({ data: '2' } as MessageEvent));
    act(() => stream.onmessage?.({ data: 'not-a-number' } as MessageEvent));
    expect(container.textContent).toBe('3');

    act(() => stream.onerror?.());
    expect(stream.close).not.toHaveBeenCalled();
    act(() => root?.unmount());
    expect(stream.close).toHaveBeenCalledTimes(1);
    root = undefined;
  });
});
