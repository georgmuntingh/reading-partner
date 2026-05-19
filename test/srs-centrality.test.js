import { describe, it, expect } from 'vitest';
import {
    DEFAULT_WEIGHTS,
    computeNodeDegrees,
    contextFrequency,
    centrality,
    rankNodesByCentrality,
    nodesEncounteredUpTo
} from '../js/services/srs-centrality.js';

const node = (id, overrides = {}) => ({
    id,
    bookId: 'b1',
    canonicalName: id,
    contexts: [],
    firstSeenChapter: 0,
    relevanceScore: null,
    ...overrides
});

const edge = (sourceId, targetId, id = `${sourceId}->${targetId}`) => ({
    id, bookId: 'b1', sourceId, targetId, relation: 'rel'
});

describe('computeNodeDegrees', () => {
    it('counts incoming and outgoing edges per node', () => {
        const edges = [edge('A', 'B'), edge('A', 'C'), edge('D', 'A')];
        const d = computeNodeDegrees(edges);
        expect(d.get('A')).toBe(3);
        expect(d.get('B')).toBe(1);
        expect(d.get('C')).toBe(1);
        expect(d.get('D')).toBe(1);
    });

    it('counts a self-loop only once', () => {
        const d = computeNodeDegrees([edge('A', 'A')]);
        expect(d.get('A')).toBe(1);
    });

    it('returns an empty map for no edges', () => {
        expect(computeNodeDegrees([]).size).toBe(0);
        expect(computeNodeDegrees(null).size).toBe(0);
        expect(computeNodeDegrees(undefined).size).toBe(0);
    });

    it('ignores malformed edges without source/target ids', () => {
        const edges = [edge('A', 'B'), { id: 'bad' }, null];
        const d = computeNodeDegrees(edges);
        expect(d.size).toBe(2);
        expect(d.get('A')).toBe(1);
        expect(d.get('B')).toBe(1);
    });
});

describe('contextFrequency', () => {
    it('sums sentenceIndices.length across all contexts', () => {
        const n = node('A', {
            contexts: [
                { chapterIndex: 0, sentenceIndices: [1, 2, 3] },
                { chapterIndex: 1, sentenceIndices: [5] }
            ]
        });
        expect(contextFrequency(n)).toBe(4);
    });

    it('returns 0 for a node with no contexts', () => {
        expect(contextFrequency(node('A'))).toBe(0);
    });

    it('skips contexts missing sentenceIndices', () => {
        const n = node('A', {
            contexts: [
                { chapterIndex: 0 },
                { chapterIndex: 1, sentenceIndices: [7] }
            ]
        });
        expect(contextFrequency(n)).toBe(1);
    });

    it('handles null/undefined safely', () => {
        expect(contextFrequency(null)).toBe(0);
        expect(contextFrequency(undefined)).toBe(0);
    });
});

describe('centrality (single-node, normalized against a pool)', () => {
    const poolStats = {
        degree: { min: 0, max: 10 },
        contextFreq: { min: 0, max: 8 }
    };
    const degreeMap = new Map([['A', 10], ['B', 0], ['C', 5]]);

    it('returns the weighted sum of normalized components', () => {
        const n = node('A', {
            contexts: [{ chapterIndex: 0, sentenceIndices: [1, 2, 3, 4, 5, 6, 7, 8] }],
            relevanceScore: 1.0
        });
        // nDegree=1, nContextFreq=1, relevance=1 → 0.4 + 0.3 + 0.3 = 1.0
        const s = centrality(n, { degreeMap, poolStats });
        expect(s).toBeCloseTo(1.0, 5);
    });

    it('falls back to relevance=0.5 when relevanceScore is missing', () => {
        const n = node('B', { contexts: [], relevanceScore: null });
        // nDegree=0, nContextFreq=0, relevance=0.5 → 0.15
        const s = centrality(n, { degreeMap, poolStats });
        expect(s).toBeCloseTo(0.15, 5);
    });

    it('respects custom weights', () => {
        const n = node('C', {
            contexts: [{ chapterIndex: 0, sentenceIndices: [1, 2, 3, 4] }],
            relevanceScore: 0.0
        });
        // nDegree=0.5, nContextFreq=0.5, relevance=0
        const s = centrality(n, {
            degreeMap, poolStats,
            weights: { degree: 1, context: 0, relevance: 0 }
        });
        expect(s).toBeCloseTo(0.5, 5);
    });

    it('returns 0 for a degenerate pool (all degrees equal)', () => {
        const flatStats = {
            degree: { min: 5, max: 5 },
            contextFreq: { min: 0, max: 0 }
        };
        const n = node('A', { contexts: [], relevanceScore: 0 });
        // all normalized components collapse to 0, relevance=0
        expect(centrality(n, { degreeMap, poolStats: flatStats })).toBe(0);
    });
});

