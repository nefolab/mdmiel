import { describe, it, expect } from 'vitest';
import { renderAgentScript } from './agent';
import { snippetHash } from '../lib/comments';

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
    const match = script.match(/new MutationObserver\(function \(\) \{([\s\S]*?)\}\);/);
    expect(match).not.toBeNull();
    const body = match![1];
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
  it('click handler bails out immediately when commentModeOn is false (no unconditional pick send)', () => {
    const script = renderAgentScript('n');
    expect(script).toContain('var commentModeOn = false;');
    expect(script).toMatch(
      /document\.addEventListener\("click", function \(e\) \{\s*if \(!commentModeOn\) return;/
    );
  });

  it('flips commentModeOn from a parent {type:"commentMode", on} message', () => {
    const script = renderAgentScript('n');
    expect(script).toContain('data.type === "commentMode" && typeof data.on === "boolean"');
    expect(script).toContain('commentModeOn = data.on;');
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
