import { parse, serialize } from 'parse5';

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
