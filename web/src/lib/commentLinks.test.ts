import { describe, expect, it } from 'vitest';
import {
  BodySegment,
  isInternalLink,
  isShareRouteHash,
  splitBodyIntoSegments,
} from './commentLinks';

const localLocation = {
  origin: 'http://127.0.0.1:8686',
  hostname: '127.0.0.1',
};

function rawValue(segment: BodySegment): string {
  return segment.type === 'text' ? segment.value : segment.url;
}

function split(body: string): BodySegment[] {
  const segments = splitBodyIntoSegments(body, localLocation);
  expect(segments.map(rawValue).join('')).toBe(body);
  return segments;
}

describe('splitBodyIntoSegments', () => {
  it('returns one text segment when no URL is present', () => {
    expect(split('URLのないコメントです。')).toEqual([
      { type: 'text', value: 'URLのないコメントです。' },
    ]);
  });

  it('returns one link segment when the whole body is a URL', () => {
    expect(split('https://example.com/path')).toEqual([
      { type: 'link', url: 'https://example.com/path', internal: false },
    ]);
  });

  it('links a URL whose scheme uses uppercase letters', () => {
    expect(split('HTTPS://EXAMPLE.COM/x')).toEqual([
      { type: 'link', url: 'HTTPS://EXAMPLE.COM/x', internal: false },
    ]);
  });

  it('separates a URL from surrounding Japanese text', () => {
    const body = 'この画面は http://127.0.0.1:8686/#/view?path=req.md の要件です。';
    expect(split(body)).toEqual([
      { type: 'text', value: 'この画面は ' },
      {
        type: 'link',
        url: 'http://127.0.0.1:8686/#/view?path=req.md',
        internal: true,
      },
      { type: 'text', value: ' の要件です。' },
    ]);
  });

  it('finds multiple URLs in one body', () => {
    const segments = split('first https://a.example/x then http://b.example/y end');
    expect(segments.filter((segment) => segment.type === 'link')).toEqual([
      { type: 'link', url: 'https://a.example/x', internal: false },
      { type: 'link', url: 'http://b.example/y', internal: false },
    ]);
  });

  it('preserves a newline between URLs', () => {
    expect(split('https://a.example/x\nhttps://b.example/y')).toEqual([
      { type: 'link', url: 'https://a.example/x', internal: false },
      { type: 'text', value: '\n' },
      { type: 'link', url: 'https://b.example/y', internal: false },
    ]);
  });

  it.each([
    ['http://example.com/req.md。', '。'],
    ['http://example.com/req.md.', '.'],
    ['http://example.com/req.md、', '、'],
    ['http://example.com/req.md)', ')'],
  ])('keeps trailing punctuation outside the link: %s', (body, punctuation) => {
    expect(split(body)).toEqual([
      { type: 'link', url: 'http://example.com/req.md', internal: false },
      { type: 'text', value: punctuation },
    ]);
  });

  it('keeps a balanced closing parenthesis in a URL', () => {
    const body = 'https://ja.wikipedia.org/wiki/Foo_(bar)';
    expect(split(body)).toEqual([
      { type: 'link', url: body, internal: false },
    ]);
  });

  it('removes an unmatched closing parenthesis from a URL', () => {
    expect(split('https://ex.com/a)')).toEqual([
      { type: 'link', url: 'https://ex.com/a', internal: false },
      { type: 'text', value: ')' },
    ]);
  });

  it('splits comma-separated consecutive URLs into two links', () => {
    expect(split('http://a.example/,http://b.example/')).toEqual([
      { type: 'link', url: 'http://a.example/', internal: false },
      { type: 'text', value: ',' },
      { type: 'link', url: 'http://b.example/', internal: false },
    ]);
  });

  it.each(['javascript:alert(1)', 'data:text/html,x'])('does not link a disallowed scheme: %s', (body) => {
    expect(split(body)).toEqual([{ type: 'text', value: body }]);
  });

  it('does not link an http scheme without a URL body', () => {
    expect(split('http://')).toEqual([{ type: 'text', value: 'http://' }]);
  });
});

describe('isShareRouteHash', () => {
  it.each([
    '#/view',
    '#/comment/',
    '#/viewer-of-things',
    '#/view?foo=bar',
  ])('rejects a non-share route: %s', (hash) => {
    expect(isShareRouteHash(hash)).toBe(false);
  });

  it.each([
    '#/comment/abc',
    '#/view?path=a.md',
    '#/view?left=a.md&right=b.md',
  ])('accepts a valid share route: %s', (hash) => {
    expect(isShareRouteHash(hash)).toBe(true);
  });
});

describe('isInternalLink', () => {
  it.each([
    {
      name: 'local same port',
      location: localLocation,
      url: 'http://127.0.0.1:8686/#/view?path=a.md',
      expected: true,
    },
    {
      name: 'local different port',
      location: localLocation,
      url: 'http://127.0.0.1:9999/#/comment/abc',
      expected: true,
    },
    {
      name: 'different loopback spelling',
      location: localLocation,
      url: 'http://localhost:8686/#/view?path=a.md',
      expected: true,
    },
    {
      name: 'same public origin',
      location: { origin: 'https://mdmiel.example.com', hostname: 'mdmiel.example.com' },
      url: 'https://mdmiel.example.com/#/view?path=a.md',
      expected: true,
    },
    {
      name: 'loopback URL from a public origin',
      location: { origin: 'https://mdmiel.example.com', hostname: 'mdmiel.example.com' },
      url: 'http://127.0.0.1:8686/#/view?path=a.md',
      expected: false,
    },
    {
      name: 'non-share hash or no hash',
      location: localLocation,
      url: 'http://127.0.0.1:8686/api/files',
      expected: false,
    },
    {
      name: 'another site',
      location: localLocation,
      url: 'https://github.com/nefolab/mdmiel',
      expected: false,
    },
  ])('$name is classified correctly', ({ location, url, expected }) => {
    expect(isInternalLink(new URL(url), location)).toBe(expected);
  });

  it('does not classify another hash route as internal', () => {
    expect(isInternalLink(new URL('http://127.0.0.1:8686/#/api'), localLocation)).toBe(false);
  });
});
