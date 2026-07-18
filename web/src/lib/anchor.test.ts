import { describe, it, expect } from 'vitest';
import { parseHash, generateHash, ViewState, parseCommentRoute } from './anchor';

describe('anchor url parsing and generation', () => {
  it('should parse and generate single file state', () => {
    const state: ViewState = { path: 'spec.md', line: 42 };
    const hash = generateHash(state);
    expect(hash).toBe('#/view?path=spec.md&line=42');

    const parsed = parseHash(hash);
    expect(parsed).toEqual(state);
  });

  it('should parse and generate split view state with Japanese and spaces', () => {
    const state: ViewState = {
      left: 'フォルダ/仕様書 v1.md',
      leftLine: 42,
      right: 'sub/画面 モック.html',
      rightLine: 120,
    };
    const hash = generateHash(state);
    expect(hash).toContain('left=%E3%83%95%E3%82%A9%E3%83%AB%E3%83%80%2F%E4%BB%95%E6%A7%98%E6%9B%B8%20v1.md');
    expect(hash).toContain('right=sub%2F%E7%94%BB%E9%9D%A2%20%E3%83%A2%E3%83%83%E3%82%AF.html');

    const parsed = parseHash(hash);
    expect(parsed).toEqual(state);
  });

  it('should return empty object for invalid hash', () => {
    expect(parseHash('')).toEqual({});
    expect(parseHash('#/')).toEqual({});
    expect(parseHash('#/invalid')).toEqual({});
  });
});

describe('parseCommentRoute', () => {
  it('parses a bare comment id', () => {
    expect(parseCommentRoute('#/comment/abc123')).toEqual({ id: 'abc123' });
  });

  it('URL-decodes the id segment', () => {
    expect(parseCommentRoute('#/comment/%E6%97%A5%E6%9C%AC%E8%AA%9E-id')).toEqual({ id: '日本語-id' });
  });

  it('truncates trailing path/query noise at the first / or ?', () => {
    expect(parseCommentRoute('#/comment/abc123/extra')).toEqual({ id: 'abc123' });
    expect(parseCommentRoute('#/comment/abc123?foo=bar')).toEqual({ id: 'abc123' });
  });

  it('returns null for non-comment hashes and empty ids', () => {
    expect(parseCommentRoute('')).toBeNull();
    expect(parseCommentRoute('#/')).toBeNull();
    expect(parseCommentRoute('#/view?path=spec.md')).toBeNull();
    expect(parseCommentRoute('#/comment/')).toBeNull();
  });
});
