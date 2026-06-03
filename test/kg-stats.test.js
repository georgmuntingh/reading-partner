import { describe, it, expect } from 'vitest';
import {
    IN_DEGREE_BINS,
    COMPONENT_SIZE_BINS,
    NODE_TYPES,
    BLOOM_LEVELS,
    computeDirectedDegrees,
    binByInDegree,
    degreeHistogram,
    perChapterStacked,
    connectedComponents,
    componentSizeHistogram,
    topByDegree,
    typeDistribution,
    bloomDistribution,
    summary
} from '../js/services/kg-stats.js';

const node = (id, overrides = {}) => ({
    id,
    canonicalName: id,
    firstSeenChapter: 0,
    type: 'CONCEPT',
    bloom: 'Understand',
    ...overrides
});

const edge = (sourceId, targetId, id = `${sourceId}->${targetId}`) => ({
    id, sourceId, targetId, relation: 'rel'
});

describe('computeDirectedDegrees', () => {
    it('counts in and out separately for a chain', () => {
        const { inDeg, outDeg } = computeDirectedDegrees([
            edge('A', 'B'),
            edge('B', 'C')
        ]);
        expect(outDeg.get('A')).toBe(1);
        expect(inDeg.get('A')).toBeUndefined();
        expect(outDeg.get('B')).toBe(1);
        expect(inDeg.get('B')).toBe(1);
        expect(outDeg.get('C')).toBeUndefined();
        expect(inDeg.get('C')).toBe(1);
    });

    it('counts a self-loop in both maps', () => {
        const { inDeg, outDeg } = computeDirectedDegrees([edge('A', 'A')]);
        expect(inDeg.get('A')).toBe(1);
        expect(outDeg.get('A')).toBe(1);
    });

    it('returns empty maps for missing or empty input', () => {
        const a = computeDirectedDegrees([]);
        expect(a.inDeg.size).toBe(0);
        expect(a.outDeg.size).toBe(0);
        const b = computeDirectedDegrees(undefined);
        expect(b.inDeg.size).toBe(0);
        expect(b.outDeg.size).toBe(0);
    });
});

describe('binByInDegree', () => {
    it('maps each boundary to the right bucket', () => {
        expect(binByInDegree(0)).toBe(0);
        expect(binByInDegree(1)).toBe(1);
        expect(binByInDegree(2)).toBe(2);
        expect(binByInDegree(3)).toBe(2);
        expect(binByInDegree(4)).toBe(3);
        expect(binByInDegree(7)).toBe(3);
        expect(binByInDegree(8)).toBe(4);
        expect(binByInDegree(100)).toBe(4);
    });

    it('clamps non-finite / negative inputs to bucket 0', () => {
        expect(binByInDegree(-5)).toBe(0);
        expect(binByInDegree(NaN)).toBe(0);
        expect(binByInDegree(undefined)).toBe(0);
    });

    it('exposes 5 bins', () => {
        expect(IN_DEGREE_BINS.length).toBe(5);
    });
});

describe('degreeHistogram', () => {
    it('is dense from 0..max with correct counts', () => {
        const nodes = [node('A'), node('B'), node('C'), node('D')];
        const deg = new Map([['A', 0], ['B', 0], ['C', 2], ['D', 3]]);
        const hist = degreeHistogram(deg, nodes);
        expect(hist.length).toBe(4);
        expect(hist[0]).toEqual({ degree: 0, count: 2 });
        expect(hist[1]).toEqual({ degree: 1, count: 0 });
        expect(hist[2]).toEqual({ degree: 2, count: 1 });
        expect(hist[3]).toEqual({ degree: 3, count: 1 });
    });

    it('treats nodes missing from the map as degree 0', () => {
        const nodes = [node('A'), node('B')];
        const hist = degreeHistogram(new Map(), nodes);
        expect(hist).toEqual([{ degree: 0, count: 2 }]);
    });

    it('returns empty for empty node list', () => {
        expect(degreeHistogram(new Map(), [])).toEqual([]);
    });
});

describe('perChapterStacked', () => {
    it('sums byBin to total, and totals to assigned node count', () => {
        const nodes = [
            node('a1', { firstSeenChapter: 0 }),
            node('a2', { firstSeenChapter: 0 }),
            node('b1', { firstSeenChapter: 1 }),
            node('b2', { firstSeenChapter: 1 }),
            node('b3', { firstSeenChapter: 1 }),
            node('c1', { firstSeenChapter: 2 })
        ];
        const inDeg = new Map([
            ['a1', 0], ['a2', 5],
            ['b1', 1], ['b2', 3], ['b3', 12],
            ['c1', 0]
        ]);
        const rows = perChapterStacked(nodes, inDeg, 3);
        expect(rows).toHaveLength(3);
        for (const row of rows) {
            const sum = row.byBin.reduce((a, b) => a + b, 0);
            expect(sum).toBe(row.total);
        }
        const grandTotal = rows.reduce((s, r) => s + r.total, 0);
        expect(grandTotal).toBe(nodes.length);
        // ch1 (b1,b2,b3): in-deg 1 → bin1, 3 → bin2, 12 → bin4
        expect(rows[1].byBin).toEqual([0, 1, 1, 0, 1]);
    });

    it('drops nodes whose firstSeenChapter is out of range', () => {
        const nodes = [
            node('a', { firstSeenChapter: 0 }),
            node('b', { firstSeenChapter: 5 }),
            node('c', { firstSeenChapter: -1 })
        ];
        const rows = perChapterStacked(nodes, new Map(), 2);
        expect(rows[0].total).toBe(1);
        expect(rows[1].total).toBe(0);
    });

    it('returns empty array when chapterCount is 0', () => {
        expect(perChapterStacked([node('a')], new Map(), 0)).toEqual([]);
    });
});

