/**
 * Page breaking utilities
 *
 * The reader paginates by scrolling a single tall, overflow-hidden element to a
 * series of offsets. If those offsets are plain multiples of the viewport height
 * they land in the middle of a line box, so the last line of a page is sliced in
 * half — its top on one page, its bottom on the next.
 *
 * These helpers turn a viewport height plus a set of *safe* break positions
 * (line-box bottoms, tops of atomic blocks) into an array of page offsets that
 * always land between lines. They are deliberately free of DOM access so the
 * packing logic can be unit tested without a layout engine.
 */

/** Sub-pixel slack when comparing layout offsets. */
export const BREAK_EPSILON = 1;

/**
 * Pack content into pages, snapping each break down to the nearest safe offset.
 *
 * @param {number} contentBottom - Offset of the bottom of the last content, in
 *     the scroll coordinate space of the paginated element.
 * @param {number} pageHeight - Height of the visible page viewport.
 * @param {(target: number, pageTop: number) => number} findBreakAtOrBefore -
 *     Returns the largest safe break offset that is <= `target` and > `pageTop`,
 *     or a value <= `pageTop` when no such break exists.
 * @param {number} [maxPages=10000] - Safety valve against pathological input.
 * @returns {number[]} Page offsets, always starting with 0.
 */
export function computePageOffsets(contentBottom, pageHeight, findBreakAtOrBefore, maxPages = 10000) {
    const offsets = [0];

    if (!(pageHeight > 0) || !(contentBottom > 0)) return offsets;

    let top = 0;
    while (top + pageHeight < contentBottom - BREAK_EPSILON && offsets.length < maxPages) {
        const target = top + pageHeight;
        let next = findBreakAtOrBefore(target, top);

        // No safe break inside this page — e.g. a single image or table taller
        // than the viewport. Fall back to a hard cut so we still make progress.
        if (!(next > top + BREAK_EPSILON) || next > target) {
            next = target;
        }

        offsets.push(next);
        top = next;
    }

    return offsets;
}

/**
 * Find the page whose range contains a given content offset.
 * @param {number[]} pageOffsets - Ascending page offsets (from computePageOffsets)
 * @param {number} offset
 * @returns {number} 0-indexed page number
 */
export function pageForOffset(pageOffsets, offset) {
    if (!pageOffsets || pageOffsets.length === 0) return 0;

    let lo = 0;
    let hi = pageOffsets.length - 1;
    let result = 0;

    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (pageOffsets[mid] <= offset) {
            result = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }

    return result;
}

/**
 * The visible extent of a page: where it starts and how tall its content is.
 * The height is what the page viewport should be clipped to, so that the first
 * line of the *next* page is not partially visible at the bottom of this one.
 *
 * @param {number[]} pageOffsets
 * @param {number} page
 * @param {number} pageHeight - Maximum (viewport) height
 * @param {number} contentBottom
 * @returns {{ top: number, height: number }}
 */
export function pageRange(pageOffsets, page, pageHeight, contentBottom) {
    if (!pageOffsets || pageOffsets.length === 0) {
        return { top: 0, height: pageHeight };
    }

    const index = Math.max(0, Math.min(page, pageOffsets.length - 1));
    const top = pageOffsets[index];
    const nextBreak = index + 1 < pageOffsets.length ? pageOffsets[index + 1] : contentBottom;
    const height = Math.min(pageHeight, Math.max(0, nextBreak - top));

    // Guard against a degenerate zero-height page.
    return { top, height: height > 0 ? height : pageHeight };
}

/**
 * Merge raw client rects into per-line vertical spans and return their bottoms.
 *
 * `Range.getClientRects()` returns one rect per line *fragment*, so a line split
 * by inline markup (or containing a superscript) yields several overlapping
 * rects. Breaking at the smaller of two overlapping bottoms would clip the
 * taller glyphs, so overlapping rects are merged and only the lowest edge of
 * each visual line is offered as a break point.
 *
 * @param {{top: number, bottom: number}[]} rects - Rects in any order
 * @returns {number[]} Ascending line bottom offsets
 */
export function mergeRectsToLineBottoms(rects) {
    const usable = rects
        .filter(r => r.bottom > r.top)
        .sort((a, b) => a.top - b.top || a.bottom - b.bottom);

    const bottoms = [];
    let currentTop = null;
    let currentBottom = null;

    for (const rect of usable) {
        if (currentBottom === null) {
            currentTop = rect.top;
            currentBottom = rect.bottom;
            continue;
        }

        // Overlapping vertically => same visual line.
        if (rect.top < currentBottom - BREAK_EPSILON) {
            currentBottom = Math.max(currentBottom, rect.bottom);
            currentTop = Math.min(currentTop, rect.top);
        } else {
            bottoms.push(currentBottom);
            currentTop = rect.top;
            currentBottom = rect.bottom;
        }
    }

    if (currentBottom !== null) bottoms.push(currentBottom);

    return bottoms;
}

/**
 * Largest value in an ascending array that is <= target, or null.
 * @param {number[]} values - Ascending
 * @param {number} target
 * @returns {number|null}
 */
export function largestAtOrBefore(values, target) {
    let lo = 0;
    let hi = values.length - 1;
    let result = null;

    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (values[mid] <= target) {
            result = values[mid];
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }

    return result;
}
