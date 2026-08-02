import { act, useRef } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Comment, computeSnippet, snippetHash } from '../lib/comments';
import { LiveRect, StickyNoteLayer } from './StickyNoteLayer';

let root: Root | undefined;
let mount: HTMLDivElement | undefined;

function lineComment(id: string, snippet: string): Comment {
  return {
    version: 1,
    id,
    path: 'page.html',
    anchor: { line: 1, snippet, snippetHash: snippetHash(computeSnippet(snippet)) },
    body: `body ${id}`,
    author: 'test',
    createdAt: '',
    resolved: false,
  };
}

const domComment: Comment = {
  version: 1,
  id: 'dom-1',
  path: 'page.html',
  anchor: { line: 0, type: 'dom', selector: '#target', snippet: 'Target', snippetHash: 'hash' },
  body: 'DOM note',
  author: 'test',
  createdAt: '',
  resolved: false,
};

interface ProbeProps {
  comments: Comment[];
  measured?: boolean;
  viewMode?: 'static' | 'live';
  type?: 'markdown' | 'html';
  liveRects?: Record<string, LiveRect>;
  onUnresolvedChange: (ids: string[]) => void;
}

function Probe({
  comments,
  measured,
  viewMode = 'live',
  type = 'html',
  liveRects = {
    'dom-1': { found: true, rect: { top: 10, left: 0, width: 20, height: 20 }, visible: true },
  },
  onUnresolvedChange,
}: ProbeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  return (
    <div ref={containerRef}>
      <iframe ref={iframeRef} />
      <StickyNoteLayer
        type={type}
        content="current content"
        comments={comments}
        containerRef={containerRef}
        iframeRef={iframeRef}
        viewMode={viewMode}
        liveRects={liveRects}
        measured={measured}
        onChanged={() => {}}
        onUnresolvedChange={onUnresolvedChange}
      />
    </div>
  );
}

function render(props: ProbeProps) {
  if (!mount) {
    mount = document.createElement('div');
    document.body.append(mount);
    root = createRoot(mount);
  }
  act(() => root?.render(<Probe {...props} />));
}

beforeEach(() => {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  mount?.remove();
  mount = undefined;
  vi.unstubAllGlobals();
});

describe('StickyNoteLayer deferred live measurement', () => {
  it('keeps the last unresolved ids while deferred and reports the new set after measurement resumes', () => {
    const onUnresolvedChange = vi.fn();
    render({ comments: [lineComment('old', 'missing old')], measured: true, onUnresolvedChange });
    expect(onUnresolvedChange).toHaveBeenLastCalledWith(['old']);

    render({ comments: [lineComment('new', 'missing new')], measured: false, onUnresolvedChange });
    expect(onUnresolvedChange).toHaveBeenCalledTimes(1);
    expect(onUnresolvedChange).toHaveBeenLastCalledWith(['old']);

    render({ comments: [lineComment('new', 'missing new')], measured: true, onUnresolvedChange });
    expect(onUnresolvedChange).toHaveBeenLastCalledWith(['new']);
  });

  it('reports when measured changes from false to true even if unresolved ids did not change', () => {
    const onUnresolvedChange = vi.fn();
    const comments = [lineComment('same', 'missing')];
    render({ comments, measured: true, onUnresolvedChange });
    expect(onUnresolvedChange).toHaveBeenCalledTimes(1);
    expect(onUnresolvedChange).toHaveBeenLastCalledWith(['same']);

    render({ comments, measured: false, onUnresolvedChange });
    expect(onUnresolvedChange).toHaveBeenCalledTimes(1);

    render({ comments, measured: true, onUnresolvedChange });
    expect(onUnresolvedChange).toHaveBeenCalledTimes(2);
    expect(onUnresolvedChange).toHaveBeenLastCalledWith(['same']);
  });

  it('defers missing-id reports produced by empty live rects until measurement completes', () => {
    const onUnresolvedChange = vi.fn();
    const comments = [domComment];
    render({ comments, measured: false, liveRects: {}, onUnresolvedChange });
    expect(onUnresolvedChange).not.toHaveBeenCalled();

    render({ comments, measured: true, liveRects: {}, onUnresolvedChange });
    expect(onUnresolvedChange).toHaveBeenLastCalledWith(['dom-1']);
  });

  it('uses the existing default reporting behavior for a static HTML pane', () => {
    const onUnresolvedChange = vi.fn();
    render({
      comments: [lineComment('static', 'missing')],
      viewMode: 'static',
      type: 'html',
      onUnresolvedChange,
    });
    expect(onUnresolvedChange).toHaveBeenCalledWith(['static']);
  });

  it('uses the existing default reporting behavior for a markdown pane', () => {
    const onUnresolvedChange = vi.fn();
    render({
      comments: [lineComment('markdown', 'missing')],
      viewMode: 'static',
      type: 'markdown',
      onUnresolvedChange,
    });
    expect(onUnresolvedChange).toHaveBeenCalledWith(['markdown']);
  });

  it('hides live notes until the current document has been measured', () => {
    const onUnresolvedChange = vi.fn();
    render({ comments: [domComment], measured: false, onUnresolvedChange });
    expect(mount?.querySelector('.sticky-note')).toBeNull();
    render({ comments: [domComment], measured: true, onUnresolvedChange });
    expect(mount?.querySelector('.sticky-note')).not.toBeNull();
  });
});
