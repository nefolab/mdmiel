import { describe, it, expect } from 'vitest';
import { renderAgentScript } from './agent';

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
