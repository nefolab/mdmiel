import { afterEach, describe, it, expect, vi } from 'vitest';
import { renderAgentScript } from './agent';
import { snippetHash } from '../lib/comments';
import { buildDomSelector, extractAnchorText } from '../lib/domAnchor';

/**
 * Extracts a top-level `function <name>(...) { ... }` declaration from the rendered
 * agent script by brace-counting from the first `{` after the name, then evaluates it
 * via `new Function` so it can be called directly in the test (no DOM/iframe needed).
 * This is how we keep agent.ts's duplicated FNV-1a implementation provably in sync with
 * lib/comments.ts's snippetHash() without executing the whole sandboxed-iframe script.
 */
function extractFunction(script: string, name: string): (...args: unknown[]) => unknown {
  const marker = `function ${name}(`;
  const start = script.indexOf(marker);
  if (start === -1) throw new Error(`function ${name} not found in agent script`);
  const braceStart = script.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < script.length; i++) {
    if (script[i] === '{') depth++;
    else if (script[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error(`could not find end of function ${name}`);
  const src = script.slice(start, end + 1);
  // eslint-disable-next-line no-new-func
  return new Function(`return (${src});`)();
}

describe('agent fnv1aHash matches lib/comments.ts snippetHash', () => {
  it('produces byte-identical 8-char hex hashes for the same input', () => {
    const script = renderAgentScript('nonce-for-fnv-test');
    const fnv1aHash = extractFunction(script, 'fnv1aHash') as (str: string) => string;

    const cases = [
      '',
      'a',
      'Submit',
      'Hello, World!',
      '日本語のテキストです',
      '  collapsed   whitespace already normalized ',
      'a'.repeat(200),
      '0123456789',
    ];

    for (const input of cases) {
      expect(fnv1aHash(input)).toBe(snippetHash(input));
    }
  });
});

describe('agent buildSelector / extractText match lib/domAnchor.ts', () => {
  const script = renderAgentScript('dom-anchor-equivalence');
  const buildSelector = extractFunction(script, 'buildSelector') as (el: Element | null) => string;
  const extractText = extractFunction(script, 'extractText') as (el: Element | null) => string;

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('matches a representative DOM corpus', () => {
    document.body.innerHTML = '<section id="id target"> id </section><div> test </div><main><p> 日本語   text </p><p></p></main>';
    document.querySelector('div')!.setAttribute('data-testid', 'a"b');
    for (const length of [79, 80, 81]) {
      const el = document.createElement('p');
      el.textContent = 'x'.repeat(length);
      document.body.append(el);
    }
    let deep = document.body as Element;
    for (let i = 0; i < 21; i++) { const child = document.createElement('div'); deep.append(child); deep = child; }
    const detached = document.createElement('aside');
    const elements = [...document.querySelectorAll('*'), detached];
    for (const el of elements) {
      expect(buildSelector(el)).toBe(buildDomSelector(el));
      expect(extractText(el)).toBe(extractAnchorText(el));
    }
    expect(extractText(document.querySelectorAll('p')[3])).toHaveLength(80);
  });

  it('matches when CSS.escape is available', () => {
    vi.stubGlobal('CSS', { escape: (value: string) => `escaped-${value}` });
    const el = document.createElement('div'); el.id = 'a b';
    expect(buildDomSelector(el)).toBe('#escaped-a b');
    expect(buildSelector(el)).toBe(buildDomSelector(el));
  });
});

describe('MutationObserver target survives document.documentElement.replaceWith (jsdom)', () => {
  // claude designプロトタイプはルート要素を document.documentElement.replaceWith(...) で
  // 丸ごと差し替える。これらのテストは agent.ts が実際に依拠しているブラウザ/DOMの契約
  // そのものをjsdomで直接検証する: documentElementを観測しているとreplaceWith後に死ぬ
  // (バグ再現)一方、documentノード自体を観測すれば生き続ける(修正後の挙動)。

  it('BUG: an observer attached to the old documentElement goes silent after replaceWith', async () => {
    const oldRoot = document.documentElement;
    let fired = false;
    const observer = new MutationObserver(() => {
      fired = true;
    });
    observer.observe(oldRoot, { childList: true, subtree: true, attributes: true, characterData: true });

    const newHtml = document.createElement('html');
    newHtml.innerHTML = '<head></head><body></body>';
    oldRoot.replaceWith(newHtml);

    // Mutate the new (live) tree; an observer still attached to the now-detached
    // old node must never see it.
    document.body.setAttribute('data-test', '1');
    await new Promise((r) => setTimeout(r, 20));

    expect(fired).toBe(false);
    observer.disconnect();
  });

  it('FIX: an observer attached to `document` itself keeps firing after replaceWith, including for mutations inside the new tree', async () => {
    let fireCount = 0;
    const observer = new MutationObserver(() => {
      fireCount++;
    });
    observer.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });

    const newHtml = document.createElement('html');
    newHtml.innerHTML = '<head></head><body><div id="after-replace">hi</div></body>';
    document.documentElement.replaceWith(newHtml);
    await new Promise((r) => setTimeout(r, 20));
    expect(fireCount).toBeGreaterThan(0);
    expect(document.getElementById('after-replace')).not.toBeNull();

    // A mutation inside the freshly-swapped-in subtree must also still be observed
    // (this is what lets the agent notice an anchored element disappearing/appearing
    // across SPA route changes after the initial replaceWith).
    const before = fireCount;
    document.getElementById('after-replace')!.textContent = 'changed';
    await new Promise((r) => setTimeout(r, 20));
    expect(fireCount).toBeGreaterThan(before);

    observer.disconnect();
  });
});

