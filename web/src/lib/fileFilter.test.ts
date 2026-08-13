import { describe, expect, it } from 'vitest';
import { filterFiles, getAncestorDirectories } from './fileFilter';

const files = [
  { path: 'docs/spec.md', type: 'markdown' as const },
  { path: 'working/docs-memo.md', type: 'markdown' as const },
  { path: 'mock.html', type: 'html' as const },
];

describe('filterFiles', () => {
  it('matches a substring of the full path', () => {
    expect(filterFiles(files, 'spec')).toEqual([files[0]]);
  });

  it('matches both directory names and file names', () => {
    expect(filterFiles(files, 'docs')).toEqual([files[0], files[1]]);
  });

  it('matches without distinguishing uppercase and lowercase', () => {
    expect(filterFiles(files, 'DOCS')).toEqual([files[0], files[1]]);
    expect(filterFiles(files, 'SPEC')).toEqual([files[0]]);
  });

  it('returns every file for an empty query', () => {
    expect(filterFiles(files, '')).toBe(files);
  });

  it('returns every file for a whitespace-only query', () => {
    expect(filterFiles(files, '   ')).toBe(files);
  });

  it('returns an empty array when no file matches', () => {
    expect(filterFiles(files, 'missing')).toEqual([]);
  });
});

describe('getAncestorDirectories', () => {
  it('returns every ancestor directory for a nested file', () => {
    expect(getAncestorDirectories([{ path: 'docs/design/mock.html' }])).toEqual(
      new Set(['docs', 'docs/design'])
    );
  });

  it('returns an empty set for a file at the root', () => {
    expect(getAncestorDirectories([{ path: 'doc.md' }])).toEqual(new Set());
  });
});
