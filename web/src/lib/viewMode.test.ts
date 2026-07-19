import { describe, it, expect, beforeEach } from 'vitest';
import { getViewMode, setViewMode } from './viewMode';

describe('getViewMode', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('falls back to static when localStorage has no saved mode', () => {
    expect(getViewMode('mock.html')).toBe('static');
  });

  it('falls back to static when localStorage has an invalid value', () => {
    localStorage.setItem('mdmiel-view-mode:mock.html', 'bogus');
    expect(getViewMode('mock.html')).toBe('static');
  });

  it('prefers the value saved in localStorage over the default', () => {
    localStorage.setItem('mdmiel-view-mode:mock.html', 'live');
    expect(getViewMode('mock.html')).toBe('live');
  });

  it('keeps modes independent per path', () => {
    setViewMode('a.html', 'live');
    expect(getViewMode('a.html')).toBe('live');
    expect(getViewMode('b.html')).toBe('static');
  });
});

describe('setViewMode', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('persists the choice to localStorage under a path-scoped key', () => {
    setViewMode('sub/mock.html', 'live');
    expect(localStorage.getItem('mdmiel-view-mode:sub/mock.html')).toBe('live');
  });

  it('overwrites a previous mode for the same path', () => {
    setViewMode('mock.html', 'live');
    setViewMode('mock.html', 'static');
    expect(getViewMode('mock.html')).toBe('static');
  });
});
