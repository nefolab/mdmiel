import { beforeEach, describe, expect, it } from 'vitest';
import { getSidebarOpen, setSidebarOpen } from './sidebarState';

describe('sidebarState', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('reads a saved value', () => {
    setSidebarOpen(false);
    expect(getSidebarOpen()).toBe(false);

    setSidebarOpen(true);
    expect(getSidebarOpen()).toBe(true);
  });

  it('defaults to open when no value is saved', () => {
    expect(getSidebarOpen()).toBe(true);
  });

  it('defaults to open when the saved value is invalid', () => {
    localStorage.setItem('mdmiel-sidebar-open', 'invalid');
    expect(getSidebarOpen()).toBe(true);
  });
});
