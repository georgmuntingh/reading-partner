import { describe, it, expect } from 'vitest';
import {
    gatherContextWindows,
    mergeOverlappingSpans,
    pickPrimary,
    intersectContexts,
    unionContexts
} from '../js/services/srs-text-retrieval.js';

// ---------- Fixtures ----------

const CHAPTER_0 = [
    's0-zero', 's0-one', 's0-two', 's0-three', 's0-four',
    's0-five', 's0-six', 's0-seven', 's0-eight', 's0-nine'
];
const CHAPTER_1 = [
    's1-zero', 's1-one', 's1-two', 's1-three', 's1-four',
    's1-five', 's1-six', 's1-seven'
];
const CHAPTER_2 = ['only-one'];

const fakeReadingState = (chapters) => ({
    loadChapter: async (idx) => chapters[idx] ?? null
});

const rs = fakeReadingState({ 0: CHAPTER_0, 1: CHAPTER_1, 2: CHAPTER_2 });

// ---------- mergeOverlappingSpans ----------

describe('mergeOverlappingSpans', () => {
    it('returns [] for empty input', () => {
        expect(mergeOverlappingSpans([])).toEqual([]);
        expect(mergeOverlappingSpans(null)).toEqual([]);
    });

    it('leaves disjoint spans untouched (sorted)', () => {
        const out = mergeOverlappingSpans([{ start: 10, end: 12 }, { start: 0, end: 2 }]);
        expect(out).toEqual([{ start: 0, end: 2 }, { start: 10, end: 12 }]);
    });

    it('merges overlapping spans', () => {
        const out = mergeOverlappingSpans([
            { start: 0, end: 3 },
            { start: 2, end: 5 },
            { start: 4, end: 6 }
        ]);
        expect(out).toEqual([{ start: 0, end: 6 }]);
    });

    it('merges adjacent spans (end+1 === next.start)', () => {
        const out = mergeOverlappingSpans([
            { start: 0, end: 2 },
            { start: 3, end: 5 }
        ]);
        expect(out).toEqual([{ start: 0, end: 5 }]);
    });

    it('filters out invalid spans (end < start, NaN)', () => {
        const out = mergeOverlappingSpans([
            { start: 0, end: 2 },
            { start: 5, end: 3 },
            { start: NaN, end: 10 }
        ]);
        expect(out).toEqual([{ start: 0, end: 2 }]);
    });

    it('handles single-point spans (start === end)', () => {
        const out = mergeOverlappingSpans([
            { start: 3, end: 3 },
            { start: 4, end: 4 }
        ]);
        expect(out).toEqual([{ start: 3, end: 4 }]);
    });
});

// ---------- pickPrimary ----------

describe('pickPrimary', () => {
    it('returns null for no hits', () => {
        expect(pickPrimary([])).toBeNull();
        expect(pickPrimary(null)).toBeNull();
    });

    it('prefers higher weight (edges over nodes)', () => {
        const out = pickPrimary([
            { chapterIndex: 0, sentenceIndex: 5, weight: 1 },
            { chapterIndex: 1, sentenceIndex: 0, weight: 2 }
        ]);
        expect(out).toEqual({ chapterIndex: 1, sentenceIndex: 0 });
    });

    it('breaks ties by earliest chapter, then earliest sentence', () => {
        const out = pickPrimary([
            { chapterIndex: 2, sentenceIndex: 0, weight: 1 },
            { chapterIndex: 0, sentenceIndex: 7, weight: 1 },
            { chapterIndex: 0, sentenceIndex: 3, weight: 1 }
        ]);
        expect(out).toEqual({ chapterIndex: 0, sentenceIndex: 3 });
    });
});

// ---------- intersectContexts / unionContexts ----------

describe('intersectContexts', () => {
    it('returns sentences mentioned in both records', () => {
        const a = { contexts: [{ chapterIndex: 0, sentenceIndices: [3, 5, 7] }] };
        const b = { contexts: [{ chapterIndex: 0, sentenceIndices: [5, 7, 9] }] };
        const out = intersectContexts(a, b);
        expect(out.sort((x, y) => x.sentenceIndex - y.sentenceIndex)).toEqual([
            { chapterIndex: 0, sentenceIndex: 5 },
            { chapterIndex: 0, sentenceIndex: 7 }
        ]);
    });

    it('respects chapter boundaries (same sentenceIndex in different chapters = no match)', () => {
        const a = { contexts: [{ chapterIndex: 0, sentenceIndices: [3] }] };
        const b = { contexts: [{ chapterIndex: 1, sentenceIndices: [3] }] };
        expect(intersectContexts(a, b)).toEqual([]);
    });

    it('returns [] when either record has no contexts', () => {
        expect(intersectContexts({}, { contexts: [{ chapterIndex: 0, sentenceIndices: [1] }] })).toEqual([]);
    });
});

