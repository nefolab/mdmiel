import { describe, it, expect } from 'vitest';
import {
  resolvePlacements,
  splitOrphaned,
  stackNotes,
  clampOffset,
  nextOffset,
  partitionStackable,
  combineUnresolved,
  buildLiveRawEntries,
  collectUnresolvedComments,
  ResolvedPlacement,
} from './stickyLayout';
import { Comment, computeSnippet, snippetHash } from './comments';

function makeComment(id: string, line: number, snippetText: string): Comment {
  return {
    version: 1,
    id,
    path: 'spec.md',
    anchor: { line, snippet: snippetText, snippetHash: snippetHash(computeSnippet(snippetText)) },
    body: `body ${id}`,
    author: 'nefo',
    createdAt: '2026-07-05T00:00:00Z',
    resolved: false,
  };
}

describe('resolvePlacements', () => {
  it('maps each comment to its rematched line', () => {
    const content = ['alpha', 'beta', 'gamma'].join('\n');
    const comments = [makeComment('a', 1, 'alpha'), makeComment('c', 3, 'gamma')];
    const placements = resolvePlacements(comments, content);
    expect(placements).toEqual([
      { comment: comments[0], line: 1, orphaned: false },
      { comment: comments[1], line: 3, orphaned: false },
    ]);
  });

  it('follows a line that has shifted and flags a vanished line as orphaned', () => {
    const commentOnBeta = makeComment('b', 2, 'beta');
    const commentGone = makeComment('x', 2, 'no longer present anywhere');

    // Insert a line before beta so it moves from line 2 to line 3.
    const shifted = ['alpha', 'inserted', 'beta', 'gamma'].join('\n');
    const placements = resolvePlacements([commentOnBeta, commentGone], shifted);

    expect(placements[0]).toEqual({ comment: commentOnBeta, line: 3, orphaned: false });
    expect(placements[1]).toEqual({ comment: commentGone, line: 2, orphaned: true });
  });

  it('bypasses text-based rematching for DOM-anchored comments (never orphaned at this level)', () => {
    const domComment: Comment = {
      version: 1,
      id: 'dom-1',
      path: 'mock.html',
      anchor: {
        line: 0,
        snippet: 'Submit',
        snippetHash: snippetHash(computeSnippet('Submit')),
        type: 'dom',
        selector: '#submit-btn',
      },
      body: 'dom comment',
      author: 'nefo',
      createdAt: '2026-07-18T00:00:00Z',
      resolved: false,
    };
    // Content has nothing resembling the DOM snippet anywhere; a text-based rematch
    // would report orphaned:true, but DOM anchors must skip that pass entirely.
    const content = ['<html>', '<body>completely unrelated text</body>', '</html>'].join('\n');
    const placements = resolvePlacements([domComment], content);
    expect(placements).toEqual([{ comment: domComment, line: 0, orphaned: false }]);
  });
});

describe('splitOrphaned', () => {
  it('separates placed and orphaned placements preserving order', () => {
    const c1 = makeComment('a', 1, 'x');
    const c2 = makeComment('b', 2, 'y');
    const c3 = makeComment('c', 3, 'z');
    const placements = [
      { comment: c1, line: 1, orphaned: false },
      { comment: c2, line: 2, orphaned: true },
      { comment: c3, line: 3, orphaned: false },
    ];
    const { placed, orphaned, missing } = splitOrphaned(placements);
    expect(placed.map((p) => p.comment.id)).toEqual(['a', 'c']);
    expect(orphaned.map((p) => p.comment.id)).toEqual(['b']);
    // Default predicate assumes every non-orphaned line has an element.
    expect(missing).toEqual([]);
  });

  it('classifies non-orphaned placements with no anchor element as missing', () => {
    const c1 = makeComment('a', 1, 'x');
    const c2 = makeComment('b', 2, 'y'); // orphaned
    const c3 = makeComment('c', 3, 'z'); // no DOM element -> missing
    const placements = [
      { comment: c1, line: 1, orphaned: false },
      { comment: c2, line: 2, orphaned: true },
      { comment: c3, line: 3, orphaned: false },
    ];
    // Only line 1 has a rendered element.
    const presentLines = new Set([1]);
    const { placed, orphaned, missing } = splitOrphaned(
      placements,
      (p) => presentLines.has(p.line)
    );
    expect(placed.map((p) => p.comment.id)).toEqual(['a']);
    expect(orphaned.map((p) => p.comment.id)).toEqual(['b']);
    expect(missing.map((p) => p.comment.id)).toEqual(['c']);
  });

  it('never routes an orphaned placement into missing even when its element is absent', () => {
    const c1 = makeComment('a', 5, 'x');
    const placements = [{ comment: c1, line: 5, orphaned: true }];
    const { placed, orphaned, missing } = splitOrphaned(placements, () => false);
    expect(placed).toEqual([]);
    expect(missing).toEqual([]);
    expect(orphaned.map((p) => p.comment.id)).toEqual(['a']);
  });
});

