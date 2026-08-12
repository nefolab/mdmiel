/**
 * エディタで開くためのURLを組み立てる。
 *
 * 形式は `<scheme>://file/<絶対パス>` で、VS Code系が受け付ける
 * `vscode://file/Users/me/doc.md` ( Windowsは `vscode://file/C:/work/doc.md`、
 * UNCは `vscode://file//server/share/doc.md` ) になる。
 *
 * absPath はサーバーが解決済みの絶対パスで、区切りはスラッシュに揃えて渡ってくる。
 * ここで "\" を "/" へ変換してはならない。実行OSを知らないフロントで一律に潰すと、
 * POSIXで正当なファイル名 ( ディレクトリ名に "\" を含むもの ) を壊すため。
 *
 * absPath が空 ( 公開構成 ) のときは null を返し、呼び出し側はボタンを描画しない。
 */

/**
 * ブラウザが自前で解釈するスキーム。サーバーの WithEditorScheme でも拒否しているが、
 * 生成URLをアンカーの href に入れる以上、値を受け取る側でも止める ( 多層防御 )。
 */
const DENIED_SCHEMES = new Set([
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
]);

/** RFC 3986 のスキーム文法に沿い、先頭は英字・以降は英数字とハイフンだけ許す */
const SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9-]*$/;

export function buildEditorUrl(scheme: string, absPath: string): string | null {
  if (!scheme || !absPath) return null;
  if (!SCHEME_PATTERN.test(scheme) || DENIED_SCHEMES.has(scheme.toLowerCase())) {
    return null;
  }

  const encoded = absPath
    .split('/')
    .map((segment) =>
      // Windowsのドライブレター ( "C:" ) はコロンを残さないとエディタ側が解釈できない
      /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)
    )
    .join('/');

  // POSIXの絶対パスは先頭が "/"、UNCは "//" で、どちらもそのまま維持する必要がある。
  // Windowsのドライブレター始まりだけスラッシュが無いので補う。
  const path = encoded.startsWith('/') ? encoded : `/${encoded}`;

  return `${scheme}://file${path}`;
}
