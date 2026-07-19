// ライブモード計測エージェント ( L0 PoC )。
//
// renderHtmlLive() が <head> 先頭にインラインスクリプトとして注入する、素のJSコード。
// iframe (sandbox="allow-scripts") 内で動き、window.__mdmielAgent 名前空間に閉じる。
// TypeScriptとして型チェックされるコードではなく、埋め込む文字列そのものである点に注意:
// テンプレートリテラル内でバックティック/`${` を使うと外側の記法と衝突するため使用しない。

const NONCE_PLACEHOLDER = '__MDMIEL_AGENT_NONCE__';

const AGENT_SCRIPT_TEMPLATE = `(function () {
  "use strict";
  var NONCE = "${NONCE_PLACEHOLDER}";
  var ns = {};
  window.__mdmielAgent = ns;

  // srcDoc iframeのopaque originからは document.location.ancestorOrigins[0] で
  // 親のoriginが取得できる ( Chromium系 )。取得できない場合は検証をnonceのみに委ねる。
  var parentOrigin = null;
  try {
    if (window.location.ancestorOrigins && window.location.ancestorOrigins.length > 0) {
      parentOrigin = window.location.ancestorOrigins[0];
    }
  } catch (e) {}

  // ancestorOrigins が取得できない環境 ( Firefox/Safari等 ) 向けの追加防御: nonce一致で
  // 最初に受理したメッセージの event.origin を記憶し、以降はそのoriginのみ受理する
  // ( pinning )。nonceはURLに埋め込まれず親から直接注入されるため単体でも十分頑丈だが、
  // 万一nonceが漏れても以後は送信元originを固定できるようにする多層防御。
  var pinnedOrigin = null;

  function send(msg) {
    try {
      var payload = { mdmiel: true, nonce: NONCE };
      for (var key in msg) {
        if (Object.prototype.hasOwnProperty.call(msg, key)) payload[key] = msg[key];
      }
      window.parent.postMessage(payload, "*");
    } catch (e) {}
  }
  ns.send = send;

  function getSize() {
    var de = document.documentElement;
    var body = document.body;
    return {
      w: Math.max(de ? de.scrollWidth : 0, body ? body.scrollWidth : 0),
      h: Math.max(de ? de.scrollHeight : 0, body ? body.scrollHeight : 0)
    };
  }

  function buildSelector(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el.id) {
      var escapedId = (window.CSS && typeof window.CSS.escape === "function") ? window.CSS.escape(el.id) : el.id;
      return "#" + escapedId;
    }
    var testId = el.getAttribute && el.getAttribute("data-testid");
    if (testId) {
      return "[data-testid=" + JSON.stringify(testId) + "]";
    }

    var path = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 20) {
      var tag = node.tagName.toLowerCase();
      var parent = node.parentElement;
      if (!parent) {
        path.unshift(tag);
        break;
      }
      var siblings = [];
      for (var i = 0; i < parent.children.length; i++) {
        if (parent.children[i].tagName === node.tagName) siblings.push(parent.children[i]);
      }
      var index = siblings.indexOf(node) + 1;
      path.unshift(tag + ":nth-of-type(" + index + ")");
      node = parent;
      depth++;
    }
    return path.join(" > ");
  }

  function extractText(el) {
    var raw = (el && el.textContent) ? el.textContent : "";
    var text = raw.replace(/\\s+/g, " ").trim();
    return text.length > 80 ? text.slice(0, 80) : text;
  }

  // FNV-1a, duplicated from web/src/lib/comments.ts snippetHash() byte-for-byte
  // (same constants 0x811c9dc5 / 0x01000193, same >>> 0 + toString(16) + padStart(8, "0")
  // rendering). Both sides must independently produce the same hash for the same
  // (already-normalized) string; renderer/agent.test.ts extracts this function from the
  // rendered script and asserts it against lib/comments.ts's snippetHash for shared inputs.
  function fnv1aHash(str) {
    var hash = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  }

  var geometryRaf = null;
  function scheduleGeometry(kind) {
    if (geometryRaf !== null) return;
    geometryRaf = window.requestAnimationFrame(function () {
      geometryRaf = null;
      if (kind === "scroll") {
        send({ type: "scroll", x: window.scrollX, y: window.scrollY });
      } else {
        send({ type: "resize", size: getSize() });
      }
    });
  }

  // --- DOMアンカー解決 (BridgeResolver) ----------------------------------
  // 親から {type:"anchors", anchors:[{id, selector, snippet, snippetHash}]} を受けるたびに
  // anchorsを差し替えてresolveAll()し、以後はresolvedMapに保持した要素参照から矩形だけを
  // 再計算する (scroll/resizeでは再解決しない = 安価)。MutationObserverはSPA再描画で要素の
  // アイデンティティが変わりうるため、発火のたびにresolveAll()からやり直す。
  var anchors = [];
  var resolvedMap = {};

  // querySelectorAll("*")によるテキストハッシュ総当たりフォールバックの走査上限。
  // 巨大なDOMツリー ( 数万要素規模のプロトタイプ ) でMutationObserver発火のたびに
  // 全要素のtextContent抽出+FNV-1aハッシュ計算を行うとメインスレッドを長時間ブロック
  // しうるため、上限を超えたら見つからなかった ( found:false ) ものとして打ち切る。
  var MAX_TEXT_HASH_SCAN = 5000;

  // セレクタ文字列の末尾セグメント (" > "区切りの最後) からタグ名を導出する。buildSelector()が
  // 生成する形式 (id/data-testidセレクタ単体、または "tag:nth-of-type(n)" のパス) のうち、
  // 末尾が "tag" または "tag:nth-of-type(n)" のときだけ導出できる。id/data-testidセレクタは
  // "#" / "[" で始まるため導出できず null を返し、呼び出し側は検証をスキップする。
  function deriveTagFromSelector(selector) {
    if (!selector) return null;
    var segments = selector.split(">");
    var last = segments[segments.length - 1];
    if (!last) return null;
    last = last.trim();
    var m = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(last);
    return m ? m[1].toLowerCase() : null;
  }

  function resolveOne(anchor) {
    var el = null;
    if (anchor.selector) {
      try {
        el = document.querySelector(anchor.selector);
      } catch (e) {
        el = null;
      }
    }
    // 空snippet (正規化後) のアンカーはテキストハッシュの全要素走査フォールバックを行わない。
    // テキストを持たない要素は「同じ空ハッシュを持つ最初の要素」に誤スナップしやすく、その
    // 要素が不可視だと見つかったのに表示されない付箋を生む (実バグ再現済み: snippet="" /
    // snippetHash=811c9dc5のコメントがスケルトン要素ではなく別の不可視要素に誤スナップし、
    // found:true かつ visible:false のまま orphaned にも落ちなかった)。セレクタが一致するか
    // 否かだけで判定し ( ハッシュ照合もフォールバックも行わない )、一致しなければfound:falseとする。
    if (anchor.snippet === "") {
      return el;
    }
    if (el && fnv1aHash(extractText(el)) === anchor.snippetHash) {
      return el;
    }
    // セレクタ不一致/テキスト不一致: 全要素走査でテキストハッシュが一致する最初の要素を探す。
    // セレクタがあり末尾タグ名が導出できる場合は、候補要素のタグ名が一致しないものは採用しない
    // ( 別種の要素への誤スナップ防止 )。導出できないセレクタ形式では検証をスキップする。
    var expectedTag = anchor.selector ? deriveTagFromSelector(anchor.selector) : null;
    var all = document.querySelectorAll("*");
    var scanLimit = Math.min(all.length, MAX_TEXT_HASH_SCAN);
    for (var i = 0; i < scanLimit; i++) {
      var candidate = all[i];
      if (fnv1aHash(extractText(candidate)) === anchor.snippetHash) {
        if (expectedTag && candidate.tagName.toLowerCase() !== expectedTag) continue;
        return candidate;
      }
    }
    return null;
  }

  function resolveAll() {
    var nextMap = {};
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      nextMap[a.id] = resolveOne(a);
    }
    resolvedMap = nextMap;
  }

  function isRectVisible(r) {
    var vw = window.innerWidth || document.documentElement.clientWidth || 0;
    var vh = window.innerHeight || document.documentElement.clientHeight || 0;
    return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
  }

  // 解決済み要素が「レンダリングされている」とみなせるか。サイズ0 (width/height両方0)、
  // またはdisplay:none/visibility:hiddenのいずれかならレンダリングされていないとみなし
  // found:falseにする。ビューポート外にスクロールしているだけの要素の判定はisRectVisible()
  // 側 (found:true + visible:false) に委ねており、ここでは対象にしない。
  function isElementRenderable(el, r) {
    if (r.width === 0 && r.height === 0) return false;
    var style = window.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function sendRectsNow() {
    var rects = [];
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      var el = resolvedMap[a.id];
      if (!el || !document.contains(el)) {
        rects.push({ id: a.id, found: false });
        continue;
      }
      var r = el.getBoundingClientRect();
      if (!isElementRenderable(el, r)) {
        rects.push({ id: a.id, found: false });
        continue;
      }
      rects.push({
        id: a.id,
        found: true,
        rect: { top: r.top, left: r.left, width: r.width, height: r.height },
        visible: isRectVisible(r)
      });
    }
    send({ type: "rects", rects: rects });
  }

  var rectsRaf = null;
  function scheduleRects() {
    if (rectsRaf !== null) return;
    rectsRaf = window.requestAnimationFrame(function () {
      rectsRaf = null;
      sendRectsNow();
    });
  }

  if (typeof MutationObserver === "function") {
    var observer = new MutationObserver(function () {
      resolveAll();
      scheduleRects();
    });
    // claude designプロトタイプ ( claude.aiバンドル形式 ) は起動時に
    // document.documentElement.replaceWith(...) でルート要素ごと差し替える。
    // documentElementそのものを観測対象にすると、差し替え後のold nodeは
    // ツリーから切り離されて二度とmutationを発生させず、observerは死んだままになる。
    // documentノード自身はdocumentElementが何度差し替わっても不変なので、これを
    // 観測すれば差し替え (documentへのchildList mutation) も、差し替え後の新しい
    // ツリー内の変化 (subtree) も引き続き検知できる。張り直しは不要。
    observer.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
  }
  // -------------------------------------------------------------------------

  window.addEventListener("scroll", function () { scheduleGeometry("scroll"); scheduleRects(); }, { passive: true });
  window.addEventListener("resize", function () { scheduleGeometry("resize"); scheduleRects(); });

  // "コメント追加"がarmされている間だけtrue。親からの{type:"commentMode",on}で
  // 切り替わる。offの間はクリックのたびにpickを送らない ( 無条件送信をやめる。親側の
  // bridge.armedチェックは防御として残るが、agent側でも不要な送信自体を止める )。
  var commentModeOn = false;

  // --- コメントモードhoverハイライト (L2) --------------------------------
  // commentMode ON中、hover中の要素にoutlineを表示する。書き換えるのはoutline系の3プロパティ
  // のみに限定する ( インラインstyle全体の退避・復元だと、モック側JSが同時刻に書き込んだ
  // 無関係なスタイル変更まで巻き戻してしまうため )。プロパティ単位で元値を退避し、ハイライト
  // 解除時にそのまま書き戻す ( 元々未設定なら空文字に戻り、setで実質削除される )。
  var HOVER_STYLE_PROPS = ["outline", "outlineOffset", "backgroundColor"];
  var hoverEl = null;
  var hoverSavedStyle = null;

  function clearHover() {
    if (!hoverEl) return;
    for (var i = 0; i < HOVER_STYLE_PROPS.length; i++) {
      var prop = HOVER_STYLE_PROPS[i];
      hoverEl.style[prop] = hoverSavedStyle[prop];
    }
    hoverEl = null;
    hoverSavedStyle = null;
  }

  function applyHover(el) {
    if (el === hoverEl) return;
    clearHover();
    if (!el || el.nodeType !== 1) return;
    var saved = {};
    for (var i = 0; i < HOVER_STYLE_PROPS.length; i++) {
      var prop = HOVER_STYLE_PROPS[i];
      saved[prop] = el.style[prop];
    }
    el.style.outline = "2px solid rgba(255, 149, 0, 0.9)";
    el.style.outlineOffset = "-2px";
    el.style.backgroundColor = "rgba(255, 149, 0, 0.15)";
    hoverEl = el;
    hoverSavedStyle = saved;
  }

  // mouseover/mouseoutはネストした子要素間の移動で連続発火しうるため、実際のstyle書き換えは
  // rAFで1フレームにつき最後の対象だけへ間引く ( scheduleHover(null)はハイライト解除の予約 )。
  var hoverRaf = null;
  var hoverPending = null;
  var hoverPendingSet = false;
  function scheduleHover(target) {
    hoverPending = target;
    hoverPendingSet = true;
    if (hoverRaf !== null) return;
    hoverRaf = window.requestAnimationFrame(function () {
      hoverRaf = null;
      if (hoverPendingSet) {
        applyHover(hoverPending);
        hoverPendingSet = false;
      }
    });
  }

  function cancelScheduledHover() {
    hoverPendingSet = false;
    if (hoverRaf !== null) {
      window.cancelAnimationFrame(hoverRaf);
      hoverRaf = null;
    }
  }

  document.addEventListener("mouseover", function (e) {
    if (!commentModeOn) return;
    var el = e.target;
    if (!el || el.nodeType !== 1) return;
    scheduleHover(el);
  }, true);

  document.addEventListener("mouseout", function (e) {
    if (!commentModeOn) return;
    var related = e.relatedTarget;
    if (related && hoverEl && (related === hoverEl || (hoverEl.contains && hoverEl.contains(related)))) return;
    scheduleHover(null);
  }, true);
  // -------------------------------------------------------------------------

  document.addEventListener("click", function (e) {
    if (!commentModeOn) return;
    var el = e.target;
    if (!el || el.nodeType !== 1) return;
    var text = extractText(el);
    send({
      type: "pick",
      selector: buildSelector(el),
      text: text,
      snippet: text,
      snippetHash: fnv1aHash(text),
      rect: rectOf(el)
    });
    // pick確定でハイライトを確実に消す ( commentModeのoff往復を待たない )。
    cancelScheduledHover();
    clearHover();
  }, true);

  window.addEventListener("message", function (event) {
    if (parentOrigin && event.origin !== parentOrigin) return;
    if (!parentOrigin && pinnedOrigin !== null && event.origin !== pinnedOrigin) return;
    var data = event.data;
    if (!data || typeof data !== "object" || data.nonce !== NONCE) return;
    if (!parentOrigin && pinnedOrigin === null) {
      pinnedOrigin = event.origin;
    }
    if (data.type === "ping") {
      send({ type: "pong" });
    } else if (data.type === "anchors" && data.anchors && typeof data.anchors.length === "number") {
      anchors = data.anchors;
      resolveAll();
      scheduleRects();
    } else if (data.type === "commentMode" && typeof data.on === "boolean") {
      commentModeOn = data.on;
      if (!commentModeOn) {
        cancelScheduledHover();
        clearHover();
      }
    } else if (data.type === "scrollTo" && typeof data.selector === "string") {
      var target = null;
      try {
        target = document.querySelector(data.selector);
      } catch (e) {
        target = null;
      }
      if (target && target.scrollIntoView) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  });

  function sendReady() {
    send({ type: "ready", size: getSize() });
  }

  if (document.readyState === "complete") {
    sendReady();
  } else {
    window.addEventListener("load", sendReady, { once: true });
  }
})();
`;

/** AGENT_SCRIPT_TEMPLATE中のnonceプレースホルダを実値に置換したスクリプト文字列を返す。 */
export function renderAgentScript(nonce: string): string {
  return AGENT_SCRIPT_TEMPLATE.split(NONCE_PLACEHOLDER).join(nonce);
}

export { NONCE_PLACEHOLDER };
