import { describe, it, expect } from 'vitest';
import { renderAgentScript } from './agent';

function waitForMutations() {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

function sendCommentMode(nonce: string, on: boolean) {
  window.dispatchEvent(new MessageEvent('message', {
    data: { nonce, type: 'commentMode', on },
    origin: window.location.origin,
  }));
}

function runAgent(nonce: string, allowSyntheticPick = false) {
  let script = renderAgentScript(nonce);
  // jsdom cannot create trusted events. Keep the real guard covered separately and only
  // bypass it here when an integration test must exercise the post-trust pick lifecycle.
  if (allowSyntheticPick) script = script.replace('if (isPickEvent(e)) sendPickAt(e.clientX, e.clientY);', 'sendPickAt(e.clientX, e.clientY);');
  // eslint-disable-next-line no-new-func
  new Function(script)();
}

describe('comment-mode overlay lifecycle', () => {
  it('inserts the overlay while armed and removes it when disarmed', () => {
    const nonce = 'overlay-lifecycle-1';
    runAgent(nonce);

    sendCommentMode(nonce, true);
    const overlay = document.querySelector<HTMLElement>('[data-mdmiel-overlay]');
    expect(overlay).not.toBeNull();
    expect(overlay!.parentNode).toBe(document.documentElement);
    expect(overlay!.getAttribute('aria-hidden')).toBe('true');

    sendCommentMode(nonce, false);
    expect(document.querySelector('[data-mdmiel-overlay]')).toBeNull();
  });

  it('picks the hit-tested element once and blocks later document capture listeners', async () => {
    const nonce = 'overlay-pick-2';
    document.body.innerHTML = '<button id="target">Pick me</button>';
    const target = document.getElementById('target')!;
    const descriptor = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => target });
    const picks: unknown[] = [];
    let mockCaptureCalled = false;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.nonce === nonce && event.data?.type === 'pick') picks.push(event.data);
    };
    const mockCapture = () => { mockCaptureCalled = true; };
    window.addEventListener('message', onMessage);
    try {
      runAgent(nonce, true);
      document.addEventListener('click', mockCapture, true);
      sendCommentMode(nonce, true);
      target.dispatchEvent(new MouseEvent('click', { clientX: 12, clientY: 34, bubbles: true, cancelable: true }));
      sendCommentMode(nonce, true);
      target.dispatchEvent(new MouseEvent('click', { clientX: 12, clientY: 34, bubbles: true, cancelable: true }));

      await waitForMutations();

      expect(picks).toHaveLength(1);
      expect((picks[0] as { selector: string }).selector).toBe('#target');
      expect(mockCaptureCalled).toBe(false);
    } finally {
      sendCommentMode(nonce, false);
      window.removeEventListener('message', onMessage);
      document.removeEventListener('click', mockCapture, true);
      if (descriptor) Object.defineProperty(document, 'elementFromPoint', descriptor);
      else Reflect.deleteProperty(document, 'elementFromPoint');
    }
  });

  it('re-inserts an overlay removed while comment mode remains armed', async () => {
    const nonce = 'overlay-reinsert-3';
    runAgent(nonce);
    sendCommentMode(nonce, true);
    const overlay = document.querySelector('[data-mdmiel-overlay]')!;
    overlay.parentNode!.removeChild(overlay);

    await waitForMutations();
    expect(document.querySelector('[data-mdmiel-overlay]')).toBe(overlay);
    expect(overlay.parentNode).toBe(document.documentElement);
    sendCommentMode(nonce, false);
  });

  it('filters overlay-only mutations but resolves anchors for mixed mutation batches', async () => {
    const nonce = 'overlay-mutations-4';
    document.body.innerHTML = '<div id="target">Target</div>';
    const target = document.getElementById('target')!;
    const rectMessages: unknown[] = [];
    const onMessage = (event: MessageEvent) => {
      if (event.data?.nonce === nonce && event.data?.type === 'rects') rectMessages.push(event.data);
    };
    window.addEventListener('message', onMessage);
    try {
      runAgent(nonce);
      sendCommentMode(nonce, true);
      window.dispatchEvent(new MessageEvent('message', {
        data: { nonce, type: 'anchors', anchors: [{ id: 'a', selector: '#target', snippet: 'Target', snippetHash: 'x' }] },
        origin: window.location.origin,
      }));
      await waitForMutations();
      rectMessages.length = 0;

      const overlay = document.querySelector<HTMLElement>('[data-mdmiel-overlay]')!;
      overlay.style.setProperty('pointer-events', 'none', 'important');
      await waitForMutations();
      expect(rectMessages).toHaveLength(0);

      overlay.style.setProperty('pointer-events', 'auto', 'important');
      target.setAttribute('data-mixed-change', 'yes');
      await waitForMutations();
      expect(rectMessages.length).toBeGreaterThan(0);
    } finally {
      sendCommentMode(nonce, false);
      window.removeEventListener('message', onMessage);
    }
  });

  it('does not pick an untrusted or coordinate-less click', async () => {
    const nonce = 'overlay-untrusted-click-5';
    document.body.innerHTML = '<button id="target">Pick me</button>';
    const target = document.getElementById('target')!;
    const descriptor = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => target });
    const picks: unknown[] = [];
    const onMessage = (event: MessageEvent) => {
      if (event.data?.nonce === nonce && event.data?.type === 'pick') picks.push(event.data);
    };
    window.addEventListener('message', onMessage);
    try {
      runAgent(nonce);
      sendCommentMode(nonce, true);
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await waitForMutations();
      expect(picks).toHaveLength(0);
    } finally {
      sendCommentMode(nonce, false);
      window.removeEventListener('message', onMessage);
      if (descriptor) Object.defineProperty(document, 'elementFromPoint', descriptor);
      else Reflect.deleteProperty(document, 'elementFromPoint');
    }
  });

  it('allows another pick after disarming and re-arming', async () => {
    const nonce = 'overlay-rearm-pick-6';
    document.body.innerHTML = '<button id="target">Pick me</button>';
    const target = document.getElementById('target')!;
    const descriptor = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => target });
    const picks: unknown[] = [];
    const onMessage = (event: MessageEvent) => {
      if (event.data?.nonce === nonce && event.data?.type === 'pick') picks.push(event.data);
    };
    window.addEventListener('message', onMessage);
    try {
      runAgent(nonce, true);
      sendCommentMode(nonce, true);
      target.dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true, cancelable: true }));
      await waitForMutations();
      sendCommentMode(nonce, false);
      sendCommentMode(nonce, true);
      target.dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true, cancelable: true }));
      await waitForMutations();
      expect(picks).toHaveLength(2);
    } finally {
      sendCommentMode(nonce, false);
      window.removeEventListener('message', onMessage);
      if (descriptor) Object.defineProperty(document, 'elementFromPoint', descriptor);
      else Reflect.deleteProperty(document, 'elementFromPoint');
    }
  });

  it('highlights the current hit-tested element and restores the previous one', async () => {
    const nonce = 'overlay-hover-7';
    document.body.innerHTML = '<div id="first"></div><div id="second"></div>';
    const first = document.getElementById('first')!;
    const second = document.getElementById('second')!;
    const descriptor = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: (x: number) => x === 10 ? first : second,
    });
    try {
      runAgent(nonce);
      sendCommentMode(nonce, true);
      first.dispatchEvent(new MouseEvent('mousemove', { clientX: 10, clientY: 20, bubbles: true }));
      await waitForMutations();
      expect(first.style.outline).toContain('2px');
      expect(first.style.outlineOffset).toBe('-2px');
      expect(first.style.backgroundColor).toContain('rgba');

      second.dispatchEvent(new MouseEvent('mousemove', { clientX: 30, clientY: 20, bubbles: true }));
      await waitForMutations();
      expect(first.style.outline).toBe('');
      expect(first.style.outlineOffset).toBe('');
      expect(first.style.backgroundColor).toBe('');
      expect(second.style.outline).toContain('2px');
    } finally {
      sendCommentMode(nonce, false);
      if (descriptor) Object.defineProperty(document, 'elementFromPoint', descriptor);
      else Reflect.deleteProperty(document, 'elementFromPoint');
    }
  });
});