describe('rankNodesByCentrality', () => {
    it('ranks higher-degree, higher-frequency, higher-relevance nodes first', () => {
        const A = node('A', {
            contexts: [{ chapterIndex: 0, sentenceIndices: [1, 2, 3, 4] }],
            relevanceScore: 0.9
        });
        const B = node('B', {
            contexts: [{ chapterIndex: 0, sentenceIndices: [1] }],
            relevanceScore: 0.2
        });
        const C = node('C', {
            contexts: [],
            relevanceScore: 0.0
        });
        // Degrees: A=3, B=1, C=0
        const edges = [edge('A', 'B'), edge('A', 'C'), edge('A', 'D')];
        const ranked = rankNodesByCentrality([A, B, C], edges);
        expect(ranked.map((r) => r.node.id)).toEqual(['A', 'B', 'C']);
        expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
        expect(ranked[1].score).toBeGreaterThan(ranked[2].score);
    });

    it('returns an empty array for empty input', () => {
        expect(rankNodesByCentrality([], [])).toEqual([]);
        expect(rankNodesByCentrality(null, null)).toEqual([]);
    });

    it('accepts a pre-computed degreeMap to avoid recomputation', () => {
        const A = node('A', { contexts: [], relevanceScore: 0.5 });
        const B = node('B', { contexts: [], relevanceScore: 0.5 });
        const degreeMap = new Map([['A', 100], ['B', 0]]);
        const ranked = rankNodesByCentrality([A, B], [], { degreeMap });
        expect(ranked[0].node.id).toBe('A');
    });

    it('uses custom weights when provided', () => {
        // With high relevance weight, the high-relevance node wins despite
        // having zero degree.
        const A = node('A', { contexts: [], relevanceScore: 0.0 });
        const B = node('B', { contexts: [], relevanceScore: 1.0 });
        const edges = [edge('A', 'A')]; // gives A degree 1, B degree 0
        const ranked = rankNodesByCentrality([A, B], edges, {
            weights: { degree: 0, context: 0, relevance: 1 }
        });
        expect(ranked[0].node.id).toBe('B');
    });

    it('DEFAULT_WEIGHTS sum to 1.0', () => {
        const sum = DEFAULT_WEIGHTS.degree + DEFAULT_WEIGHTS.context + DEFAULT_WEIGHTS.relevance;
        expect(sum).toBeCloseTo(1.0, 5);
    });
});

describe('nodesEncounteredUpTo', () => {
    it('returns nodes whose firstSeenChapter <= chapterIndex', () => {
        const ns = [
            node('A', { firstSeenChapter: 0 }),
            node('B', { firstSeenChapter: 2 }),
            node('C', { firstSeenChapter: 5 })
        ];
        const got = nodesEncounteredUpTo(ns, 2);
        expect(got.map((n) => n.id).sort()).toEqual(['A', 'B']);
    });

    it('excludes nodes without firstSeenChapter (conservative)', () => {
        const ns = [
            node('A', { firstSeenChapter: 0 }),
            { ...node('B'), firstSeenChapter: undefined }
        ];
        const got = nodesEncounteredUpTo(ns, 10);
        expect(got.map((n) => n.id)).toEqual(['A']);
    });

    it('returns empty for invalid chapterIndex', () => {
        const ns = [node('A', { firstSeenChapter: 0 })];
        expect(nodesEncounteredUpTo(ns, NaN)).toEqual([]);
        expect(nodesEncounteredUpTo(ns, undefined)).toEqual([]);
    });

    it('returns empty for non-array input', () => {
        expect(nodesEncounteredUpTo(null, 0)).toEqual([]);
    });
});