describe('stackNotes', () => {
  it('keeps desired positions when notes do not overlap', () => {
    const result = stackNotes(
      [
        { id: 'a', desiredTop: 0, height: 50 },
        { id: 'b', desiredTop: 200, height: 50 },
      ],
      10
    );
    expect(result).toEqual([
      { id: 'a', top: 0 },
      { id: 'b', top: 200 },
    ]);
  });

  it('pushes overlapping notes down by height + gap', () => {
    const result = stackNotes(
      [
        { id: 'a', desiredTop: 0, height: 50 },
        { id: 'b', desiredTop: 20, height: 50 },
        { id: 'c', desiredTop: 200, height: 50 },
      ],
      10
    );
    expect(result).toEqual([
      { id: 'a', top: 0 }, // cursor -> 60
      { id: 'b', top: 60 }, // max(20, 60), cursor -> 120
      { id: 'c', top: 200 }, // max(200, 120)
    ]);
  });

  it('sorts by desired top before stacking', () => {
    const result = stackNotes(
      [
        { id: 'low', desiredTop: 300, height: 40 },
        { id: 'high', desiredTop: 0, height: 40 },
      ],
      8
    );
    expect(result.map((r) => r.id)).toEqual(['high', 'low']);
    expect(result[0].top).toBe(0);
    expect(result[1].top).toBe(300);
  });

  it('is stable for equal desired tops', () => {
    const result = stackNotes(
      [
        { id: 'first', desiredTop: 10, height: 30 },
        { id: 'second', desiredTop: 10, height: 30 },
      ],
      5
    );
    expect(result).toEqual([
      { id: 'first', top: 10 },
      { id: 'second', top: 45 },
    ]);
  });
});