describe('renderAgentScript', () => {
  it('embeds the given nonce and never leaves the placeholder behind', () => {
    const script = renderAgentScript('nonce-abc-123');
    expect(script).toContain('"nonce-abc-123"');
    expect(script).not.toContain('__MDMIEL_AGENT_NONCE__');
  });

  it('produces a valid regex for whitespace collapsing (single backslash survives template escaping)', () => {
    const script = renderAgentScript('n');
    expect(script).toContain('replace(/\\s+/g, " ")');
  });

  it('defines the window.__mdmielAgent namespace and postMessage handshake', () => {
    const script = renderAgentScript('n');
    expect(script).toContain('window.__mdmielAgent');
    expect(script).toContain('type: "ready"');
    expect(script).toContain('addEventListener("message"');
  });

  it('observes `document` itself (not `document.documentElement`), so the observer survives a claude-design-style root swap', () => {
    const script = renderAgentScript('n');
    expect(script).toContain('observer.observe(document,');
    // Regression guard: the old (buggy) target expression must not reappear.
    expect(script).not.toContain('document.documentElement || document.body');
    expect(script).not.toMatch(/observer\.observe\(\s*observeRoot/);
  });

  it('re-resolves every anchor and reschedules a rects send on every observed mutation', () => {
    const script = renderAgentScript('n');
    // The observer now receives MutationRecords to filter overlay-only changes.
    const match = script.match(/new MutationObserver\(function \(records\) \{([\s\S]*?)\}\);/);
    expect(match).not.toBeNull();
    const body = match![1];
    expect(body.indexOf('ensureOverlay();')).toBeLessThan(body.indexOf('isOverlayOnlyMutation(records, overlayEl)'));
    expect(body.indexOf('isOverlayOnlyMutation(records, overlayEl)')).toBeLessThan(body.indexOf('resolveAll();'));
    expect(body).toContain('resolveAll();');
    expect(body).toContain('scheduleRects();');
  });

  it('sendRectsNow reports every known anchor (found:true or found:false), not just the ones that changed', () => {
    const script = renderAgentScript('n');
    expect(script).toContain('function sendRectsNow()');
    // Iterates the full `anchors` list every call (no diffing against a previous send)...
    expect(script).toContain('for (var i = 0; i < anchors.length; i++) {');
    // ...and pushes an entry even when the anchor's element is gone, so the parent can
    // reclassify it into the unresolved zone instead of it silently vanishing from the
    // payload.
    expect(script).toContain('rects.push({ id: a.id, found: false });');
    expect(script).toContain('send({ type: "rects", rects: rects });');
  });
});

/**
 * Extracts the raw source text of a top-level `function <name>(...) { ... }` declaration
 * (same brace-counting approach as extractFunction above), without evaluating it. Used by
 * buildResolveOne() to splice resolveOne() together with the helper functions its body
 * calls (fnv1aHash, extractText) into one evaluable scope, since resolveOne can't be
 * extracted and called in isolation the way a self-contained function like fnv1aHash can.
 */
function extractFunctionSource(script: string, name: string): string {
  const marker = `function ${name}(`;
  const start = script.indexOf(marker);
  if (start === -1) throw new Error(`function ${name} not found in agent script`);
  const braceStart = script.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < script.length; i++) {
    if (script[i] === '{') depth++;
    else if (script[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error(`could not find end of function ${name}`);
  return script.slice(start, end + 1);
}

/**
 * Builds a callable resolveOne(anchor) from the rendered agent script by splicing together
 * its MAX_TEXT_HASH_SCAN declaration, fnv1aHash, extractText and resolveOne itself into one
 * `new Function` body (evaluated in the test's global scope, so it sees jsdom's `document`).
 * Lets M1's scan-cap behavior be exercised against real DOM nodes instead of just asserting
 * on the script text.
 */
function buildResolveOne(
  script: string
): (anchor: { selector?: string; snippetHash: string }) => Element | null {
  const constMatch = script.match(/var MAX_TEXT_HASH_SCAN = \d+;/);
  if (!constMatch) throw new Error('MAX_TEXT_HASH_SCAN declaration not found in agent script');
  const fnv1a = extractFunctionSource(script, 'fnv1aHash');
  const extractTextSrc = extractFunctionSource(script, 'extractText');
  const resolveOneSrc = extractFunctionSource(script, 'resolveOne');
  const combined = [constMatch[0], fnv1a, extractTextSrc, resolveOneSrc, 'return resolveOne;'].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(combined)();
}

describe('M1: resolveOne text-hash fallback scan is capped', () => {
  it('declares a named MAX_TEXT_HASH_SCAN = 5000 constant used as the querySelectorAll("*") scan limit', () => {
    const script = renderAgentScript('n');
    expect(script).toContain('var MAX_TEXT_HASH_SCAN = 5000;');
    expect(script).toContain('var scanLimit = Math.min(all.length, MAX_TEXT_HASH_SCAN);');
    expect(script).toContain('for (var i = 0; i < scanLimit; i++) {');
  });

  it('finds a text-hash match that falls within the scan cap', () => {
    const script = renderAgentScript('n').replace(
      'var MAX_TEXT_HASH_SCAN = 5000;',
      'var MAX_TEXT_HASH_SCAN = 10;'
    );
    const resolveOne = buildResolveOne(script);

    document.body.innerHTML = '';
    for (let i = 0; i < 5; i++) {
      const div = document.createElement('div');
      div.textContent = i === 3 ? 'target-text' : 'filler';
      document.body.appendChild(div);
    }

    const found = resolveOne({ selector: '', snippetHash: snippetHash('target-text') });
    expect(found).not.toBeNull();
    expect(found!.textContent).toBe('target-text');
  });

  it('gives up (returns null) once the match falls beyond the scan cap, instead of scanning the full tree', () => {
    const script = renderAgentScript('n').replace(
      'var MAX_TEXT_HASH_SCAN = 5000;',
      'var MAX_TEXT_HASH_SCAN = 10;'
    );
    const resolveOne = buildResolveOne(script);

    document.body.innerHTML = '';
    // document.querySelectorAll("*") also includes <html>/<head>/<body> ahead of these
    // divs, so appending 20 filler-then-target divs safely pushes the match well past a
    // cap of 10.
    for (let i = 0; i < 20; i++) {
      const div = document.createElement('div');
      div.textContent = i === 15 ? 'target-text' : 'filler';
      document.body.appendChild(div);
    }

    const found = resolveOne({ selector: '', snippetHash: snippetHash('target-text') });
    expect(found).toBeNull();
  });
});

describe('L1: agent only sends "pick" while comment mode is armed', () => {
  it('guard bails out immediately when commentModeOn is false (no unconditional pick send)', () => {
    const script = renderAgentScript('n');
    expect(script).toContain('var commentModeOn = false;');
    // Click handling moved into the shared capture guard with the other blocked inputs.
    expect(script).toMatch(
      /function onGuardEvent\(e\) \{\s*if \(!commentModeOn\) return;/
    );
    expect(script).not.toContain('document.addEventListener("click"');
  });

  it('flips commentModeOn from a parent {type:"commentMode", on} message', () => {
    const script = renderAgentScript('n');
    expect(script).toContain('data.type === "commentMode" && typeof data.on === "boolean"');
    expect(script).toContain('commentModeOn = data.on;');
  });
});

describe('comment-mode overlay helpers', () => {
  it('defines the important overlay styles and capture guards', () => {
    const script = renderAgentScript('n');
    expect(script).toContain('["position", "fixed"]');
    expect(script).toContain('["inset", "0"]');
    expect(script).toContain('["z-index", "2147483647"]');
    expect(script).toContain('["touch-action", "none"]');
    expect(script).toContain('style.setProperty(OVERLAY_STYLE[i][0], OVERLAY_STYLE[i][1], "important")');
    expect(script).toContain('window.addEventListener(GUARD_EVENTS[guardIndex], onGuardEvent, { capture: true, passive: false })');
    expect(script).toContain('document.addEventListener(GUARD_EVENTS[guardIndex], onGuardEvent, { capture: true, passive: false })');
    expect(script).not.toContain('document.addEventListener("mouseover"');
    expect(script).not.toContain('document.addEventListener("mouseout"');
    expect(script).toContain('e.stopImmediatePropagation();');
    expect(script).toContain('"pointermove", "dblclick", "auxclick"');
    expect(script).toContain('"mousemove", "mouseover", "mouseout", "dragstart"');
    expect(script).toContain('"dblclick", "auxclick", "contextmenu", "dragstart", "wheel", "touchmove"');
    expect(script).not.toContain('"contextmenu", "touchstart", "wheel", "touchmove"]');
  });

  it('hitTest disables the overlay only while calling elementFromPoint', () => {
    const script = renderAgentScript('n');
    const hitTest = extractFunction(script, 'hitTest') as (overlay: Element | null, x: number, y: number) => Element | null;
    const overlay = document.createElement('div');
    const target = document.createElement('div');
    const descriptor = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => {
        expect(overlay.style.getPropertyValue('pointer-events')).toBe('none');
        return target;
      },
    });
    try {
      expect(hitTest(overlay, 10, 20)).toBe(target);
      expect(overlay.style.getPropertyValue('pointer-events')).toBe('auto');
    } finally {
      if (descriptor) Object.defineProperty(document, 'elementFromPoint', descriptor);
      else Reflect.deleteProperty(document, 'elementFromPoint');
    }
  });

  it('hitTest restores pointer-events when elementFromPoint throws', () => {
    const script = renderAgentScript('n');
    const hitTest = extractFunction(script, 'hitTest') as (overlay: Element | null, x: number, y: number) => Element | null;
    const overlay = document.createElement('div');
    const descriptor = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => { throw new Error('hit test failed'); },
    });
    try {
      expect(hitTest(overlay, 10, 20)).toBeNull();
      expect(overlay.style.getPropertyValue('pointer-events')).toBe('auto');
    } finally {
      if (descriptor) Object.defineProperty(document, 'elementFromPoint', descriptor);
      else Reflect.deleteProperty(document, 'elementFromPoint');
    }
  });

  it('filters pickable targets and overlay-only mutation records', () => {
    const script = renderAgentScript('n');
    const isOverlayHit = extractFunctionSource(script, 'isOverlayHit');
    const isPickableTargetSrc = extractFunctionSource(script, 'isPickableTarget');
    const nodeListHasOnlyOverlay = extractFunctionSource(script, 'nodeListHasOnlyOverlay');
    const isOverlayOnlyMutationSrc = extractFunctionSource(script, 'isOverlayOnlyMutation');
    // eslint-disable-next-line no-new-func
    const helpers = new Function(`${isOverlayHit}\n${isPickableTargetSrc}\n${nodeListHasOnlyOverlay}\n${isOverlayOnlyMutationSrc}\nreturn { isPickableTarget: isPickableTarget, isOverlayOnlyMutation: isOverlayOnlyMutation };`)() as {
      isPickableTarget: (el: Node | null, overlay: Element | null) => boolean;
      isOverlayOnlyMutation: (records: unknown[], overlay: Element | null) => boolean;
    };
    const overlay = document.createElement('div');
    const overlayChild = document.createElement('span');
    overlay.appendChild(overlayChild);
    const ordinary = document.createElement('div');
    expect(helpers.isPickableTarget(null, overlay)).toBe(false);
    expect(helpers.isPickableTarget(document.createTextNode('text'), overlay)).toBe(false);
    expect(helpers.isPickableTarget(overlay, overlay)).toBe(false);
    expect(helpers.isPickableTarget(overlayChild, overlay)).toBe(false);
    expect(helpers.isPickableTarget(document.documentElement, overlay)).toBe(false);
    expect(helpers.isPickableTarget(document.body, overlay)).toBe(false);
    expect(helpers.isPickableTarget(ordinary, overlay)).toBe(true);

    const overlayAttributes = { type: 'attributes', target: overlay };
    const overlayChildList = { type: 'childList', target: document.documentElement, addedNodes: [overlay], removedNodes: [] };
    const mockChildList = { type: 'childList', target: document.body, addedNodes: [ordinary], removedNodes: [] };
    expect(helpers.isOverlayOnlyMutation([overlayAttributes], overlay)).toBe(true);
    expect(helpers.isOverlayOnlyMutation([overlayChildList], overlay)).toBe(true);
    expect(helpers.isOverlayOnlyMutation([overlayChildList, mockChildList], overlay)).toBe(false);
    expect(helpers.isOverlayOnlyMutation([{ type: 'childList', target: overlay, addedNodes: [ordinary], removedNodes: [] }], overlay)).toBe(false);
    expect(helpers.isOverlayOnlyMutation([overlayAttributes], null)).toBe(false);
    expect(helpers.isOverlayOnlyMutation([], overlay)).toBe(false);
  });

  it('accepts only trusted click events with pointer detail for picking', () => {
    const script = renderAgentScript('n');
    const isPickEvent = extractFunction(script, 'isPickEvent') as (event: { isTrusted: boolean; detail: number }) => boolean;
    expect(isPickEvent({ isTrusted: true, detail: 1 })).toBe(true);
    expect(isPickEvent({ isTrusted: false, detail: 1 })).toBe(false);
    expect(isPickEvent({ isTrusted: true, detail: 0 })).toBe(false);
  });
});

