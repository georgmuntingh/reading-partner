/**
 * SRS Mastery — band classification & per-record lookup maps
 *
 * Buckets the Leitner srsBox 0–5 axis into the three bands the UI
 * surfaces (failing / learning / mastered) plus an "any" pass-through
 * for the cycle's first non-off step. Pure functions — used by the
 * Flashcard Overview modal, the KG-explorer card-highlight button,
 * and the node-detail Flashcards section.
 *
 * Rules:
 *   srsBox === 0          → 'failing'   (Box 0 = just failed OR new — both signal "needs work")
 *   srsBox ∈ [1, 2]       → 'learning'  (passed once or twice; still consolidating)
 *   srsBox >= 3           → 'mastered'  (3+ consecutive passes; durable memory)
 *
 * The `any` band is used by the cycle's catch-all mode; it matches any
 * card regardless of srsBox.
 */

export const Band = Object.freeze({
    ANY: 'any',
    FAILING: 'failing',
    LEARNING: 'learning',
    MASTERED: 'mastered'
});

const BAND_COLORS = Object.freeze({
    any: 'var(--srs-band-any)',
    failing: 'var(--srs-band-failing)',
    learning: 'var(--srs-band-learning)',
    mastered: 'var(--srs-band-mastered)'
});

/**
 * Classify a card into a band by its srsBox.
 * @param {Object} card
 * @returns {'failing'|'learning'|'mastered'}
 */
export function bandFor(card) {
    const box = Number.isFinite(card?.srsBox) ? card.srsBox : 0;
    if (box <= 0) return Band.FAILING;
    if (box <= 2) return Band.LEARNING;
    return Band.MASTERED;
}

/**
 * Does the card fall in the requested band? `Band.ANY` matches every
 * card unconditionally — it's the cycle's "any card" mode.
 * @param {Object} card
 * @param {'any'|'failing'|'learning'|'mastered'} band
 * @returns {boolean}
 */
export function cardMatchesBand(card, band) {
    if (!card) return false;
    if (band === Band.ANY) return true;
    return bandFor(card) === band;
}

/**
 * Build a `nodeId → Flashcard[]` map. A single card lands under every
 * node it covers (its `targetNodeIds` is iterated).
 * @param {Object[]} cards
 * @returns {Map<string, Object[]>}
 */
export function cardsByNodeId(cards) {
    const out = new Map();
    if (!Array.isArray(cards)) return out;
    for (const c of cards) {
        if (!c || !Array.isArray(c.targetNodeIds)) continue;
        for (const nid of c.targetNodeIds) {
            if (typeof nid !== 'string') continue;
            const arr = out.get(nid);
            if (arr) arr.push(c);
            else out.set(nid, [c]);
        }
    }
    return out;
}

/**
 * Build an `edgeId → Flashcard[]` map. Each card's `targetEdgeIds` is
 * iterated, so a single L2 card listed in two edges' `targetEdgeIds`
 * appears under both keys (and a single edge covered by two different
 * L2 cards shows up in both arrays).
 * @param {Object[]} cards
 * @returns {Map<string, Object[]>}
 */
export function cardsByEdgeId(cards) {
    const out = new Map();
    if (!Array.isArray(cards)) return out;
    for (const c of cards) {
        if (!c || !Array.isArray(c.targetEdgeIds)) continue;
        for (const eid of c.targetEdgeIds) {
            if (typeof eid !== 'string') continue;
            const arr = out.get(eid);
            if (arr) arr.push(c);
            else out.set(eid, [c]);
        }
    }
    return out;
}

/**
 * CSS custom-property token for a band. The tokens themselves live in
 * `css/components.css` under :root.
 * @param {'any'|'failing'|'learning'|'mastered'} band
 * @returns {string}
 */
export function bandColor(band) {
    return BAND_COLORS[band] ?? BAND_COLORS.any;
}

/**
 * Human-readable "due in X" label for a flashcard. Falls back to
 * 'due now' when the timestamp is in the past or missing.
 *
 * Resolution: seconds (<1 min), minutes (<1 h), hours (<1 day), days.
 *
 * @param {Object} card
 * @param {number} [now]
 * @returns {string}
 */
export function dueLabel(card, now = Date.now()) {
    const t = card?.nextReviewAt;
    if (!Number.isFinite(t)) return 'due now';
    const diff = t - now;
    if (diff <= 0) return 'due now';
    const sec = Math.round(diff / 1000);
    if (sec < 60) return `in ${sec}s`;
    const min = Math.round(sec / 60);
    if (min < 60) return `in ${min}m`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `in ${hr}h`;
    const days = Math.round(hr / 24);
    return `in ${days}d`;
}
