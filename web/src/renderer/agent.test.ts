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
});
