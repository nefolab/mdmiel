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
