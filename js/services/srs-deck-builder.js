/**
 * SRS Deck Builder — Workflow 2 (Curriculum Scheduler)
 *
 * Builds the active review deck from the persisted flashcards for a
 * book. The deck is a 2D priority queue:
 *
 *   P1  Diagnostics:   failed Level-1 cards (srsBox=0, lastResult='fail').
 *                      Oldest fail first. Uncapped — these are urgent.
 *   P2  Due Reviews:   any other card with nextReviewAt <= now (not new).
 *                      Oldest due first; tie-break by cognitive level asc
 *                      (so L1 reviews come before L2/L3 reviews when they
 *                      share a timestamp). Capped at srsMaxReviewsPerSession.
 *   P3  New:           cards with lastResult === 'new'. Centrality desc.
 *                      Capped at srsMaxNewPerSession.
 *
 * Before priority sorting, every Level-2/L3 card runs through the
 * **prerequisite gate**: each of its `targetNodeIds` must have at
 * least one L1 flashcard with srsBox >= 1. If any target node is
 * unmastered (failing or never seen), the advanced card is filtered
 * into `gatedOut` and held back until the foundations are passed.
 *
 * Centrality (for the P3 sort) is computed from the book's KG nodes
 * and edges via Phase 2's ranker. A card's centrality is the mean
 * centrality of its target nodes; missing nodes contribute nothing.
 * The score is attached as a non-persistent `__centrality` field on
 * the returned card objects so the diagnostic fallback (Phase 7) and
 * UI can read it without recomputing.
 */

import { rankNodesByCentrality } from './srs-centrality.js';

const NO_CENTRALITY = 0;

/**
 * @typedef {Object} BuildDeckArgs
 * @property {string} bookId
 * @property {Object} storage              - StorageService instance
 * @property {Object} settings             - SRS settings; srsMaxNew/Reviews per session
 * @property {number} [now]
 *
 * @typedef {Object} BuildDeckResult
 * @property {Object[]} deck               - cards in playback order
 * @property {Object[]} gatedOut           - cards held back by the prerequisite gate
 */

/**
 * @param {BuildDeckArgs} args
 * @returns {Promise<BuildDeckResult>}
 */
export async function buildActiveDeck({ bookId, storage, settings, now = Date.now() }) {
    const all = await storage.getFlashcardsForBook(bookId);
    if (!Array.isArray(all) || all.length === 0) {
        return { deck: [], gatedOut: [] };
    }

    // ---- centrality map: nodeId -> score ----
    // Fetched once per build; small per-book overhead.
    const [nodes, edges] = await Promise.all([
        storage.getKGNodesForBook(bookId),
        storage.getKGEdgesForBook(bookId)
    ]);
    const ranked = rankNodesByCentrality(nodes, edges);
    const centralityByNodeId = new Map();
    for (const r of ranked) centralityByNodeId.set(r.node.id, r.score);

    const cardCentrality = (card) => {
        const ids = card.targetNodeIds;
        if (!Array.isArray(ids) || ids.length === 0) return NO_CENTRALITY;
        let sum = 0, count = 0;
        for (const nid of ids) {
            const s = centralityByNodeId.get(nid);
            if (Number.isFinite(s)) { sum += s; count += 1; }
        }
        return count === 0 ? NO_CENTRALITY : sum / count;
    };

    // Attach __centrality to every card (the fallback in Phase 7 may need it
    // even on cards not in the active deck).
    for (const c of all) c.__centrality = cardCentrality(c);

    // ---- prerequisite-gate lookup: nodeId -> L1 cards covering it ----
    const l1ByNode = new Map();
    for (const c of all) {
        if (c.cognitiveLevel !== 1) continue;
        for (const nid of (c.targetNodeIds || [])) {
            if (!l1ByNode.has(nid)) l1ByNode.set(nid, []);
            l1ByNode.get(nid).push(c);
        }
    }

    // ---- eligibility: due OR new ----
    const eligible = all.filter((c) =>
        (Number.isFinite(c.nextReviewAt) && c.nextReviewAt <= now) ||
        c.lastResult === 'new'
    );

    // ---- prerequisite gate: only L2/L3 are checked ----
    const passed = [];
    const gatedOut = [];
    for (const card of eligible) {
        if (!(card.cognitiveLevel >= 2)) {
            passed.push(card);
            continue;
        }
        const ids = card.targetNodeIds || [];
        let allMastered = true;
        for (const nid of ids) {
            const l1s = l1ByNode.get(nid) ?? [];
            const masteredOnce = l1s.some((c) => c.srsBox >= 1);
            if (!masteredOnce) { allMastered = false; break; }
        }
        if (allMastered) passed.push(card);
        else gatedOut.push(card);
    }

    // ---- classify into priority buckets ----
    const P1 = [], P2 = [], P3 = [];
    for (const c of passed) {
        if (c.lastResult === 'new') {
            P3.push(c);
        } else if (c.cognitiveLevel === 1 && c.srsBox === 0 && c.lastResult === 'fail') {
            P1.push(c);
        } else {
            P2.push(c);
        }
    }

    // P1: oldest failure first.
    P1.sort((a, b) => a.nextReviewAt - b.nextReviewAt);
    // P2: oldest due first; tie-break by cognitive level asc (L1 before L2/L3).
    P2.sort((a, b) =>
        a.nextReviewAt - b.nextReviewAt ||
        (a.cognitiveLevel ?? 0) - (b.cognitiveLevel ?? 0)
    );
    // P3: centrality desc; tie-break by cognitive level asc (foundations first).
    P3.sort((a, b) =>
        (b.__centrality ?? 0) - (a.__centrality ?? 0) ||
        (a.cognitiveLevel ?? 0) - (b.cognitiveLevel ?? 0)
    );

    // ---- session caps ----
    const maxReviews = settings?.srsMaxReviewsPerSession;
    const maxNew = settings?.srsMaxNewPerSession;
    const cappedP2 = Number.isFinite(maxReviews) ? P2.slice(0, Math.max(0, maxReviews)) : P2;
    const cappedP3 = Number.isFinite(maxNew) ? P3.slice(0, Math.max(0, maxNew)) : P3;

    return {
        deck: [...P1, ...cappedP2, ...cappedP3],
        gatedOut
    };
}
