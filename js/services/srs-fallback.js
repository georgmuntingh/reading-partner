/**
 * SRS Diagnostic Fallback — Workflow 3, step 3
 *
 * When the user fails an L2 or L3 card, immediately pull the Level-1
 * cards covering each of its `targetNodeIds` to the front of the
 * active deck. The premise: failure on a relation (L2) or
 * triangulation (L3) most often signals decayed foundations, so we
 * drill the underlying concepts before retrying the harder card.
 *
 * The pulled L1 cards are deduped against:
 *   - each other (an L1 that covers two of the failed card's targets
 *     is injected once)
 *   - cards already in the deck (we never duplicate)
 *
 * Sorted by centrality desc so the most structurally important
 * foundations come first.
 *
 * NOTE: This is pure with respect to the deck (a new array is
 * returned; the input deck is not mutated). The injected L1 cards
 * themselves are decorated in place with `__centrality` so downstream
 * UI / scheduler code can read the same score the deck builder uses.
 */

import { rankNodesByCentrality } from './srs-centrality.js';

/**
 * Mean centrality of a card across its target nodes. Missing nodes
 * (e.g. deleted via KG merge) contribute nothing. Returns 0 when the
 * card has no targets, or none of its targets are scored.
 */
function meanCentrality(card, byNodeId) {
    const ids = card?.targetNodeIds;
    if (!Array.isArray(ids) || ids.length === 0) return 0;
    let sum = 0, count = 0;
    for (const nid of ids) {
        const s = byNodeId.get(nid);
        if (Number.isFinite(s)) { sum += s; count += 1; }
    }
    return count === 0 ? 0 : sum / count;
}

/**
 * @typedef {Object} InjectFallbackArgs
 * @property {Object} failedCard           - the card the user just got wrong
 * @property {Object[]} deck               - the current playback queue (head = next)
 * @property {Object} storage              - StorageService instance
 * @property {string} bookId
 *
 * @param {InjectFallbackArgs} args
 * @returns {Promise<Object[]>}            - new deck with remediation L1s prepended
 */
export async function injectFallbackCards({ failedCard, deck, storage, bookId }) {
    if (!failedCard) return deck;
    const level = failedCard.cognitiveLevel ?? 1;
    if (level < 2) return deck;
    const targets = Array.isArray(failedCard.targetNodeIds) ? failedCard.targetNodeIds : [];
    if (targets.length === 0) return deck;

    const safeDeck = Array.isArray(deck) ? deck : [];
    const inDeck = new Set(safeDeck.map((d) => d.id));
    const seen = new Set();
    const remediation = [];

    for (const nid of targets) {
        const cards = await storage.getFlashcardsByNodeId(bookId, nid);
        for (const c of cards) {
            if (c.cognitiveLevel !== 1) continue;
            if (inDeck.has(c.id) || seen.has(c.id)) continue;
            seen.add(c.id);
            remediation.push(c);
        }
    }

    if (remediation.length === 0) return safeDeck.slice();

    // Score by centrality. One graph fetch per fallback — cheap and
    // mirrors what the deck builder does on each rebuild.
    const [nodes, edges] = await Promise.all([
        storage.getKGNodesForBook(bookId),
        storage.getKGEdgesForBook(bookId)
    ]);
    const byNodeId = new Map();
    for (const r of rankNodesByCentrality(nodes, edges)) {
        byNodeId.set(r.node.id, r.score);
    }
    for (const c of remediation) c.__centrality = meanCentrality(c, byNodeId);

    remediation.sort((a, b) => (b.__centrality ?? 0) - (a.__centrality ?? 0));

    return [...remediation, ...safeDeck];
}
