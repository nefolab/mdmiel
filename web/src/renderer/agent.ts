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

  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
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

  window.addEventListener("scroll", function () { scheduleGeometry("scroll"); }, { passive: true });
  window.addEventListener("resize", function () { scheduleGeometry("resize"); });

  document.addEventListener("click", function (e) {
    var el = e.target;
    if (!el || el.nodeType !== 1) return;
    send({
      type: "pick",
      selector: buildSelector(el),
      text: extractText(el),
      rect: rectOf(el)
    });
  }, true);

  window.addEventListener("message", function (event) {
    if (parentOrigin && event.origin !== parentOrigin) return;
    var data = event.data;
    if (!data || typeof data !== "object" || data.nonce !== NONCE) return;
    if (data.type === "ping") {
      send({ type: "pong" });
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
