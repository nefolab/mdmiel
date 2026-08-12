/**
 * エディタで開くためのURLを組み立てる。
 *
 * サーバーは root をOSネイティブ表記の絶対パスで返すため、ここでは区切りをスラッシュへ
 * 揃えたうえで結合とURLエンコードだけを行う。root が空 ( 公開構成 ) のときは null を
 * 返し、呼び出し側はボタンを描画しない。
 *
 * 形式は `<scheme>://file/<絶対パス>` で、VS Code系が受け付ける
 * `vscode://file/Users/me/doc.md` ( Windowsは `vscode://file/C:/work/doc.md` ) になる。
 */
export function buildEditorUrl(
  scheme: string,
  root: string,
  relPath: string
): string | null {
  if (!scheme || !root || !relPath) return null;

  const rootSlash = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const full = `${rootSlash}/${relPath}`;

  const encoded = full
    .split('/')
    .map((segment) =>
      // Windowsのドライブレター ( "C:" ) はコロンを残さないとエディタ側が解釈できない
      /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)
    )
    .join('/')
    // POSIXの絶対パスは先頭が "/" のため、"file/" の後ろで "//" になるのを避ける
    .replace(/^\/+/, '');

  return `${scheme}://file/${encoded}`;
}
