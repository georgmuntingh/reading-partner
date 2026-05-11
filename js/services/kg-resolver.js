/**
 * KG Resolver
 * Per-book entity & edge resolution.
 *
 * Resolves a freshly-extracted entity (with embedding) to either:
 *   - an existing kg_node (cosine similarity >= threshold OR exact-name match),
 *     in which case we accumulate aliases + per-chapter context indices, or
 *   - a brand-new kg_node initialised with SM-2 SRS stub fields.
 *
 * Edges are deduplicated by (sourceId, targetId, relation.toLowerCase()):
 * a duplicate (e.g. caused by chunk overlap) merges its sentence indices
 * into the existing record's contexts rather than creating a second row.
 */

import { storage } from './storage.js';

function uuid() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/**
 * Cosine similarity for two L2-normalised Float32Arrays.
 * (The embedding worker normalises the output, so a plain dot product
 *  equals the cosine.)
 */
export function cosine(a, b) {
    const len = Math.min(a.length, b.length);
    let s = 0;
    for (let i = 0; i < len; i++) s += a[i] * b[i];
    return s;
}

/**
 * Update a node's stored embedding to the L2-normalised running mean of
 * every observation it has merged so far. Reusing the cosine helper
 * downstream relies on unit-norm vectors, so we re-normalise after the
 * weighted update.
 *
 * @param {Float32Array | number[]} stored - The node's current embedding
 * @param {number} mergeCount - Observations already folded into `stored`
 * @param {Float32Array} incoming - The new observation to fold in
 * @returns {Float32Array} L2-normalised running mean
 */
export function updateRunningMean(stored, mergeCount, incoming) {
    const n = Math.max(1, mergeCount | 0);
    const a = stored instanceof Float32Array ? stored : Float32Array.from(stored);
    const len = Math.min(a.length, incoming.length);
    const out = new Float32Array(len);
    // mean_{n+1} = (mean_n * n + x_{n+1}) / (n + 1)
    for (let i = 0; i < len; i++) {
        out[i] = (a[i] * n + incoming[i]) / (n + 1);
    }
    let norm = 0;
    for (let i = 0; i < len; i++) norm += out[i] * out[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < len; i++) out[i] /= norm;
    return out;
}

export class KGResolver {
    /**
     * @param {Object} opts
     * @param {string} opts.bookId
     * @param {number} opts.similarityThreshold
     * @param {Float32Array} [opts.anchor] - L2-normalised "domain anchor"
     *   embedding. When present, each new entity's cosine to it is computed
     *   and stored as `relevanceScore`; entities below `relevanceThreshold`
     *   are dropped entirely (signalled by resolve() returning null).
     * @param {number} [opts.relevanceThreshold=0]
     */
    constructor({ bookId, similarityThreshold, anchor = null, relevanceThreshold = 0 }) {
        this.bookId = bookId;
        this.threshold = similarityThreshold;
        this._anchor = anchor instanceof Float32Array ? anchor : null;
        this._relevanceThreshold = Number.isFinite(relevanceThreshold) ? relevanceThreshold : 0;
        this._nodes = [];
        this._nodesByName = new Map();        // name.toLowerCase() -> node
        this._loaded = false;
        // Edge cache, lazy-initialised on first resolveEdge() call
        this._edges = null;
        this._edgesByKey = null;
        // Names dropped by the Tier-2 anchor gate. The controller consults
        // this set when filtering relations so an edge to a dropped entity
        // never reaches storage.
        this._droppedEntityNames = new Set();
    }

    /**
     * @param {string} name
     * @returns {boolean} true if Tier-2 gating dropped this name earlier
     *   in the current session.
     */
    wasDropped(name) {
        return this._droppedEntityNames.has(String(name || '').toLowerCase());
    }

    /**
     * Load the per-book candidate set. Idempotent.
     */
    async load() {
        if (this._loaded) return;
        this._nodes = await storage.getKGNodesForBook(this.bookId);
        for (const n of this._nodes) {
            this._nodesByName.set(n.canonicalName.toLowerCase(), n);
        }
        this._loaded = true;
    }

    async _loadEdges() {
        if (this._edges !== null) return;
        this._edges = await storage.getKGEdgesForBook(this.bookId);
        this._edgesByKey = new Map();
        for (const e of this._edges) {
            this._edgesByKey.set(this._edgeKey(e.sourceId, e.targetId, e.relation), e);
        }
    }

    _edgeKey(sourceId, targetId, relation) {
        return `${sourceId}|${targetId}|${(relation || '').toLowerCase().trim()}`;
    }