describe('connectedComponents', () => {
    it('finds two triangles and an isolate', () => {
        const nodes = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => node(id));
        const edges = [
            edge('a', 'b'), edge('b', 'c'), edge('c', 'a'),
            edge('d', 'e'), edge('e', 'f'), edge('f', 'd')
            // g is isolated
        ];
        const sizes = connectedComponents(nodes, edges);
        expect(sizes.sort((a, b) => a - b)).toEqual([1, 3, 3]);
    });

    it('treats edges as undirected', () => {
        const nodes = [node('a'), node('b')];
        const sizes = connectedComponents(nodes, [edge('a', 'b')]);
        expect(sizes).toEqual([2]);
    });

    it('returns empty for empty nodes', () => {
        expect(connectedComponents([], [edge('a', 'b')])).toEqual([]);
    });

    it('ignores edges with unknown endpoints', () => {
        const nodes = [node('a'), node('b')];
        const sizes = connectedComponents(nodes, [edge('a', 'ghost')]);
        expect(sizes.sort()).toEqual([1, 1]);
    });
});

describe('componentSizeHistogram', () => {
    it('bins sizes according to COMPONENT_SIZE_BINS', () => {
        const counts = componentSizeHistogram([1, 1, 2, 3, 4, 5, 9, 10, 50]);
        // bins: 1, 2, 3–4, 5–9, 10+
        expect(counts).toEqual([2, 1, 2, 2, 2]);
        expect(COMPONENT_SIZE_BINS).toHaveLength(5);
    });
});

describe('topByDegree', () => {
    it('sorts by total degree desc, then by name asc', () => {
        const nodes = [
            node('alpha', { canonicalName: 'alpha' }),
            node('beta',  { canonicalName: 'beta'  }),
            node('gamma', { canonicalName: 'gamma' }),
            node('delta', { canonicalName: 'delta' })
        ];
        const inDeg = new Map([['alpha', 2], ['beta', 1], ['gamma', 1]]);
        const outDeg = new Map([['alpha', 3], ['beta', 4], ['delta', 0]]);
        const top = topByDegree(nodes, inDeg, outDeg, 10);
        expect(top.map((n) => n.canonicalName)).toEqual(['alpha', 'beta', 'gamma', 'delta']);
        expect(top[0].degree).toBe(5);
        expect(top[2].degree).toBe(1);
    });

    it('clamps k to node count', () => {
        const nodes = [node('a'), node('b')];
        expect(topByDegree(nodes, new Map(), new Map(), 99)).toHaveLength(2);
    });

    it('returns empty for empty input', () => {
        expect(topByDegree([], new Map(), new Map())).toEqual([]);
    });
});

describe('typeDistribution and bloomDistribution', () => {
    it('counts each NODE_TYPES bucket and routes unknowns to OTHER', () => {
        const nodes = [
            node('a', { type: 'PERSON' }),
            node('b', { type: 'PERSON' }),
            node('c', { type: 'CONCEPT' }),
            node('d', { type: 'UNKNOWN_TYPE' })
        ];
        const m = typeDistribution(nodes);
        expect(m.get('PERSON')).toBe(2);
        expect(m.get('CONCEPT')).toBe(1);
        expect(m.get('OTHER')).toBe(1);
        for (const t of NODE_TYPES) expect(m.has(t)).toBe(true);
    });

    it('counts bloom levels; unknown values dropped', () => {
        const nodes = [
            node('a', { bloom: 'Apply' }),
            node('b', { bloom: 'Apply' }),
            node('c', { bloom: 'Mystery' }),
            node('d', { bloom: null })
        ];
        const m = bloomDistribution(nodes);
        expect(m.get('Apply')).toBe(2);
        expect(m.get('Remember')).toBe(0);
        for (const b of BLOOM_LEVELS) expect(m.has(b)).toBe(true);
        const total = Array.from(m.values()).reduce((a, b) => a + b, 0);
        expect(total).toBe(2);
    });
});

describe('summary', () => {
    it('computes density, avg degree, isolated count and largest component', () => {
        const nodes = ['a', 'b', 'c', 'd'].map((id) => node(id));
        const edges = [edge('a', 'b'), edge('b', 'c')];
        const { inDeg, outDeg } = computeDirectedDegrees(edges);
        const s = summary(nodes, edges, inDeg, outDeg);
        expect(s.nodeCount).toBe(4);
        expect(s.edgeCount).toBe(2);
        // Total directed degree across all nodes = 2 * edgeCount
        expect(s.avgDegree).toBeCloseTo(1, 6);
        // Density = E / (N*(N-1)) = 2 / 12
        expect(s.density).toBeCloseTo(2 / 12, 6);
        expect(s.isolatedCount).toBe(1); // d
        expect(s.largestComponentSize).toBe(3); // {a,b,c}
        expect(s.componentCount).toBe(2);
    });

    it('handles the empty-graph case without dividing by zero', () => {
        const s = summary([], [], new Map(), new Map());
        expect(s).toMatchObject({
            nodeCount: 0,
            edgeCount: 0,
            avgDegree: 0,
            density: 0,
            isolatedCount: 0,
            largestComponentSize: 0,
            componentCount: 0
        });
    });

    it('density is 0 for a single-node graph', () => {
        const s = summary([node('a')], [], new Map(), new Map());
        expect(s.density).toBe(0);
    });
});
