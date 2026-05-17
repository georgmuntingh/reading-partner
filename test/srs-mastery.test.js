import { describe, it, expect } from 'vitest';
import {
    Band,
    bandFor,
    cardMatchesBand,
    cardsByNodeId,
    cardsByEdgeId,
    bandColor,
    dueLabel
} from '../js/services/srs-mastery.js';

const NOW = 1_700_000_000_000;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const makeCard = (overrides = {}) => ({
    id: 'fc1',
    bookId: 'b1',
    cognitiveLevel: 1,
    targetNodeIds: [],
    targetEdgeIds: [],
    srsBox: 0,
    nextReviewAt: NOW,
    ...overrides
});

// ---------- bandFor ----------

describe('bandFor', () => {
    it('classifies srsBox 0 as failing', () => {
        expect(bandFor(makeCard({ srsBox: 0 }))).toBe(Band.FAILING);
    });

    it('classifies srsBox 1 and 2 as learning', () => {
        expect(bandFor(makeCard({ srsBox: 1 }))).toBe(Band.LEARNING);
        expect(bandFor(makeCard({ srsBox: 2 }))).toBe(Band.LEARNING);
    });

    it('classifies srsBox 3 and higher as mastered', () => {
        expect(bandFor(makeCard({ srsBox: 3 }))).toBe(Band.MASTERED);
        expect(bandFor(makeCard({ srsBox: 5 }))).toBe(Band.MASTERED);
        expect(bandFor(makeCard({ srsBox: 99 }))).toBe(Band.MASTERED);
    });

    it('treats a missing or non-numeric srsBox as failing (conservative)', () => {
        expect(bandFor(makeCard({ srsBox: undefined }))).toBe(Band.FAILING);
        expect(bandFor({})).toBe(Band.FAILING);
        expect(bandFor(makeCard({ srsBox: NaN }))).toBe(Band.FAILING);
    });

    it('null/undefined card is treated as failing', () => {
        expect(bandFor(null)).toBe(Band.FAILING);
        expect(bandFor(undefined)).toBe(Band.FAILING);
    });
});

// ---------- cardMatchesBand ----------

describe('cardMatchesBand', () => {
    it("band='any' matches any card", () => {
        expect(cardMatchesBand(makeCard({ srsBox: 0 }), Band.ANY)).toBe(true);
        expect(cardMatchesBand(makeCard({ srsBox: 3 }), Band.ANY)).toBe(true);
    });

    it('exact-band matches', () => {
        const card = makeCard({ srsBox: 2 });
        expect(cardMatchesBand(card, Band.LEARNING)).toBe(true);
        expect(cardMatchesBand(card, Band.FAILING)).toBe(false);
        expect(cardMatchesBand(card, Band.MASTERED)).toBe(false);
    });

    it('null card is never a match (even for any)', () => {
        expect(cardMatchesBand(null, Band.ANY)).toBe(false);
        expect(cardMatchesBand(null, Band.FAILING)).toBe(false);
    });
});

// ---------- cardsByNodeId ----------

describe('cardsByNodeId', () => {
    it('groups cards by every node id in targetNodeIds', () => {
        const a = makeCard({ id: 'a', targetNodeIds: ['n1'] });
        const b = makeCard({ id: 'b', targetNodeIds: ['n1', 'n2'] });
        const c = makeCard({ id: 'c', targetNodeIds: ['n3'] });
        const map = cardsByNodeId([a, b, c]);
        expect(map.get('n1').map((x) => x.id).sort()).toEqual(['a', 'b']);
        expect(map.get('n2').map((x) => x.id)).toEqual(['b']);
        expect(map.get('n3').map((x) => x.id)).toEqual(['c']);
        expect(map.has('n4')).toBe(false);
    });

    it('returns an empty Map for empty or non-array input', () => {
        expect(cardsByNodeId([]).size).toBe(0);
        expect(cardsByNodeId(null).size).toBe(0);
        expect(cardsByNodeId(undefined).size).toBe(0);
    });

    it('skips cards with missing targetNodeIds', () => {
        const a = makeCard({ id: 'a', targetNodeIds: ['n1'] });
        const b = { id: 'b', srsBox: 1 }; // no targetNodeIds
        const map = cardsByNodeId([a, b]);
        expect(map.get('n1').map((x) => x.id)).toEqual(['a']);
        expect(map.size).toBe(1);
    });

    it('skips non-string node ids', () => {
        const a = makeCard({ id: 'a', targetNodeIds: ['n1', null, 42, 'n2'] });
        const map = cardsByNodeId([a]);
        expect(Array.from(map.keys()).sort()).toEqual(['n1', 'n2']);
    });
});