    /**
     * Resolve one extracted entity (with its embedding) to a canonical node.
     * Existing-node path appends the new alias + chapter context.
     * New-node path initialises SM-2 SRS stub fields.
     *
     * @returns {Promise<{ id: string, created: boolean } | null>} null when the
     *   Tier-2 anchor gate dropped this entity. Callers should treat the
     *   entity as never extracted and skip relations referencing it.
     */
    async resolve({ name, type, aliases = [], bloom, embedding, chapterIndex, sentenceIndices }) {
        if (!this._loaded) await this.load();
        if (!(embedding instanceof Float32Array)) {
            throw new Error('resolve: embedding must be a Float32Array');
        }
        const now = Date.now();
        const lc = name.toLowerCase();

        // Tier-2 semantic gate. Skip when no anchor (blank domain or
        // anchor embedding failed). Done BEFORE the similarity search so
        // we never spend dedupe cycles on entities we're about to drop.
        let relevanceScore = null;
        if (this._anchor) {
            relevanceScore = cosine(this._anchor, embedding);
            if (relevanceScore < this._relevanceThreshold) {
                this._droppedEntityNames.add(lc);
                return null;
            }
        }

        // 1) Exact-name fast path
        let hit = this._nodesByName.get(lc);

        // 2) Cosine search
        if (!hit) {
            let best = null;
            let bestSim = -Infinity;
            for (const n of this._nodes) {
                const stored = n.embedding instanceof Float32Array
                    ? n.embedding
                    : Float32Array.from(n.embedding);
                const sim = cosine(embedding, stored);
                if (sim > bestSim) {
                    bestSim = sim;
                    best = n;
                }
            }
            if (best && bestSim >= this.threshold) hit = best;
        }

        if (hit) {
            // Accumulate aliases (canonicalName itself never appears as an alias)
            if (name !== hit.canonicalName && !hit.aliases.includes(name)) {
                hit.aliases.push(name);
            }
            for (const a of aliases) {
                if (a !== hit.canonicalName && !hit.aliases.includes(a)) {
                    hit.aliases.push(a);
                }
            }
            // Append (or extend) chapter context
            let ctx = hit.contexts.find((c) => c.chapterIndex === chapterIndex);
            if (!ctx) {
                ctx = { chapterIndex, sentenceIndices: [] };
                hit.contexts.push(ctx);
            }
            for (const si of sentenceIndices) {
                if (!ctx.sentenceIndices.includes(si)) ctx.sentenceIndices.push(si);
            }
            // Update the stored embedding to the L2-normalised running mean
            // of every observation that has merged into this node. Defaults
            // mergeCount=1 for legacy nodes created before this field existed.
            const prevCount = Number.isInteger(hit.mergeCount) && hit.mergeCount > 0
                ? hit.mergeCount
                : 1;
            hit.embedding = updateRunningMean(hit.embedding, prevCount, embedding);
            hit.mergeCount = prevCount + 1;
            hit.updatedAt = now;
            await storage.saveKGNode(hit);
            return { id: hit.id, created: false };
        }

        // 3) Create new node (SM-2 stub)
        const node = {
            id: `kgnode_${uuid()}`,
            bookId: this.bookId,
            canonicalName: name,
            aliases: aliases.slice(),
            type: type || 'OTHER',
            bloom: bloom || 'Remember',
            embedding,
            mergeCount: 1,                    // observations folded into `embedding`
            relevanceScore,                  // null when no anchor; preserved on disk
            contexts: [{ chapterIndex, sentenceIndices: sentenceIndices.slice() }],
            firstSeenChapter: chapterIndex,
            srs: {
                ease: 2.5,
                interval: 0,
                repetitions: 0,
                dueAt: now,
                lastReviewedAt: null
            },
            createdAt: now,
            updatedAt: now
        };
        await storage.saveKGNode(node);
        this._nodes.push(node);
        this._nodesByName.set(lc, node);
        return { id: node.id, created: true };
    }

    /**
     * Resolve an edge to either a new record or an existing
     * (sourceId, targetId, relation) row whose contexts get extended.
     */
    async resolveEdge({ sourceId, targetId, relation, chapterIndex, sentenceIndices }) {
        await this._loadEdges();
        const key = this._edgeKey(sourceId, targetId, relation);
        const existing = this._edgesByKey.get(key);

        if (existing) {
            let ctx = existing.contexts.find((c) => c.chapterIndex === chapterIndex);
            if (!ctx) {
                ctx = { chapterIndex, sentenceIndices: [] };
                existing.contexts.push(ctx);
            }
            for (const si of sentenceIndices) {
                if (!ctx.sentenceIndices.includes(si)) ctx.sentenceIndices.push(si);
            }
            await storage.saveKGEdge(existing);
            return { id: existing.id, created: false };
        }

        const edge = {
            id: `kgedge_${uuid()}`,
            bookId: this.bookId,
            sourceId,
            targetId,
            relation,
            contexts: [{ chapterIndex, sentenceIndices: sentenceIndices.slice() }],
            createdAt: Date.now()
        };
        await storage.saveKGEdge(edge);
        this._edges.push(edge);
        this._edgesByKey.set(key, edge);
        return { id: edge.id, created: true };
    }
}
