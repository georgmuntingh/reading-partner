import { describe, it, expect } from 'vitest';
import {
    computePageOffsets,
    pageForOffset,
    pageRange,
    mergeRectsToLineBottoms,
    largestAtOrBefore
} from '../js/utils/page-breaker.js';

/**
 * Build a break finder for content laid out on a uniform line grid, which is
 * what a plain prose chapter looks like.
 * @param {number} lineHeight
 */
function gridBreakFinder(lineHeight) {
    return (target, pageTop) => {
        const snapped = Math.floor(target / lineHeight) * lineHeight;
        return snapped > pageTop ? snapped : pageTop;
    };
}

describe('computePageOffsets', () => {
    it('snaps every break down to a line boundary', () => {
        // 431px viewport / 28.8px lines => 14.97 lines, i.e. line 15 gets sliced
        // by the old `page * pageHeight` arithmetic.
        const lineHeight = 28.8;
        const offsets = computePageOffsets(2000, 431, gridBreakFinder(lineHeight));

        for (const offset of offsets) {
            const lines = offset / lineHeight;
            expect(lines).toBeCloseTo(Math.round(lines), 6);
        }
    });

    it('never lets a page exceed the viewport height', () => {
        const offsets = computePageOffsets(2000, 431, gridBreakFinder(28.8));

        for (let i = 1; i < offsets.length; i++) {
            expect(offsets[i] - offsets[i - 1]).toBeLessThanOrEqual(431);
        }
    });

    it('advances monotonically and starts at zero', () => {
        const offsets = computePageOffsets(2000, 431, gridBreakFinder(28.8));

        expect(offsets[0]).toBe(0);
        for (let i = 1; i < offsets.length; i++) {
            expect(offsets[i]).toBeGreaterThan(offsets[i - 1]);
        }
    });

    it('covers all content', () => {
        const contentBottom = 2000;
        const pageHeight = 431;
        const offsets = computePageOffsets(contentBottom, pageHeight, gridBreakFinder(28.8));

        const last = offsets[offsets.length - 1];
        expect(last + pageHeight).toBeGreaterThanOrEqual(contentBottom - 1);
    });

    it('returns a single page when the content fits', () => {
        expect(computePageOffsets(300, 431, gridBreakFinder(28.8))).toEqual([0]);
    });

    it('does not add a page for content that exactly fills the viewport', () => {
        expect(computePageOffsets(431, 431, gridBreakFinder(28.8))).toEqual([0]);
    });

    it('falls back to a hard cut when no safe break exists in a page', () => {
        // Simulates a single element taller than the viewport: nothing to snap to.
        const offsets = computePageOffsets(1000, 400, (_target, pageTop) => pageTop);

        expect(offsets).toEqual([0, 400, 800]);
    });

    it('pushes an unbreakable block onto the next page', () => {
        // A 300px image occupying [350, 650); the only safe break inside page 1
        // is its top edge.
        const findBreak = (target, pageTop) => {
            if (target > 350 && target < 650) return 350;
            return Math.floor(target / 20) * 20 > pageTop ? Math.floor(target / 20) * 20 : pageTop;
        };
        const offsets = computePageOffsets(1200, 400, findBreak);

        expect(offsets[1]).toBe(350);
    });

    it('handles degenerate input without looping forever', () => {
        expect(computePageOffsets(0, 400, gridBreakFinder(20))).toEqual([0]);
        expect(computePageOffsets(1000, 0, gridBreakFinder(20))).toEqual([0]);
        expect(computePageOffsets(1000, -5, gridBreakFinder(20))).toEqual([0]);
    });

    it('respects the maxPages safety valve', () => {
        const offsets = computePageOffsets(1e9, 10, gridBreakFinder(10), 50);
        expect(offsets).toHaveLength(50);
    });
});

