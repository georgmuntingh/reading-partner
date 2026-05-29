/**
 * Pure analytics helpers for the knowledge-graph statistics modal.
 *
 * All functions are side-effect free and take plain `nodes` / `edges`
 * arrays so they can be unit tested without a DOM or storage layer.
 *
 * Degrees here are DIRECTED. The undirected helper at
 * `srs-centrality.js:computeNodeDegrees` is not reusable because the
 * stats view needs in-degree and out-degree separately.
 */

export const IN_DEGREE_BINS = Object.freeze([
    { label: '0', test: (d) => d === 0 },
    { label: '1', test: (d) => d === 1 },
    { label: '2–3', test: (d) => d >= 2 && d <= 3 },
    { label: '4–7', test: (d) => d >= 4 && d <= 7 },
    { label: '8+', test: (d) => d >= 8 }
]);

export const COMPONENT_SIZE_BINS = Object.freeze([
    { label: '1', test: (s) => s === 1 },
    { label: '2', test: (s) => s === 2 },
    { label: '3–4', test: (s) => s >= 3 && s <= 4 },
    { label: '5–9', test: (s) => s >= 5 && s <= 9 },
    { label: '10+', test: (s) => s >= 10 }
]);

export const NODE_TYPES = Object.freeze([
    'PERSON', 'PLACE', 'OBJECT', 'EVENT', 'CONCEPT', 'OTHER'
]);

export const BLOOM_LEVELS = Object.freeze([
    'Remember', 'Understand', 'Apply', 'Analyze', 'Evaluate', 'Create'
]);

/**
 * Compute directed in/out-degree counts from an edge list.
 * Self-loops contribute 1 to both inDeg and outDeg of the node.
 *
 * @param {Array<{sourceId: string, targetId: string}>} edges
 * @returns {{ inDeg: Map<string, number>, outDeg: Map<string, number> }}
 */
export function computeDirectedDegrees(edges) {
    const inDeg = new Map();
    const outDeg = new Map();
    if (!Array.isArray(edges)) return { inDeg, outDeg };
    for (const e of edges) {
        if (!e) continue;
        const s = e.sourceId;
        const t = e.targetId;
        if (s) outDeg.set(s, (outDeg.get(s) ?? 0) + 1);
        if (t) inDeg.set(t, (inDeg.get(t) ?? 0) + 1);
    }
    return { inDeg, outDeg };
}

/**
 * Map an in-degree value to a bucket index 0..4 matching IN_DEGREE_BINS.
 * Negative/non-finite values bucket to 0.
 */
export function binByInDegree(deg) {
    const d = Number.isFinite(deg) && deg > 0 ? Math.floor(deg) : 0;
    for (let i = 0; i < IN_DEGREE_BINS.length; i++) {
        if (IN_DEGREE_BINS[i].test(d)) return i;
    }
    return IN_DEGREE_BINS.length - 1;
}

/**
 * Dense degree histogram: one entry per integer degree from 0..max(degree).
 * Nodes that never appear in `degreesMap` are treated as degree 0.
 *
 * @param {Map<string, number>} degreesMap
 * @param {Array<{id: string}>} nodes
 * @returns {Array<{ degree: number, count: number }>}
 */
export function degreeHistogram(degreesMap, nodes) {
    const counts = [];
    if (!Array.isArray(nodes) || nodes.length === 0) return counts;
    let max = 0;
    const each = new Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
        const d = degreesMap?.get(nodes[i].id) ?? 0;
        each[i] = d;
        if (d > max) max = d;
    }
    for (let d = 0; d <= max; d++) counts.push({ degree: d, count: 0 });
    for (const d of each) counts[d].count += 1;
    return counts;
}

/**
 * For each chapter, count how many nodes were first introduced in it
 * (node.firstSeenChapter), partitioned into the 5 IN_DEGREE_BINS.
 *
 * @param {Array} nodes
 * @param {Map<string, number>} inDeg
 * @param {number} chapterCount
 * @returns {Array<{ chapterIndex: number, total: number, byBin: number[] }>}
 */
export function perChapterStacked(nodes, inDeg, chapterCount) {
    const safeCount = Number.isFinite(chapterCount) && chapterCount > 0 ? chapterCount : 0;
    const rows = [];
    for (let i = 0; i < safeCount; i++) {
        rows.push({
            chapterIndex: i,
            total: 0,
            byBin: new Array(IN_DEGREE_BINS.length).fill(0)
        });
    }
    if (!Array.isArray(nodes) || safeCount === 0) return rows;
    for (const n of nodes) {
        const ci = n?.firstSeenChapter;
        if (!Number.isFinite(ci) || ci < 0 || ci >= safeCount) continue;
        const bin = binByInDegree(inDeg?.get(n.id) ?? 0);
        rows[ci].total += 1;
        rows[ci].byBin[bin] += 1;
    }
    return rows;
}

/**
 * Undirected connected components via union-find.
 * Returns an array of component sizes (one entry per component, isolated
 * nodes contribute size-1 entries).
 */
