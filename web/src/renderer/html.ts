import { parse, serialize } from 'parse5';
import { renderAgentScript } from './agent';

/** parse5's NS.HTML namespace URI. See renderHtmlLive's manually-constructed node comments. */
const HTML_NS = 'http://www.w3.org/1999/xhtml';

/**
 * Parses raw HTML, injects `data-source-line` attributes on all elements based on their
 * source code locations, and injects a `<base>` tag into the `<head>` to resolve relative resources.
 *
 * @param html The raw HTML string.
 * @param path The relative path of the file (e.g. 'sub/a.html' or 'a.html').
 */
export function renderHtml(html: string, path: string): string {
  // Determine parent directory path for the base tag.
  // Example: 'sub/a.html' -> 'sub/'
  // Example: 'a.html' -> ''
  const lastSlash = path.lastIndexOf('/');
  const parentDir = lastSlash !== -1 ? path.substring(0, lastSlash + 1) : '';
  const baseHref = `/raw/${parentDir}`;

  // Parse HTML with location info enabled.
  const document = parse(html, { sourceCodeLocationInfo: true });

  // Helper to recursively traverse and modify nodes.
  const traverse = (node: any) => {
    if (node.tagName) {
      // 1. Inject data-source-line attribute if location info is available.
      if (node.sourceCodeLocation) {
        const startLine = node.sourceCodeLocation.startLine;
        if (!node.attrs) {
          node.attrs = [];
        }
        const hasSourceLine = node.attrs.some((attr: any) => attr.name === 'data-source-line');
        if (!hasSourceLine) {
          node.attrs.push({ name: 'data-source-line', value: String(startLine) });
        }
      }

      // 2. Inject <base> tag and highlighting style into <head>.
      if (node.tagName === 'head') {
        if (!node.attrs) {
          node.attrs = [];
        }
        if (!node.childNodes) {
          node.childNodes = [];
        }
        const hasBase = node.childNodes.some((child: any) => child.tagName === 'base');
        if (!hasBase) {
          const baseNode = {
            nodeName: 'base',
            tagName: 'base',
            attrs: [{ name: 'href', value: baseHref }],
            childNodes: [],
            parentNode: node,
          };
          node.childNodes.unshift(baseNode);
        }

        const hasStyle = node.childNodes.some((child: any) => child.tagName === 'style' && child.attrs?.some((a: any) => a.name === 'data-mdmiel-style'));
        if (!hasStyle) {
          const styleNode = {
            nodeName: 'style',
            tagName: 'style',
            attrs: [{ name: 'data-mdmiel-style', value: 'true' }],
            childNodes: [
              {
                nodeName: '#text',
                value: `
                  @keyframes highlightPulse {
                    0% { background-color: rgba(99, 102, 241, 0.25); outline: 2px solid #6366f1; }
                    50% { background-color: rgba(99, 102, 241, 0.4); outline: 2px solid #6366f1; }
                    100% { background-color: transparent; outline: 2px solid transparent; }
                  }
                  .source-line-highlight {
                    animation: highlightPulse 3s cubic-bezier(0.4, 0, 0.2, 1) forwards;
                    border-radius: 4px;
                  }
                `
              }
            ],
            parentNode: node,
          };
          node.childNodes.push(styleNode);
        }
      }
    }

    if (node.childNodes) {
      node.childNodes.forEach((child: any) => traverse(child));
    }
  };

  traverse(document);

  return serialize(document);
}

/**
 * Parses raw HTML and injects a `<base>` tag into the `<head>` (same as renderHtml), but instead
 * of `data-source-line` attributes and the highlight style, injects the measurement agent's inline
 * script as the first child of `<head>`. Used by the "live" preview mode (L0 PoC): the agent runs
 * inside a sandbox="allow-scripts" iframe and reports geometry/click events to the parent via
 * postMessage, authenticated with `nonce`.
 *
 * @param html The raw HTML string.
 * @param path The relative path of the file (e.g. 'sub/a.html' or 'a.html').
 * @param nonce Per-pane-load handshake token embedded in the agent script.
 */
export function renderHtmlLive(html: string, path: string, nonce: string): string {
  const lastSlash = path.lastIndexOf('/');
  const parentDir = lastSlash !== -1 ? path.substring(0, lastSlash + 1) : '';
  const baseHref = `/raw/${parentDir}`;

  const document = parse(html, { sourceCodeLocationInfo: true });

  const traverse = (node: any) => {
    if (node.tagName === 'head') {
      if (!node.attrs) {
        node.attrs = [];
      }
      if (!node.childNodes) {
        node.childNodes = [];
      }

      // Inject <base> tag to resolve relative resources, same as renderHtml.
      //
      // namespaceURI must be set on manually-constructed nodes: parse5's serializer only
      // treats an element as void (self-closing, no children serialized) when
      // treeAdapter.getNamespaceURI(node) === NS.HTML. Nodes built via parse()/the real
      // tree adapter always have this set; ours don't unless set explicitly.
      const hasBase = node.childNodes.some((child: any) => child.tagName === 'base');
      if (!hasBase) {
        const baseNode = {
          nodeName: 'base',
          tagName: 'base',
          namespaceURI: HTML_NS,
          attrs: [{ name: 'href', value: baseHref }],
          childNodes: [],
          parentNode: node,
        };
        node.childNodes.unshift(baseNode);
      }

      // Inject the measurement agent as the very first element of <head>, so it starts
      // observing before the mock's own scripts run.
      //
      // Both namespaceURI on the <script> element AND a correct parentNode on its text
      // child are required for parse5 to serialize the JS as raw text instead of
      // HTML-entity-escaping it (see serializeTextNode: it walks up to the parent to check
      // getNamespaceURI(parent) === NS.HTML && hasUnescapedText(parentTagName)). Getting
      // this wrong silently corrupts the agent's JS (e.g. "&&" becomes "&amp;&amp;"),
      // producing a syntax error that never runs at runtime.
      const hasAgent = node.childNodes.some(
        (child: any) => child.tagName === 'script' && child.attrs?.some((a: any) => a.name === 'data-mdmiel-agent')
      );
      if (!hasAgent) {
        const scriptNode: any = {
          nodeName: 'script',
          tagName: 'script',
          namespaceURI: HTML_NS,
          attrs: [{ name: 'data-mdmiel-agent', value: 'true' }],
          childNodes: [],
          parentNode: node,
        };
        scriptNode.childNodes.push({
          nodeName: '#text',
          value: renderAgentScript(nonce),
          parentNode: scriptNode,
        });
        node.childNodes.unshift(scriptNode);
      }
    }

    if (node.childNodes) {
      node.childNodes.forEach((child: any) => traverse(child));
    }
  };

  traverse(document);

  return serialize(document);
}