describe('pageForOffset', () => {
    const offsets = [0, 400, 780, 1160];

    it('maps an offset to the page containing it', () => {
        expect(pageForOffset(offsets, 0)).toBe(0);
        expect(pageForOffset(offsets, 399)).toBe(0);
        expect(pageForOffset(offsets, 400)).toBe(1);
        expect(pageForOffset(offsets, 779)).toBe(1);
        expect(pageForOffset(offsets, 780)).toBe(2);
        expect(pageForOffset(offsets, 5000)).toBe(3);
    });

    it('clamps offsets above the last break to the last page', () => {
        expect(pageForOffset(offsets, 1160)).toBe(3);
    });

    it('handles empty input', () => {
        expect(pageForOffset([], 500)).toBe(0);
    });

    it('is consistent with computePageOffsets', () => {
        const computed = computePageOffsets(2000, 431, gridBreakFinder(28.8));
        computed.forEach((offset, page) => {
            expect(pageForOffset(computed, offset)).toBe(page);
        });
    });
});

describe('pageRange', () => {
    const offsets = [0, 400, 780];

    it('clips a page to its own content height, not the viewport height', () => {
        // Page 0 ends at 400 even though the viewport is 431 tall — those extra
        // 31px are the partial line we are trying not to show.
        expect(pageRange(offsets, 0, 431, 1100)).toEqual({ top: 0, height: 400 });
        expect(pageRange(offsets, 1, 431, 1100)).toEqual({ top: 400, height: 380 });
    });

    it('ends the last page at the content bottom', () => {
        expect(pageRange(offsets, 2, 431, 1100)).toEqual({ top: 780, height: 320 });
    });

    it('caps the last page at the viewport height', () => {
        expect(pageRange(offsets, 2, 431, 5000)).toEqual({ top: 780, height: 431 });
    });

    it('clamps out-of-range page numbers', () => {
        expect(pageRange(offsets, 99, 431, 1100).top).toBe(780);
        expect(pageRange(offsets, -3, 431, 1100).top).toBe(0);
    });

    it('falls back to the viewport height when there are no offsets', () => {
        expect(pageRange([], 0, 431, 1100)).toEqual({ top: 0, height: 431 });
    });
});

describe('mergeRectsToLineBottoms', () => {
    it('returns one bottom per line', () => {
        const rects = [
            { top: 0, bottom: 20 },
            { top: 20, bottom: 40 },
            { top: 40, bottom: 60 }
        ];
        expect(mergeRectsToLineBottoms(rects)).toEqual([20, 40, 60]);
    });

    it('merges fragments of the same line into their lowest edge', () => {
        // One line split by inline markup, where the <sup> fragment is shorter.
        const rects = [
            { top: 0, bottom: 20 },
            { top: 2, bottom: 14 },
            { top: 0, bottom: 22 },
            { top: 24, bottom: 44 }
        ];
        expect(mergeRectsToLineBottoms(rects)).toEqual([22, 44]);
    });

    it('ignores zero-height rects', () => {
        const rects = [
            { top: 0, bottom: 0 },
            { top: 0, bottom: 20 }
        ];
        expect(mergeRectsToLineBottoms(rects)).toEqual([20]);
    });

    it('handles unsorted input', () => {
        const rects = [
            { top: 40, bottom: 60 },
            { top: 0, bottom: 20 },
            { top: 20, bottom: 40 }
        ];
        expect(mergeRectsToLineBottoms(rects)).toEqual([20, 40, 60]);
    });

    it('returns nothing for empty input', () => {
        expect(mergeRectsToLineBottoms([])).toEqual([]);
    });
});

describe('largestAtOrBefore', () => {
    it('finds the largest value not exceeding the target', () => {
        expect(largestAtOrBefore([10, 20, 30], 25)).toBe(20);
        expect(largestAtOrBefore([10, 20, 30], 30)).toBe(30);
        expect(largestAtOrBefore([10, 20, 30], 100)).toBe(30);
    });

    it('returns null when every value is larger', () => {
        expect(largestAtOrBefore([10, 20, 30], 5)).toBeNull();
        expect(largestAtOrBefore([], 5)).toBeNull();
    });
});
