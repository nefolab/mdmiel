import { describe, expect, it } from 'vitest';
import { fileKindIcon } from './fileKind';

describe('fileKindIcon', () => {
  it('uses a distinct icon for each known kind', () => {
    expect(fileKindIcon('markdown')).toBe('📝');
    expect(fileKindIcon('csv')).toBe('📊');
    expect(fileKindIcon('html')).toBe('🌐');
  });

  it('does not treat csv as the html globe', () => {
    expect(fileKindIcon('csv')).not.toBe(fileKindIcon('html'));
    expect(fileKindIcon('csv')).not.toBe(fileKindIcon('markdown'));
  });
});