describe('additional hardening: parent-message origin pinning when ancestorOrigins is unavailable', () => {
  it('pins the origin of the first nonce-matching message and rejects later messages from a different origin', () => {
    const script = renderAgentScript('n');
    expect(script).toContain('var pinnedOrigin = null;');
    // Pinning check only applies when ancestorOrigins couldn't be read (parentOrigin is null);
    // when parentOrigin is available it already fully validates origin on its own.
    expect(script).toContain(
      'if (!parentOrigin && pinnedOrigin !== null && event.origin !== pinnedOrigin) return;'
    );
    expect(script).toContain('if (!parentOrigin && pinnedOrigin === null) {');
    expect(script).toContain('pinnedOrigin = event.origin;');
  });
});

/**
 * L2 (anchor hardening): builds a callable resolveOne(anchor) that also splices in
 * deriveTagFromSelector, so fallback-scan tag validation (requirement 3) can be exercised.
 * Same brace-counting extraction approach as buildResolveOne above; kept as a separate
 * helper rather than editing buildResolveOne, since existing tests using buildResolveOne
 * must not change.
 */
function buildResolveOneL2(
  script: string
): (anchor: { selector?: string; snippet: string; snippetHash: string }) => Element | null {
  const constMatch = script.match(/var MAX_TEXT_HASH_SCAN = \d+;/);
  if (!constMatch) throw new Error('MAX_TEXT_HASH_SCAN declaration not found in agent script');
  const deriveTagSrc = extractFunctionSource(script, 'deriveTagFromSelector');
  const fnv1a = extractFunctionSource(script, 'fnv1aHash');
  const extractTextSrc = extractFunctionSource(script, 'extractText');
  const resolveOneSrc = extractFunctionSource(script, 'resolveOne');
  const combined = [constMatch[0], deriveTagSrc, fnv1a, extractTextSrc, resolveOneSrc, 'return resolveOne;'].join(
    '\n'
  );
  // eslint-disable-next-line no-new-func
  return new Function(combined)();
}

