import { describe, it, expect } from 'vitest';
import { buildEditorUrl } from './editorLink';

describe('buildEditorUrl', () => {
  it('POSIXの絶対パスをそのまま載せる', () => {
    expect(buildEditorUrl('vscode', '/Users/me/work/docs/spec.md')).toBe(
      'vscode://file/Users/me/work/docs/spec.md'
    );
  });

  it('Windowsのドライブレターはコロンを残し、スラッシュを補う', () => {
    expect(buildEditorUrl('vscode', 'C:/work/proj/docs/spec.md')).toBe(
      'vscode://file/C:/work/proj/docs/spec.md'
    );
  });

  it('UNCの先頭ダブルスラッシュを保つ', () => {
    expect(buildEditorUrl('vscode', '//server/share/project/doc.md')).toBe(
      'vscode://file//server/share/project/doc.md'
    );
  });

  it('POSIXで正当なバックスラッシュ入りディレクトリ名を区切りに変えない', () => {
    // サーバーが filepath.ToSlash 済みの値を返すため、ここでの "\" はファイル名の一部
    expect(buildEditorUrl('vscode', '/tmp/a\\b/doc.md')).toBe(
      'vscode://file/tmp/a%5Cb/doc.md'
    );
  });

  it('スキームを差し替えられる', () => {
    expect(buildEditorUrl('cursor', '/root/a.md')).toBe('cursor://file/root/a.md');
  });

  it('URLで意味を持つ文字を含むファイル名をエンコードする', () => {
    expect(buildEditorUrl('vscode', '/root/a b#c?d.md')).toBe(
      'vscode://file/root/a%20b%23c%3Fd.md'
    );
  });

  it('パーセント記号を二重エンコードする ( すでにエンコード済みに見える名前を壊さない )', () => {
    expect(buildEditorUrl('vscode', '/root/a%20b.md')).toBe('vscode://file/root/a%2520b.md');
    expect(buildEditorUrl('vscode', '/root/100%.md')).toBe('vscode://file/root/100%25.md');
    expect(buildEditorUrl('vscode', '/root/a%2Fb.md')).toBe('vscode://file/root/a%252Fb.md');
  });

  it('改行・行区切り文字をエンコードする', () => {
    expect(buildEditorUrl('vscode', '/root/\na.md')).toBe('vscode://file/root/%0Aa.md');
    expect(buildEditorUrl('vscode', '/root/\r\na.md')).toBe('vscode://file/root/%0D%0Aa.md');
    // U+2028 ( LINE SEPARATOR ) はWindowsのファイル名にも入れられる
    expect(buildEditorUrl('vscode', '/root/\u2028a.md')).toBe(
      'vscode://file/root/%E2%80%A8a.md'
    );
  });

  it('マルチバイト文字をエンコードする', () => {
    expect(buildEditorUrl('vscode', '/root/仕様.md')).toBe(
      'vscode://file/root/%E4%BB%95%E6%A7%98.md'
    );
  });

  it('途中のディレクトリ名の記号もエンコードする', () => {
    expect(buildEditorUrl('vscode', '/my work#1/a.md')).toBe(
      'vscode://file/my%20work%231/a.md'
    );
  });

  it('ディレクトリ区切りはエンコードせず保つ', () => {
    expect(buildEditorUrl('vscode', '/root/dir one/sub/x.md')).toBe(
      'vscode://file/root/dir%20one/sub/x.md'
    );
  });

  it('absPathが空 ( 公開構成 ) ならnullを返す', () => {
    expect(buildEditorUrl('vscode', '')).toBeNull();
  });

  it('schemeが空ならnullを返す', () => {
    expect(buildEditorUrl('', '/root/a.md')).toBeNull();
  });

  it('ブラウザが解釈するスキームを拒否する', () => {
    // 実装の拒否リスト全11種を明示する ( 1つ削る変異を検出するため )
    const denied = [
      'javascript',
      'vbscript',
      'data',
      'blob',
      'file',
      'http',
      'https',
      'about',
      'ws',
      'wss',
      'JavaScript',
    ];
    for (const scheme of denied) {
      expect(buildEditorUrl(scheme, '/root/a.md')).toBeNull();
    }
  });

  it('スキーム文法に合わない値を拒否する', () => {
    for (const scheme of ['1editor', '-editor', 'vscode://', 'vs code', 'vscode:']) {
      expect(buildEditorUrl(scheme, '/root/a.md')).toBeNull();
    }
  });
});
