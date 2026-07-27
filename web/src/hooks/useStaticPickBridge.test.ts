import React, { act, useRef } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildDomAnchorPick } from '../lib/domAnchor';
import { useStaticPickBridge, UseStaticPickBridgeResult } from './useStaticPickBridge';

let root: Root | undefined;
let mount: HTMLDivElement | undefined;
let bridge: UseStaticPickBridgeResult | undefined;
let iframeRef: React.MutableRefObject<HTMLIFrameElement | null>;
let iframe: HTMLIFrameElement;
let iframeDoc: Document;
const frames: HTMLIFrameElement[] = [];
const onPick = vi.fn();

function makeIframe(url = 'about:srcdoc') {
  const next = document.createElement('iframe');
  document.body.append(next);
  frames.push(next);
  const doc = next.contentDocument!;
  Object.defineProperty(doc, 'URL', { configurable: true, value: url });
  return { iframe: next, doc };
}

function Probe({ path = 'page.html', revision = 1, viewMode = 'static' }: { path?: string; revision?: number; viewMode?: 'static' | 'live' }) {
  const containerRef = useRef<HTMLDivElement>({ getBoundingClientRect: () => new DOMRect(10, 20) } as unknown as HTMLDivElement);
  bridge = useStaticPickBridge({ path, revision, viewMode, data: { path }, iframeRef, containerRef, onPick });
  return React.createElement('output', { 'data-armed': String(bridge.armed), 'data-disabled': String(bridge.disabled) });
}

function render(props = {}) {
  ({ iframe, doc: iframeDoc } = makeIframe());
  Object.defineProperty(iframe, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect(30, 40) });
  iframeRef = { current: iframe };
  mount = document.createElement('div'); document.body.append(mount); root = createRoot(mount);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  act(() => root?.render(React.createElement(Probe, props)));
  act(() => bridge?.handleIframeLoad());
}

function event(type: string, target: EventTarget) {
  const EventCtor = iframeDoc.defaultView!.Event;
  const e = new EventCtor(type, { bubbles: true, cancelable: true });
  act(() => target.dispatchEvent(e));
  return e;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined; mount?.remove(); mount = undefined; bridge = undefined;
  for (const frame of frames.splice(0)) frame.remove();
  onPick.mockReset(); vi.unstubAllGlobals();
});

describe('useStaticPickBridge', () => {
  it('uses an iframe document from another realm', () => {
    render(); const target = iframeDoc.createElement('div');
    expect(target instanceof Element).toBe(false);
    iframeDoc.body.append(target);
    act(() => bridge?.toggleArmed()); event('click', target);
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it('leaves unarmed documents unchanged', () => {
    render(); iframeDoc.body.innerHTML = '<a href="#x">link</a>';
    const e = event('click', iframeDoc.querySelector('a')!);
    expect(e.defaultPrevented).toBe(false); expect(onPick).not.toHaveBeenCalled();
  });

  it('picks elements with a DOM anchor and disarms', () => {
    render(); iframeDoc.body.innerHTML = '<div id="target"> hello </div>';
    const target = iframeDoc.getElementById('target')!;
    act(() => bridge?.toggleArmed()); event('click', target);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0]).toMatchObject({ path: 'page.html', top: 20, left: 20, ...buildDomAnchorPick(target)! });
    expect(bridge?.armed).toBe(false);
  });

  it('prevents links and guarded mouse/form events while armed, but permits wheel', () => {
    render(); iframeDoc.body.innerHTML = '<a href="#x">link</a><form></form>';
    act(() => bridge?.toggleArmed()); expect(event('click', iframeDoc.querySelector('a')!).defaultPrevented).toBe(true);
    for (const type of ['contextmenu', 'mousedown', 'dragstart', 'auxclick']) {
      act(() => bridge?.toggleArmed()); expect(event(type, iframeDoc.body).defaultPrevented).toBe(true); act(() => bridge?.toggleArmed());
    }
    act(() => bridge?.toggleArmed()); expect(event('submit', iframeDoc.querySelector('form')!).defaultPrevented).toBe(true);
    expect(event('wheel', iframeDoc.body).defaultPrevented).toBe(false);
  });

  it('keeps mode armed for html/body targets', () => {
    render(); act(() => bridge?.toggleArmed());
    event('click', iframeDoc.body); expect(onPick).not.toHaveBeenCalled(); expect(bridge?.armed).toBe(true);
    event('click', iframeDoc.documentElement); expect(onPick).not.toHaveBeenCalled(); expect(bridge?.armed).toBe(true);
  });

  it('does not duplicate listeners and moves them to a replaced iframe document', () => {
    render(); iframeDoc.body.innerHTML = '<div>old</div>'; const old = iframeDoc;
    act(() => bridge?.handleIframeLoad()); act(() => bridge?.toggleArmed()); event('click', old.querySelector('div')!);
    expect(onPick).toHaveBeenCalledTimes(1); onPick.mockClear();
    const next = makeIframe(); next.doc.body.innerHTML = '<div>next</div>'; iframeRef.current = next.iframe;
    act(() => bridge?.handleIframeLoad()); act(() => bridge?.toggleArmed()); event('click', old.querySelector('div')!);
    iframeDoc = next.doc; event('click', next.doc.querySelector('div')!);
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it('disarms independently for path and revision changes while static', () => {
    render(); act(() => bridge?.toggleArmed()); act(() => root?.render(React.createElement(Probe, { path: 'other.html' })));
    expect(bridge?.armed).toBe(false);
    act(() => bridge?.toggleArmed()); act(() => root?.render(React.createElement(Probe, { path: 'other.html', revision: 2 })));
    expect(bridge?.armed).toBe(false);
  });

  it('detaches listeners on view-mode change and unmount', () => {
    render(); iframeDoc.body.innerHTML = '<div>target</div>'; const target = iframeDoc.querySelector('div')!;
    act(() => bridge?.toggleArmed()); act(() => root?.render(React.createElement(Probe, { viewMode: 'live' })));
    expect(event('click', target).defaultPrevented).toBe(false);
    act(() => root?.render(React.createElement(Probe, { viewMode: 'static' }))); act(() => bridge?.handleIframeLoad());
    act(() => bridge?.toggleArmed()); act(() => root?.unmount()); expect(event('click', target).defaultPrevented).toBe(false); expect(onPick).not.toHaveBeenCalled();
  });

  it('applies and clears hover styling', () => {
    render(); iframeDoc.body.innerHTML = '<div>target</div>'; const target = iframeDoc.querySelector('div') as HTMLElement;
    act(() => bridge?.toggleArmed()); event('mouseover', target); expect(target.style.outline).toContain('rgba');
    event('mouseout', target); expect(target.style.outline).toBe(''); event('mouseover', target); act(() => bridge?.toggleArmed()); expect(target.style.outline).toBe('');
  });

  it('disables itself only for a navigated document', () => {
    render(); const navigated = makeIframe('https://example.test/other.html'); navigated.doc.body.innerHTML = '<div>target</div>'; iframeRef.current = navigated.iframe;
    act(() => bridge?.toggleArmed()); act(() => bridge?.handleIframeLoad());
    expect(bridge?.disabled).toBe(true); expect(bridge?.armed).toBe(false); iframeDoc = navigated.doc; event('click', navigated.doc.querySelector('div')!); expect(onPick).not.toHaveBeenCalled();
  });
});