describe('L2 requirement 1: empty-snippet anchors never fall back to the text-hash scan', () => {
  it('does not snap to an unrelated empty-text element when the selector misses (bug repro: skeleton-style anchor)', () => {
    const script = renderAgentScript('n');
    const resolveOne = buildResolveOneL2(script);

    document.body.innerHTML = '';
    // An unrelated empty-text element elsewhere in the DOM. With the old (buggy) fallback,
    // this would be picked up by the full-tree text-hash scan since "" hashes identically
    // to the anchor's snippetHash (811c9dc5) regardless of which element it belongs to.
    const decoy = document.createElement('div');
    decoy.id = 'decoy';
    document.body.appendChild(decoy);

    const found = resolveOne({ selector: '#missing-skeleton', snippet: '', snippetHash: snippetHash('') });
    expect(found).toBeNull();
  });

  it('trusts a selector match directly for an empty snippet, without requiring a hash re-check', () => {
    const script = renderAgentScript('n');
    const resolveOne = buildResolveOneL2(script);

    document.body.innerHTML = '<div id="skeleton"></div>';
    const el = document.getElementById('skeleton')!;

    const found = resolveOne({ selector: '#skeleton', snippet: '', snippetHash: snippetHash('') });
    expect(found).toBe(el);
  });

  it('still runs the text-hash fallback scan for a non-empty snippet (regression guard: requirement 1 must not over-apply)', () => {
    const script = renderAgentScript('n');
    const resolveOne = buildResolveOneL2(script);

    document.body.innerHTML = '';
    // A filler sibling keeps body/html's aggregate textContent from accidentally matching
    // `target`'s own text (which would make the assertion pass for the wrong reason).
    const filler = document.createElement('p');
    filler.textContent = 'filler';
    document.body.appendChild(filler);
    const target = document.createElement('div');
    target.textContent = 'target-text';
    document.body.appendChild(target);

    const found = resolveOne({ selector: '#missing', snippet: 'target-text', snippetHash: snippetHash('target-text') });
    expect(found).toBe(target);
  });
});

