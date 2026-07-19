import { describe, it, expect } from 'vitest';
import {
  isFiniteNumber,
  buildAnchorsPayload,
  buildLiveRectsMap,
  parsePickPayload,
  parseIncomingMessage,
  computePickPosition,
} from './liveBridge';
import { Comment, computeSnippet, snippetHash } from './comments';

function makeComment(id: string, overrides: Partial<Comment['anchor']> = {}): Comment {
  const snippet = computeSnippet('some text');
  return {
    version: 1,
    id,
    path: 'proto.html',
    anchor: { line: 0, snippet, snippetHash: snippetHash(snippet), ...overrides },
    body: `body ${id}`,
    author: 'nefo',
    createdAt: '2026-07-05T00:00:00Z',
    resolved: false,
  };
}

describe('isFiniteNumber', () => {
  it('accepts finite numbers only', () => {
    expect(isFiniteNumber(1)).toBe(true);
    expect(isFiniteNumber(0)).toBe(true);
    expect(isFiniteNumber(-3.5)).toBe(true);
    expect(isFiniteNumber(NaN)).toBe(false);
    expect(isFiniteNumber(Infinity)).toBe(false);
    expect(isFiniteNumber('1')).toBe(false);
    expect(isFiniteNumber(undefined)).toBe(false);
    expect(isFiniteNumber(null)).toBe(false);
  });
});

describe('buildAnchorsPayload', () => {
  it('keeps only dom-anchored comments that have a selector', () => {
    const domComment = makeComment('a', { type: 'dom', selector: '#foo' });
    const lineComment = makeComment('b');
    const domNoSelector = makeComment('c', { type: 'dom', selector: undefined });
    const payload = buildAnchorsPayload([domComment, lineComment, domNoSelector]);
    expect(payload).toEqual([
      {
        id: 'a',
        selector: '#foo',
        snippet: domComment.anchor.snippet,
        snippetHash: domComment.anchor.snippetHash,
      },
    ]);
  });

  it('returns an empty array when there are no dom-anchored comments', () => {
    expect(buildAnchorsPayload([makeComment('a')])).toEqual([]);
  });
});

describe('buildLiveRectsMap', () => {
  it('maps found entries with valid numeric rects', () => {
    const map = buildLiveRectsMap([
      { id: 'a', found: true, rect: { top: 1, left: 2, width: 3, height: 4 }, visible: true },
    ]);
    expect(map).toEqual({ a: { found: true, rect: { top: 1, left: 2, width: 3, height: 4 }, visible: true } });
  });

  it('maps not-found entries without a rect', () => {
    const map = buildLiveRectsMap([{ id: 'a', found: false }]);
    expect(map).toEqual({ a: { found: false, visible: false } });
  });

  it('coerces a missing/non-true visible field to false', () => {
    const map = buildLiveRectsMap([
      { id: 'a', found: true, rect: { top: 0, left: 0, width: 0, height: 0 } },
    ]);
    expect(map.a.visible).toBe(false);
  });

  it('drops entries with a non-numeric rect field', () => {
    const map = buildLiveRectsMap([
      { id: 'a', found: true, rect: { top: 'oops', left: 2, width: 3, height: 4 } },
    ]);
    expect(map).toEqual({});
  });

  it('drops entries missing an id', () => {
    const map = buildLiveRectsMap([{ found: true, rect: { top: 0, left: 0, width: 0, height: 0 } }]);
    expect(map).toEqual({});
  });

  it('drops non-object entries', () => {
    expect(buildLiveRectsMap([null, 'x', 42])).toEqual({});
  });
});

describe('parsePickPayload', () => {
  const validRect = { top: 10, left: 20 };

  it('accepts a well-formed pick payload', () => {
    const result = parsePickPayload({
      selector: '#foo',
      snippet: 'hello',
      snippetHash: 'abcd1234',
      rect: validRect,
    });
    expect(result).toEqual({ selector: '#foo', snippet: 'hello', snippetHash: 'abcd1234', rect: validRect });
  });

  it('rejects a payload missing rect', () => {
    expect(parsePickPayload({ selector: '#foo', snippet: 'hello', snippetHash: 'abcd1234' })).toBeNull();
  });

  it('rejects a payload with non-finite rect coordinates', () => {
    expect(
      parsePickPayload({ selector: '#foo', snippet: 'hello', snippetHash: 'abcd1234', rect: { top: NaN, left: 0 } })
    ).toBeNull();
  });

  it('rejects a payload with a non-string selector', () => {
    expect(
      parsePickPayload({ selector: 42, snippet: 'hello', snippetHash: 'abcd1234', rect: validRect })
    ).toBeNull();
  });
});

describe('parseIncomingMessage', () => {
  const nonce = 'nonce-1';

  it('rejects non-object data', () => {
    expect(parseIncomingMessage(null, nonce)).toBeNull();
    expect(parseIncomingMessage('str', nonce)).toBeNull();
  });

  it('rejects messages missing the mdmiel marker', () => {
    expect(parseIncomingMessage({ nonce, type: 'ready' }, nonce)).toBeNull();
  });

  it('rejects messages with a mismatched nonce', () => {
    expect(parseIncomingMessage({ mdmiel: true, nonce: 'other', type: 'ready' }, nonce)).toBeNull();
  });

  it('parses a ready message', () => {
    expect(parseIncomingMessage({ mdmiel: true, nonce, type: 'ready' }, nonce)).toEqual({ type: 'ready' });
  });

  it('parses a rects message with an array payload', () => {
    const rects = [{ id: 'a', found: false }];
    expect(parseIncomingMessage({ mdmiel: true, nonce, type: 'rects', rects }, nonce)).toEqual({
      type: 'rects',
      rects,
    });
  });

  it('rejects a rects message whose rects field is not an array', () => {
    expect(parseIncomingMessage({ mdmiel: true, nonce, type: 'rects', rects: 'nope' }, nonce)).toBeNull();
  });

  it('parses a well-formed pick message', () => {
    const msg = {
      mdmiel: true,
      nonce,
      type: 'pick',
      selector: '#foo',
      snippet: 'hi',
      snippetHash: 'deadbeef',
      rect: { top: 1, left: 2 },
    };
    expect(parseIncomingMessage(msg, nonce)).toEqual({
      type: 'pick',
      payload: { selector: '#foo', snippet: 'hi', snippetHash: 'deadbeef', rect: { top: 1, left: 2 } },
    });
  });

  it('rejects a malformed pick message', () => {
    expect(parseIncomingMessage({ mdmiel: true, nonce, type: 'pick' }, nonce)).toBeNull();
  });

  it('rejects an unrecognized type', () => {
    expect(parseIncomingMessage({ mdmiel: true, nonce, type: 'bogus' }, nonce)).toBeNull();
  });
});

describe('computePickPosition', () => {
  it('translates an iframe-relative pick rect into container-relative coordinates', () => {
    const containerRect = { top: 100, left: 50 };
    const iframeRect = { top: 120, left: 60 };
    const pickRect = { top: 10, left: 5 };
    expect(computePickPosition(containerRect, iframeRect, pickRect)).toEqual({ top: 30, left: 15 });
  });
});
