/**
 * SRS app-level helpers
 *
 * Tiny utilities extracted from `js/app.js` so they can be unit-tested
 * without standing up the full app shell. They live outside `app.js`
 * by accident of testability, not because they have a richer home.
 */

/**
 * Order a flashcard list for play in a micro-review session.
 *
 * Curriculum-first ordering: L1 definitions before L2 relations before
 * L3 triangulations. Within a level, failing cards first (the user
 * has explicitly asked for a focused drill, so the weakest items
 * lead). `createdAt` is the final tie-break for stable order.
 *
 * Used by both *Review Selection* (filtered Overview subset) and
 * *Review this concept* (single-node drill). The controller itself
 * does no sorting — keeping the policy at the app boundary lets
 * future callers override it (e.g. a centrality-first drill).
 *
 * @param {Object[]} cards
 * @returns {Object[]}  new array (the input is not mutated)
 */
export function sortForCustomDeck(cards) {
    if (!Array.isArray(cards)) return [];
    return cards.slice().sort((a, b) =>
        (a?.cognitiveLevel ?? 1) - (b?.cognitiveLevel ?? 1) ||
        (a?.srsBox ?? 0) - (b?.srsBox ?? 0) ||
        (a?.createdAt ?? 0) - (b?.createdAt ?? 0)
    );
}

/**
 * Close every SRS-related surface that might be sitting on top of
 * the reader so the user lands on the reader canvas (and not a
 * lingering modal/canvas) after a navigation event.
 *
 * Both arguments are optional — a no-op when nothing is open.
 *
 * @param {Object} surfaces
 * @param {Object} [surfaces.flashcardOverview]   FlashcardOverview instance
 * @param {Object} [surfaces.graphExplorer]       GraphExplorer instance
 */
export function closeAllSRSurfaces({ flashcardOverview, graphExplorer } = {}) {
    flashcardOverview?.hide?.();
    if (graphExplorer?.isOpen?.()) graphExplorer.close?.();
}