describe('L2 requirement 2: isElementRenderable rejects zero-size or hidden resolved elements', () => {
  function extractIsElementRenderable(script: string) {
    return extractFunction(script, 'isElementRenderable') as (
      el: Element,
      r: { width: number; height: number }
    ) => boolean;
  }

  it('rejects a rect with width and height both 0', () => {
    const script = renderAgentScript('n');
    const isElementRenderable = extractIsElementRenderable(script);
    document.body.innerHTML = '<div id="target"></div>';
    const el = document.getElementById('target')!;
    expect(isElementRenderable(el, { width: 0, height: 0 })).toBe(false);
  });

  it('rejects an element with display:none regardless of rect size', () => {
    const script = renderAgentScript('n');
    const isElementRenderable = extractIsElementRenderable(script);
    document.body.innerHTML = '<div id="target" style="display:none"></div>';
    const el = document.getElementById('target')!;
    expect(isElementRenderable(el, { width: 100, height: 40 })).toBe(false);
  });

  it('rejects an element with visibility:hidden regardless of rect size', () => {
    const script = renderAgentScript('n');
    const isElementRenderable = extractIsElementRenderable(script);
    document.body.innerHTML = '<div id="target" style="visibility:hidden"></div>';
    const el = document.getElementById('target')!;
    expect(isElementRenderable(el, { width: 100, height: 40 })).toBe(false);
  });

  it('accepts a normal, sized, visible element even when its rect is off-viewport (that is a separate visible:false concern, not found:false)', () => {
    const script = renderAgentScript('n');
    const isElementRenderable = extractIsElementRenderable(script);
    document.body.innerHTML = '<div id="target"></div>';
    const el = document.getElementById('target')!;
    expect(isElementRenderable(el, { width: 100, height: 40, top: -9999, left: -9999 } as never)).toBe(true);
  });

  it('sendRectsNow gates found:true on isElementRenderable(el, r) before reporting rect/visible', () => {
    const script = renderAgentScript('n');
    expect(script).toContain('if (!isElementRenderable(el, r)) {');
    expect(script).toContain('rects.push({ id: a.id, found: false });\n        continue;\n      }\n      rects.push({');
  });
});