// ---------- cardsByEdgeId ----------

describe('cardsByEdgeId', () => {
    it('groups cards by every edge id in targetEdgeIds (single-edge case)', () => {
        const a = makeCard({ id: 'a', targetEdgeIds: ['e1'] });
        const b = makeCard({ id: 'b', targetEdgeIds: ['e2'] });
        const map = cardsByEdgeId([a, b]);
        expect(map.get('e1').map((x) => x.id)).toEqual(['a']);
        expect(map.get('e2').map((x) => x.id)).toEqual(['b']);
    });

    it('handles a single card listed in multiple edges (multi-edge L2)', () => {
        const card = makeCard({ id: 'multi', targetEdgeIds: ['e1', 'e2', 'e3'] });
        const map = cardsByEdgeId([card]);
        expect(map.get('e1').map((x) => x.id)).toEqual(['multi']);
        expect(map.get('e2').map((x) => x.id)).toEqual(['multi']);
        expect(map.get('e3').map((x) => x.id)).toEqual(['multi']);
    });

    it('handles a single edge covered by multiple cards', () => {
        const a = makeCard({ id: 'a', targetEdgeIds: ['e1'] });
        const b = makeCard({ id: 'b', targetEdgeIds: ['e1'] });
        const map = cardsByEdgeId([a, b]);
        expect(map.get('e1').map((x) => x.id).sort()).toEqual(['a', 'b']);
    });

    it('returns empty Map for cards with empty targetEdgeIds (L1 cards)', () => {
        const l1 = makeCard({ id: 'l1', targetEdgeIds: [] });
        const map = cardsByEdgeId([l1]);
        expect(map.size).toBe(0);
    });

    it('returns empty Map for non-array input', () => {
        expect(cardsByEdgeId(null).size).toBe(0);
        expect(cardsByEdgeId(undefined).size).toBe(0);
    });
});

// ---------- bandColor ----------

describe('bandColor', () => {
    it('returns the CSS custom-property for each band', () => {
        expect(bandColor(Band.ANY)).toBe('var(--srs-band-any)');
        expect(bandColor(Band.FAILING)).toBe('var(--srs-band-failing)');
        expect(bandColor(Band.LEARNING)).toBe('var(--srs-band-learning)');
        expect(bandColor(Band.MASTERED)).toBe('var(--srs-band-mastered)');
    });

    it('falls back to the any color for unknown bands', () => {
        expect(bandColor('bogus')).toBe('var(--srs-band-any)');
        expect(bandColor(undefined)).toBe('var(--srs-band-any)');
    });
});

// ---------- dueLabel ----------

describe('dueLabel', () => {
    it("returns 'due now' for past timestamps", () => {
        expect(dueLabel(makeCard({ nextReviewAt: NOW - 1000 }), NOW)).toBe('due now');
        expect(dueLabel(makeCard({ nextReviewAt: NOW }), NOW)).toBe('due now');
    });

    it("returns 'due now' for missing or non-numeric nextReviewAt", () => {
        expect(dueLabel({}, NOW)).toBe('due now');
        expect(dueLabel(makeCard({ nextReviewAt: 'x' }), NOW)).toBe('due now');
    });

    it('formats seconds when < 1 minute', () => {
        expect(dueLabel(makeCard({ nextReviewAt: NOW + 30 * SECOND }), NOW)).toBe('in 30s');
    });

    it('formats minutes when < 1 hour', () => {
        expect(dueLabel(makeCard({ nextReviewAt: NOW + 5 * MINUTE }), NOW)).toBe('in 5m');
        expect(dueLabel(makeCard({ nextReviewAt: NOW + 59 * MINUTE }), NOW)).toBe('in 59m');
    });

    it('formats hours when < 1 day', () => {
        expect(dueLabel(makeCard({ nextReviewAt: NOW + 2 * HOUR }), NOW)).toBe('in 2h');
        expect(dueLabel(makeCard({ nextReviewAt: NOW + 23 * HOUR }), NOW)).toBe('in 23h');
    });

    it('formats days when >= 1 day', () => {
        expect(dueLabel(makeCard({ nextReviewAt: NOW + 1 * DAY }), NOW)).toBe('in 1d');
        expect(dueLabel(makeCard({ nextReviewAt: NOW + 15 * DAY }), NOW)).toBe('in 15d');
    });

    it('null card returns due now', () => {
        expect(dueLabel(null, NOW)).toBe('due now');
    });
});