export function connectedComponents(nodes, edges) {
    if (!Array.isArray(nodes) || nodes.length === 0) return [];
    const parent = new Map();
    const rank = new Map();
    for (const n of nodes) {
        parent.set(n.id, n.id);
        rank.set(n.id, 0);
    }
    const find = (x) => {
        let r = x;
        while (parent.get(r) !== r) r = parent.get(r);
        // path compression
        let cur = x;
        while (parent.get(cur) !== r) {
            const next = parent.get(cur);
            parent.set(cur, r);
            cur = next;
        }
        return r;
    };
    const union = (a, b) => {
        const ra = find(a);
        const rb = find(b);
        if (ra === rb) return;
        const ar = rank.get(ra);
        const br = rank.get(rb);
        if (ar < br) parent.set(ra, rb);
        else if (ar > br) parent.set(rb, ra);
        else { parent.set(rb, ra); rank.set(ra, ar + 1); }
    };
    if (Array.isArray(edges)) {
        for (const e of edges) {
            if (!e) continue;
            // Skip edges whose endpoints are not in the node set — keeps
            // results well defined if storage hands us a stale edge.
            if (!parent.has(e.sourceId) || !parent.has(e.targetId)) continue;
            union(e.sourceId, e.targetId);
        }
    }
    const sizes = new Map();
    for (const n of nodes) {
        const r = find(n.id);
        sizes.set(r, (sizes.get(r) ?? 0) + 1);
    }
    return Array.from(sizes.values()).sort((a, b) => b - a);
}

/**
 * Bucket connected-component sizes into COMPONENT_SIZE_BINS.
 * Returns a parallel array of counts.
 */
export function componentSizeHistogram(sizes) {
    const counts = new Array(COMPONENT_SIZE_BINS.length).fill(0);
    if (!Array.isArray(sizes)) return counts;
    for (const s of sizes) {
        for (let i = 0; i < COMPONENT_SIZE_BINS.length; i++) {
            if (COMPONENT_SIZE_BINS[i].test(s)) {
                counts[i] += 1;
                break;
            }
        }
    }
    return counts;
}

/**
 * Top-k nodes by total degree (in + out). Ties broken by canonicalName
 * (ascending) so the list is stable across renders.
 */
export function topByDegree(nodes, inDeg, outDeg, k = 10) {
    if (!Array.isArray(nodes) || nodes.length === 0) return [];
    const scored = nodes.map((n) => ({
        id: n.id,
        canonicalName: n.canonicalName ?? n.id,
        inDegree: inDeg?.get(n.id) ?? 0,
        outDegree: outDeg?.get(n.id) ?? 0,
        degree: (inDeg?.get(n.id) ?? 0) + (outDeg?.get(n.id) ?? 0)
    }));
    scored.sort((a, b) => {
        if (b.degree !== a.degree) return b.degree - a.degree;
        return String(a.canonicalName).localeCompare(String(b.canonicalName));
    });
    return scored.slice(0, Math.max(0, Math.min(k, scored.length)));
}

/**
 * Count nodes by their `type` field. Returns a Map keyed by every entry in
 * NODE_TYPES (zero where absent), plus an 'OTHER' bucket for unknowns.
 */
export function typeDistribution(nodes) {
    const counts = new Map(NODE_TYPES.map((t) => [t, 0]));
    if (!Array.isArray(nodes)) return counts;
    for (const n of nodes) {
        const t = n?.type;
        if (t && counts.has(t)) counts.set(t, counts.get(t) + 1);
        else counts.set('OTHER', counts.get('OTHER') + 1);
    }
    return counts;
}

/**
 * Count nodes by their `bloom` field. Returns a Map keyed by every entry in
 * BLOOM_LEVELS. Unknowns are silently dropped.
 */
export function bloomDistribution(nodes) {
    const counts = new Map(BLOOM_LEVELS.map((b) => [b, 0]));
    if (!Array.isArray(nodes)) return counts;
    for (const n of nodes) {
        const b = n?.bloom;
        if (b && counts.has(b)) counts.set(b, counts.get(b) + 1);
    }
    return counts;
}

/**
 * Aggregate one-shot summary. `density` uses the directed formula
 * E / (N * (N - 1)); 0 when N < 2.
 */
export function summary(nodes, edges, inDeg, outDeg) {
    const nodeCount = Array.isArray(nodes) ? nodes.length : 0;
    const edgeCount = Array.isArray(edges) ? edges.length : 0;
    let totalDeg = 0;
    for (const n of (nodes ?? [])) {
        totalDeg += (inDeg?.get(n.id) ?? 0) + (outDeg?.get(n.id) ?? 0);
    }
    const avgDegree = nodeCount > 0 ? totalDeg / nodeCount : 0;
    const density = nodeCount > 1 ? edgeCount / (nodeCount * (nodeCount - 1)) : 0;
    let isolatedCount = 0;
    for (const n of (nodes ?? [])) {
        const total = (inDeg?.get(n.id) ?? 0) + (outDeg?.get(n.id) ?? 0);
        if (total === 0) isolatedCount += 1;
    }
    const componentSizes = connectedComponents(nodes ?? [], edges ?? []);
    const largestComponentSize = componentSizes.length > 0 ? componentSizes[0] : 0;
    return {
        nodeCount,
        edgeCount,
        avgDegree,
        density,
        isolatedCount,
        componentCount: componentSizes.length,
        largestComponentSize
    };
}
