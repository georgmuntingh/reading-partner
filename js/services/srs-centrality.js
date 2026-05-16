/**
 * SRS Centrality & Pertinence
 *
 * Pure functions for ranking knowledge-graph nodes by "how important they
 * are to test first" — used by the grounded card generator to pick the
 * highest-leverage concepts, and by the deck scheduler to sort new (Box 0)
 * cards in centrality-descending order.
 *
 * Centrality combines three signals:
 *   - Network degree:  how many edges touch the node (incoming + outgoing)
 *   - Context freq:    how many distinct sentence mentions the node has
 *   - Relevance score: cosine similarity to the book's domain anchor
 *
 * Each signal is min-max normalized across the candidate pool so a node
 * with degree 12 cannot drown out one with relevanceScore 0.95. Nodes
 * without a relevanceScore (no domain anchor configured for the book)
 * fall back to 0.5 — neutral, not zero.
 */

export const DEFAULT_WEIGHTS = Object.freeze({
    degree: 0.4,
    context: 0.3,
    relevance: 0.3
});

const RELEVANCE_FALLBACK = 0.5;

/**
 * Count the degree (incoming + outgoing) of every node referenced by the
 * given edges. Self-loops contribute 1, not 2 — a node related to itself
 * is not "twice as connected".
 *
 * @param {Array<{sourceId: string, targetId: string}>} edges
 * @returns {Map<string, number>} nodeId → degree
 */
export function computeNodeDegrees(edges) {
    const degrees = new Map();
    if (!Array.isArray(edges)) return degrees;
    for (const e of edges) {
        if (!e) continue;
        const s = e.sourceId;
        const t = e.targetId;
        if (s) degrees.set(s, (degrees.get(s) ?? 0) + 1);
        if (t && t !== s) degrees.set(t, (degrees.get(t) ?? 0) + 1);
    }
    return degrees;
}

/**
 * Total number of distinct sentence mentions across a node's contexts.
 * (The same sentence index in the same chapter is not deduped here —
 * the resolver already deduplicates, so the array reflects real mentions.)
 *
 * @param {Object} node
 * @returns {number}
 */
export function contextFrequency(node) {
    if (!node || !Array.isArray(node.contexts)) return 0;
    let total = 0;
    for (const ctx of node.contexts) {
        if (Array.isArray(ctx?.sentenceIndices)) total += ctx.sentenceIndices.length;
    }
    return total;
}

function relevanceOf(node) {
    return (typeof node?.relevanceScore === 'number') ? node.relevanceScore : RELEVANCE_FALLBACK;
}

function minMax(value, min, max) {
    if (max <= min) return 0; // degenerate pool: everyone ties at 0
    return (value - min) / (max - min);
}

function statsOf(values) {
    if (values.length === 0) return { min: 0, max: 0 };
    let min = Infinity, max = -Infinity;
    for (const v of values) {
        if (v < min) min = v;
        if (v > max) max = v;
    }
    return { min, max };
}

/**
 * Compute a centrality score for a single node, normalized against the
 * supplied pool statistics. Used by `rankNodesByCentrality` internally
 * and exported so callers can score one node against an existing pool
 * (e.g. attaching `__centrality` to fallback-injected cards).
 *
 * @param {Object} node
 * @param {Object} ctx
 * @param {Map<string, number>} ctx.degreeMap
 * @param {{degree: {min, max}, contextFreq: {min, max}}} ctx.poolStats
 * @param {{degree: number, context: number, relevance: number}} [ctx.weights]
 * @returns {number} score in roughly [0, sum-of-weights]
 */
export function centrality(node, { degreeMap, poolStats, weights = DEFAULT_WEIGHTS } = {}) {
    if (!node) return 0;
    const d = degreeMap?.get(node.id) ?? 0;
    const cf = contextFrequency(node);
    const rel = relevanceOf(node);
    const nd = minMax(d, poolStats.degree.min, poolStats.degree.max);
    const nc = minMax(cf, poolStats.contextFreq.min, poolStats.contextFreq.max);
    return weights.degree * nd + weights.context * nc + weights.relevance * rel;
}

/**
 * Rank a pool of nodes by centrality, descending. Min-max normalization
 * is computed once over the supplied pool.
 *
 * @param {Object[]} nodes
 * @param {Array<{sourceId: string, targetId: string}>} edges
 * @param {Object} [opts]
 * @param {Object} [opts.weights]            — override DEFAULT_WEIGHTS
 * @param {Map<string, number>} [opts.degreeMap] — pre-computed (avoids recompute)
 * @returns {Array<{node: Object, score: number}>}
 */
export function rankNodesByCentrality(nodes, edges, opts = {}) {
    if (!Array.isArray(nodes) || nodes.length === 0) return [];
    const weights = opts.weights ?? DEFAULT_WEIGHTS;
    const degreeMap = opts.degreeMap ?? computeNodeDegrees(edges);

    const degrees = nodes.map((n) => degreeMap.get(n.id) ?? 0);
    const freqs = nodes.map(contextFrequency);
    const poolStats = {
        degree: statsOf(degrees),
        contextFreq: statsOf(freqs)
    };

    const ranked = nodes.map((node) => ({
        node,
        score: centrality(node, { degreeMap, poolStats, weights })
    }));
    ranked.sort((a, b) => b.score - a.score);
    return ranked;
}

/**
 * Filter nodes to those the user has plausibly encountered while reading,
 * i.e. whose first appearance is at or before `chapterIndex`. Nodes
 * missing `firstSeenChapter` are conservatively excluded.
 *
 * @param {Object[]} nodes
 * @param {number} chapterIndex
 * @returns {Object[]}
 */
export function nodesEncounteredUpTo(nodes, chapterIndex) {
    if (!Array.isArray(nodes)) return [];
    if (!Number.isFinite(chapterIndex)) return [];
    return nodes.filter((n) =>
        typeof n?.firstSeenChapter === 'number' && n.firstSeenChapter <= chapterIndex
    );
}