describe('partitionStackable', () => {
  it('routes items without an offset into stackable and items with one into offset', () => {
    const items = [
      { id: 'a', hasOffset: false },
      { id: 'b', hasOffset: true },
      { id: 'c', hasOffset: false },
    ];
    const { stackable, offset } = partitionStackable(items, (item) => item.hasOffset);
    expect(stackable.map((i) => i.id)).toEqual(['a', 'c']);
    expect(offset.map((i) => i.id)).toEqual(['b']);
  });

  it('preserves input order within each partition', () => {
    const items = [
      { id: 'a', hasOffset: true },
      { id: 'b', hasOffset: true },
      { id: 'c', hasOffset: false },
    ];
    const { stackable, offset } = partitionStackable(items, (item) => item.hasOffset);
    expect(stackable.map((i) => i.id)).toEqual(['c']);
    expect(offset.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('returns empty arrays for empty input', () => {
    const { stackable, offset } = partitionStackable<{ id: string }>([], () => false);
    expect(stackable).toEqual([]);
    expect(offset).toEqual([]);
  });
});

describe('combineUnresolved', () => {
  it('concatenates orphaned before missing, preserving each list\'s own order', () => {
    const o1 = makeComment('o1', 1, 'a');
    const o2 = makeComment('o2', 2, 'b');
    const m1 = makeComment('m1', 3, 'c');
    const m2 = makeComment('m2', 4, 'd');
    const orphaned = [
      { comment: o1, line: 1, orphaned: true },
      { comment: o2, line: 2, orphaned: true },
    ];
    const missing = [
      { comment: m1, line: 3, orphaned: false },
      { comment: m2, line: 4, orphaned: false },
    ];
    const result = combineUnresolved(orphaned, missing);
    expect(result.map((p) => p.comment.id)).toEqual(['o1', 'o2', 'm1', 'm2']);
  });

  it('returns an empty array when both inputs are empty', () => {
    expect(combineUnresolved([], [])).toEqual([]);
  });

  it('returns just the orphaned list unchanged when missing is empty', () => {
    const o1 = makeComment('o1', 1, 'a');
    const orphaned = [{ comment: o1, line: 1, orphaned: true }];
    expect(combineUnresolved(orphaned, [])).toEqual(orphaned);
  });
});

function makeDomComment(id: string, selector = '#el'): Comment {
  return {
    version: 1,
    id,
    path: 'mock.html',
    anchor: {
      line: 0,
      snippet: 'Submit',
      snippetHash: snippetHash(computeSnippet('Submit')),
      type: 'dom',
      selector,
    },
    body: `body ${id}`,
    author: 'nefo',
    createdAt: '2026-07-18T00:00:00Z',
    resolved: false,
  };
}

describe('buildLiveRawEntries', () => {
  it('marks a DOM-anchored candidate present with the rect-derived desiredTop when liveRects reports found:true', () => {
    const c = makeDomComment('a');
    const candidates: ResolvedPlacement[] = [{ comment: c, line: 0, orphaned: false }];
    const liveRects = { a: { found: true, rect: { top: 120, left: 0, width: 10, height: 10 }, visible: true } };

    const raw = buildLiveRawEntries(candidates, liveRects, /* iframeOffsetTop */ 50);

    expect(raw).toEqual([{ id: 'a', desiredTop: 170, present: true, visible: true }]);
  });

  it('marks present:false when liveRects reports found:false for the id (element resolved once, now gone)', () => {
    const c = makeDomComment('a');
    const candidates: ResolvedPlacement[] = [{ comment: c, line: 0, orphaned: false }];
    const liveRects = { a: { found: false, visible: false } };

    const raw = buildLiveRawEntries(candidates, liveRects, 50);

    expect(raw).toEqual([{ id: 'a', desiredTop: 0, present: false, visible: false }]);
  });

  it('marks present:false when the id is entirely missing from the liveRects snapshot (not yet resolved, or dropped)', () => {
    const c = makeDomComment('a');
    const candidates: ResolvedPlacement[] = [{ comment: c, line: 0, orphaned: false }];

    // Snapshot has entries for other ids, but not this candidate's.
    const raw = buildLiveRawEntries(candidates, { other: { found: true, rect: { top: 1, left: 1, width: 1, height: 1 }, visible: true } }, 50);

    expect(raw).toEqual([{ id: 'a', desiredTop: 0, present: false, visible: false }]);
  });

  it('marks present:false when liveRects itself is undefined (agent has not sent anything yet)', () => {
    const c = makeDomComment('a');
    const candidates: ResolvedPlacement[] = [{ comment: c, line: 0, orphaned: false }];

    const raw = buildLiveRawEntries(candidates, undefined, 50);

    expect(raw).toEqual([{ id: 'a', desiredTop: 0, present: false, visible: false }]);
  });

  it('marks present:false for a non-DOM (line-anchored) candidate even if liveRects happens to have a matching id', () => {
    const lineComment = makeComment('a', 3, 'gamma');
    const candidates: ResolvedPlacement[] = [{ comment: lineComment, line: 3, orphaned: false }];
    const liveRects = { a: { found: true, rect: { top: 10, left: 0, width: 1, height: 1 }, visible: true } };

    const raw = buildLiveRawEntries(candidates, liveRects, 0);

    expect(raw).toEqual([{ id: 'a', desiredTop: 0, present: false, visible: false }]);
  });

  it('reclassifies the same candidate as its liveRects entry changes across calls (found -> gone -> found again)', () => {
    const c = makeDomComment('a');
    const candidates: ResolvedPlacement[] = [{ comment: c, line: 0, orphaned: false }];

    const step1 = buildLiveRawEntries(candidates, { a: { found: true, rect: { top: 5, left: 0, width: 1, height: 1 }, visible: true } }, 0);
    expect(step1[0].present).toBe(true);

    // SPA navigated away: the agent's next mutation-triggered resend reports found:false.
    const step2 = buildLiveRawEntries(candidates, { a: { found: false, visible: false } }, 0);
    expect(step2[0].present).toBe(false);

    // SPA navigated back and the element re-resolved.
    const step3 = buildLiveRawEntries(candidates, { a: { found: true, rect: { top: 8, left: 0, width: 1, height: 1 }, visible: true } }, 0);
    expect(step3[0]).toEqual({ id: 'a', desiredTop: 8, present: true, visible: true });
  });
});

describe('collectUnresolvedComments', () => {
  it('resolves left and right ids into full Comment objects, left before right', () => {
    const l1 = makeComment('l1', 1, 'a');
    const l2 = makeComment('l2', 2, 'b');
    const r1 = makeComment('r1', 3, 'c');
    const commentsByPane = { left: [l1, l2], right: [r1] };

    const result = collectUnresolvedComments(commentsByPane, { left: ['l2'], right: ['r1'] });

    expect(result).toEqual([
      { pane: 'left', comment: l2 },
      { pane: 'right', comment: r1 },
    ]);
  });

  it('preserves the order ids were reported in, per pane', () => {
    const l1 = makeComment('l1', 1, 'a');
    const l2 = makeComment('l2', 2, 'b');
    const commentsByPane = { left: [l1, l2], right: [] };

    const result = collectUnresolvedComments(commentsByPane, { left: ['l2', 'l1'], right: [] });

    expect(result.map((r) => r.comment.id)).toEqual(['l2', 'l1']);
  });

  it('silently skips an id with no matching comment in that pane', () => {
    const l1 = makeComment('l1', 1, 'a');
    const commentsByPane = { left: [l1], right: [] };

    const result = collectUnresolvedComments(commentsByPane, { left: ['l1', 'ghost'], right: [] });

    expect(result.map((r) => r.comment.id)).toEqual(['l1']);
  });

  it('returns an empty array when both id lists are empty', () => {
    const commentsByPane = { left: [makeComment('l1', 1, 'a')], right: [makeComment('r1', 1, 'b')] };
    expect(collectUnresolvedComments(commentsByPane, { left: [], right: [] })).toEqual([]);
  });
});

describe('clampOffset', () => {
  it('passes normal values through unchanged', () => {
    expect(clampOffset(12, -34)).toEqual({ dx: 12, dy: -34 });
    expect(clampOffset(0, 0)).toEqual({ dx: 0, dy: 0 });
  });

  it('clamps dx independently above and below bounds', () => {
    expect(clampOffset(30000, 0)).toEqual({ dx: 20000, dy: 0 });
    expect(clampOffset(-30000, 0)).toEqual({ dx: -20000, dy: 0 });
  });

  it('clamps dy independently above and below bounds', () => {
    expect(clampOffset(0, 30000)).toEqual({ dx: 0, dy: 20000 });
    expect(clampOffset(0, -30000)).toEqual({ dx: 0, dy: -20000 });
  });

  it('clamps both axes at once when both exceed bounds', () => {
    expect(clampOffset(99999, -99999)).toEqual({ dx: 20000, dy: -20000 });
  });
});

describe('nextOffset', () => {
  it('combines base and delta', () => {
    expect(nextOffset({ dx: 10, dy: 20 }, { dx: 5, dy: -5 })).toEqual({ dx: 15, dy: 15 });
  });

  it('clamps the combined result when it exceeds bounds', () => {
    expect(nextOffset({ dx: 19999, dy: 0 }, { dx: 100, dy: 0 })).toEqual({ dx: 20000, dy: 0 });
    expect(nextOffset({ dx: -19999, dy: 0 }, { dx: -100, dy: 0 })).toEqual({ dx: -20000, dy: 0 });
  });
});