describe('L2 requirement 3: text-hash fallback candidates are validated against the selector\'s trailing tag name', () => {
  it('skips a same-hash candidate of the wrong tag and returns the one whose tag matches the selector', () => {
    const script = renderAgentScript('n');
    const resolveOne = buildResolveOneL2(script);

    document.body.innerHTML = '';
    const span = document.createElement('span');
    span.textContent = 'shared-text';
    document.body.appendChild(span);
    const div = document.createElement('div');
    div.textContent = 'shared-text';
    document.body.appendChild(div);

    // Selector itself misses (querySelector finds nothing), forcing the fallback scan;
    // its trailing segment "div:nth-of-type(9)" derives an expected tag of "div".
    const found = resolveOne({
      selector: 'body > div:nth-of-type(9)',
      snippet: 'shared-text',
      snippetHash: snippetHash('shared-text'),
    });
    expect(found).toBe(div);
    expect(found).not.toBe(span);
  });

  it('returns null when every same-hash candidate has the wrong tag', () => {
    const script = renderAgentScript('n');
    const resolveOne = buildResolveOneL2(script);

    document.body.innerHTML = '';
    const span = document.createElement('span');
    span.textContent = 'only-span-text';
    document.body.appendChild(span);

    const found = resolveOne({
      selector: 'body > div:nth-of-type(9)',
      snippet: 'only-span-text',
      snippetHash: snippetHash('only-span-text'),
    });
    expect(found).toBeNull();
  });

  it('skips tag validation when the selector has no derivable trailing tag (id/data-testid form)', () => {
    const script = renderAgentScript('n');
    const resolveOne = buildResolveOneL2(script);

    document.body.innerHTML = '';
    // A filler sibling keeps body/html's aggregate textContent from accidentally matching
    // `span`'s own text (which would make the assertion pass for the wrong reason).
    const filler = document.createElement('p');
    filler.textContent = 'filler';
    document.body.appendChild(filler);
    const span = document.createElement('span');
    span.textContent = 'id-selector-text';
    document.body.appendChild(span);

    const found = resolveOne({
      selector: '#does-not-exist',
      snippet: 'id-selector-text',
      snippetHash: snippetHash('id-selector-text'),
    });
    expect(found).toBe(span);
  });
});

describe('L2: deriveTagFromSelector', () => {
  it('derives the trailing tag from a nth-of-type path, and returns null for id/data-testid selectors', () => {
    const script = renderAgentScript('n');
    const deriveTagFromSelector = extractFunction(script, 'deriveTagFromSelector') as (
      selector: string
    ) => string | null;

    expect(deriveTagFromSelector('html > body:nth-of-type(1) > div:nth-of-type(2)')).toBe('div');
    expect(deriveTagFromSelector('span:nth-of-type(3)')).toBe('span');
    expect(deriveTagFromSelector('#some-id')).toBeNull();
    expect(deriveTagFromSelector('[data-testid="x"]')).toBeNull();
    expect(deriveTagFromSelector('')).toBeNull();
  });
});