describe('unionContexts', () => {
    it('dedupes by (chapterIndex, sentenceIndex)', () => {
        const a = { contexts: [{ chapterIndex: 0, sentenceIndices: [1, 3] }] };
        const b = { contexts: [{ chapterIndex: 0, sentenceIndices: [3, 5] }] };
        const out = unionContexts(a, b);
        expect(out.sort((x, y) => x.sentenceIndex - y.sentenceIndex)).toEqual([
            { chapterIndex: 0, sentenceIndex: 1 },
            { chapterIndex: 0, sentenceIndex: 3 },
            { chapterIndex: 0, sentenceIndex: 5 }
        ]);
    });
});

// ---------- gatherContextWindows ----------

describe('gatherContextWindows', () => {
    it('returns an empty bundle for no nodes/edges', async () => {
        const out = await gatherContextWindows({ nodes: [], readingState: rs, paddingSentences: 2 });
        expect(out).toEqual({ chapters: [], primary: null, totalSentences: 0 });
    });

    it('returns an empty bundle when contexts are empty', async () => {
        const out = await gatherContextWindows({
            nodes: [{ id: 'n1', contexts: [] }],
            readingState: rs,
            paddingSentences: 2
        });
        expect(out.chapters).toEqual([]);
        expect(out.primary).toBeNull();
    });

    it('expands a single hit by ±N and slices the right sentences', async () => {
        const node = {
            id: 'n1',
            contexts: [{ chapterIndex: 0, sentenceIndices: [5] }]
        };
        const out = await gatherContextWindows({
            nodes: [node], readingState: rs, paddingSentences: 2
        });
        expect(out.chapters).toHaveLength(1);
        const w = out.chapters[0].windows[0];
        expect(w.start).toBe(3);
        expect(w.end).toBe(7);
        expect(w.sentences).toEqual(['s0-three', 's0-four', 's0-five', 's0-six', 's0-seven']);
        expect(out.totalSentences).toBe(5);
    });

    it('clamps spans to chapter bounds', async () => {
        const node = {
            id: 'n1',
            contexts: [{ chapterIndex: 0, sentenceIndices: [1, 9] }]
        };
        const out = await gatherContextWindows({
            nodes: [node], readingState: rs, paddingSentences: 3
        });
        // hit 1 → [0, 4], hit 9 → [6, 9] (clamped to maxIdx=9)
        const windows = out.chapters[0].windows;
        expect(windows).toEqual([
            { start: 0, end: 4, sentences: CHAPTER_0.slice(0, 5) },
            { start: 6, end: 9, sentences: CHAPTER_0.slice(6, 10) }
        ]);
    });

    it('merges overlapping windows from multiple hits in the same chapter', async () => {
        // hits at sentence 3 and 5 with padding 2 → [1,5] ∪ [3,7] = [1,7]
        const node = {
            id: 'n1',
            contexts: [{ chapterIndex: 0, sentenceIndices: [3, 5] }]
        };
        const out = await gatherContextWindows({
            nodes: [node], readingState: rs, paddingSentences: 2
        });
        expect(out.chapters[0].windows).toHaveLength(1);
        expect(out.chapters[0].windows[0]).toEqual({
            start: 1, end: 7, sentences: CHAPTER_0.slice(1, 8)
        });
    });

    it('groups hits across chapters and orders chapters ascending', async () => {
        const node = {
            id: 'n1',
            contexts: [
                { chapterIndex: 1, sentenceIndices: [4] },
                { chapterIndex: 0, sentenceIndices: [2] }
            ]
        };
        const out = await gatherContextWindows({
            nodes: [node], readingState: rs, paddingSentences: 1
        });
        expect(out.chapters.map((c) => c.chapterIndex)).toEqual([0, 1]);
        expect(out.chapters[0].windows[0]).toEqual({
            start: 1, end: 3, sentences: ['s0-one', 's0-two', 's0-three']
        });
        expect(out.chapters[1].windows[0]).toEqual({
            start: 3, end: 5, sentences: ['s1-three', 's1-four', 's1-five']
        });
    });

    it('whole-chapter mode (paddingSentences = null) yields one window per chapter', async () => {
        const node = {
            id: 'n1',
            contexts: [{ chapterIndex: 0, sentenceIndices: [3, 5] }]
        };
        const out = await gatherContextWindows({
            nodes: [node], readingState: rs, paddingSentences: null
        });
        expect(out.chapters[0].windows).toHaveLength(1);
        expect(out.chapters[0].windows[0]).toEqual({
            start: 0, end: 9, sentences: CHAPTER_0
        });
    });

    it('whole-chapter mode also accepts Infinity', async () => {
        const node = {
            id: 'n1',
            contexts: [{ chapterIndex: 2, sentenceIndices: [0] }]
        };
        const out = await gatherContextWindows({
            nodes: [node], readingState: rs, paddingSentences: Infinity
        });
        expect(out.chapters[0].windows[0]).toEqual({
            start: 0, end: 0, sentences: ['only-one']
        });
    });

    it('flatText tags each window with [chX sY-Z] and joins sentences with space', async () => {
        const node = {
            id: 'n1',
            contexts: [{ chapterIndex: 0, sentenceIndices: [5] }]
        };
        const out = await gatherContextWindows({
            nodes: [node], readingState: rs, paddingSentences: 1
        });
        expect(out.chapters[0].flatText).toBe(
            '[ch0 s4-6] s0-four s0-five s0-six'
        );
    });

    it('flatText joins multiple windows with a blank line', async () => {
        const node = {
            id: 'n1',
            contexts: [{ chapterIndex: 0, sentenceIndices: [1, 9] }]
        };
        const out = await gatherContextWindows({
            nodes: [node], readingState: rs, paddingSentences: 1
        });
        expect(out.chapters[0].flatText).toBe(
            '[ch0 s0-2] s0-zero s0-one s0-two\n\n[ch0 s8-9] s0-eight s0-nine'
        );
    });

    it('edges contribute hits with weight 2 (primary biases toward edges)', async () => {
        const node = {
            id: 'n1',
            contexts: [{ chapterIndex: 0, sentenceIndices: [2] }]
        };
        const edge = {
            id: 'e1',
            contexts: [{ chapterIndex: 1, sentenceIndices: [4] }]
        };
        const out = await gatherContextWindows({
            nodes: [node], edges: [edge], readingState: rs, paddingSentences: 1
        });
        // Both chapters should appear, but primary should point to the edge hit.
        expect(out.chapters.map((c) => c.chapterIndex)).toEqual([0, 1]);
        expect(out.primary).toEqual({ chapterIndex: 1, sentenceIndex: 4 });
    });

    it('primary picks earliest hit when all weights are equal', async () => {
        const node = {
            id: 'n1',
            contexts: [
                { chapterIndex: 1, sentenceIndices: [0] },
                { chapterIndex: 0, sentenceIndices: [5] }
            ]
        };
        const out = await gatherContextWindows({
            nodes: [node], readingState: rs, paddingSentences: 0
        });
        expect(out.primary).toEqual({ chapterIndex: 0, sentenceIndex: 5 });
    });

    it('skips chapters that loadChapter returns null/empty for', async () => {
        const partialRs = fakeReadingState({ 0: CHAPTER_0, 1: [] });
        const node = {
            id: 'n1',
            contexts: [
                { chapterIndex: 0, sentenceIndices: [3] },
                { chapterIndex: 1, sentenceIndices: [0] }
            ]
        };
        const out = await gatherContextWindows({
            nodes: [node], readingState: partialRs, paddingSentences: 1
        });
        expect(out.chapters).toHaveLength(1);
        expect(out.chapters[0].chapterIndex).toBe(0);
    });

    it('paddingSentences = 0 yields single-sentence windows', async () => {
        const node = {
            id: 'n1',
            contexts: [{ chapterIndex: 0, sentenceIndices: [3, 6] }]
        };
        const out = await gatherContextWindows({
            nodes: [node], readingState: rs, paddingSentences: 0
        });
        expect(out.chapters[0].windows).toEqual([
            { start: 3, end: 3, sentences: ['s0-three'] },
            { start: 6, end: 6, sentences: ['s0-six'] }
        ]);
    });

    it('ignores malformed context entries (missing chapterIndex / non-numeric indices)', async () => {
        const node = {
            id: 'n1',
            contexts: [
                { chapterIndex: 0, sentenceIndices: [5, 'bad', null, -1] },
                { sentenceIndices: [1] }, // missing chapterIndex
                { chapterIndex: 'x', sentenceIndices: [1] }
            ]
        };
        const out = await gatherContextWindows({
            nodes: [node], readingState: rs, paddingSentences: 0
        });
        expect(out.chapters).toHaveLength(1);
        expect(out.chapters[0].windows).toEqual([
            { start: 5, end: 5, sentences: ['s0-five'] }
        ]);
    });
});
