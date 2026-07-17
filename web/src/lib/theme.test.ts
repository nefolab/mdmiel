import { describe, it, expect, beforeEach } from 'vitest';
import { getInitialTheme, applyTheme } from './theme';

describe('getInitialTheme', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('falls back to slate when localStorage has no saved theme', () => {
    expect(getInitialTheme()).toBe('slate');
  });

  it('falls back to slate when localStorage has an invalid value', () => {
    localStorage.setItem('mdmiel-theme', 'editorial');
    expect(getInitialTheme()).toBe('slate');
  });

  it('prefers the value saved in localStorage over the default', () => {
    localStorage.setItem('mdmiel-theme', 'paper');
    expect(getInitialTheme()).toBe('paper');
  });
});

describe('applyTheme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('sets data-theme on the document root', () => {
    applyTheme('paper');
    expect(document.documentElement.getAttribute('data-theme')).toBe('paper');
  });

  it('persists the choice to localStorage', () => {
    applyTheme('paper');
    expect(localStorage.getItem('mdmiel-theme')).toBe('paper');
  });

  it('overwrites a previous data-theme value', () => {
    applyTheme('paper');
    applyTheme('slate');
    expect(document.documentElement.getAttribute('data-theme')).toBe('slate');
    expect(localStorage.getItem('mdmiel-theme')).toBe('slate');
  });
});
