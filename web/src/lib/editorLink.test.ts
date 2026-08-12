import { describe, it, expect } from 'vitest';
import { buildEditorUrl } from './editorLink';

describe('buildEditorUrl', () => {
  it('POSIXの絶対パスをスラッシュ1つで繋ぐ', () => {
    expect(buildEditorUrl('vscode', '/Users/me/work', 'docs/spec.md')).toBe(
      'vscode://file/Users/me/work/docs/spec.md'
    );
  });

  it('Windowsの区切りをスラッシュへ揃え、ドライブレターのコロンは残す', () => {
    expect(buildEditorUrl('vscode', 'C:\\work\\proj', 'docs/spec.md')).toBe(
      'vscode://file/C:/work/proj/docs/spec.md'
    );
  });

  it('rootの末尾スラッシュを重複させない', () => {
    expect(buildEditorUrl('vscode', '/Users/me/work/', 'spec.md')).toBe(
      'vscode://file/Users/me/work/spec.md'
    );
  });

  it('スキームを差し替えられる', () => {
    expect(buildEditorUrl('cursor', '/root', 'a.md')).toBe('cursor://file/root/a.md');
  });

  it('URLで意味を持つ文字を含むファイル名をエンコードする', () => {
    expect(buildEditorUrl('vscode', '/root', 'a b#c?d.md')).toBe(
      'vscode://file/root/a%20b%23c%3Fd.md'
    );
  });

  it('ディレクトリ区切りはエンコードせず保つ', () => {
    expect(buildEditorUrl('vscode', '/root', 'dir one/sub/x.md')).toBe(
      'vscode://file/root/dir%20one/sub/x.md'
    );
  });

  it('rootが空 ( 公開構成 ) ならnullを返す', () => {
    expect(buildEditorUrl('vscode', '', 'a.md')).toBeNull();
  });

  it('schemeが空ならnullを返す', () => {
    expect(buildEditorUrl('', '/root', 'a.md')).toBeNull();
  });

  it('relPathが空ならnullを返す', () => {
    expect(buildEditorUrl('vscode', '/root', '')).toBeNull();
  });
});
