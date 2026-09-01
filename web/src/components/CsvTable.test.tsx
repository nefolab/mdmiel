import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CsvTable } from './CsvTable';

let root: Root;
let mount: HTMLDivElement;

beforeEach(() => {
  mount = document.createElement('div');
  document.body.append(mount);
  root = createRoot(mount);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  mount.remove();
});

describe('CsvTable', () => {
  it('renders headers and cells as text, not HTML', () => {
    act(() => {
      root.render(<CsvTable content={'name,note\n<a>,<script>alert(1)</script>\n'} />);
    });
    expect(mount.querySelector('script')).toBeNull();
    expect(mount.querySelector('a')).toBeNull();
    expect(mount.textContent).toContain('<script>alert(1)</script>');
    expect(mount.textContent).toContain('<a>');
  });

  it('shows a banner when the table has review issues', () => {
    act(() => {
      root.render(<CsvTable content={'name,\npen,\n'} />);
    });
    const banner = mount.querySelector('.csv-banner');
    expect(banner?.textContent).toContain('空ヘッダー');
    expect(banner?.textContent).toContain('空セル');
    expect(mount.querySelector('.csv-cell-empty')).not.toBeNull();
    expect(mount.querySelector('.csv-cell-empty-header')).not.toBeNull();
    const headers = Array.from(mount.querySelectorAll('thead th')).map((th) => th.textContent);
    expect(headers).toEqual(['#', 'name', '']);
  });

  it('marks duplicate headers, ragged rows, and missing cells', () => {
    act(() => {
      root.render(<CsvTable content={'name,name\nonly\n'} />);
    });
    expect(mount.querySelector('.csv-cell-duplicate-header')).not.toBeNull();
    expect(mount.querySelector('.csv-row-ragged')).not.toBeNull();
    expect(mount.querySelector('.csv-cell-missing')).not.toBeNull();
  });

  it('falls back to raw text when the file is too large to tabulate', () => {
    act(() => {
      root.render(<CsvTable content={'x'.repeat(512 * 1024 + 1)} />);
    });
    expect(mount.querySelector('table')).toBeNull();
    expect(mount.querySelector('.csv-raw')).not.toBeNull();
    expect(mount.querySelector('.csv-banner')?.textContent).toContain('512KB');
  });
});
