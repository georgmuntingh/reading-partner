/**
 * SRS Scheduler — SM-2 evaluator with an `srsBox` shim
 *
 * Pure functions that apply a pass/fail review result to a flashcard
 * and produce a new card record. State lives entirely on the card
 * (decoupled from kg_nodes / kg_edges); these functions never touch IO.
 *
 * Why SM-2 *and* `srsBox`?
 *   The product spec mandates an `srsBox` field that gates Level 2/3
 *   cards (prerequisite gate in Workflow 2). The user chose SM-2 over
 *   Leitner for actual scheduling. We satisfy both: `ease`, `interval`,
 *   and `repetitions` drive `nextReviewAt` via classic SM-2; `srsBox`
 *   is a derived mastery level (0 = failing or unseen, 1..5 = number
 *   of consecutive passes capped at 5) so the gate semantics survive
 *   verbatim.
 *
 * Ease policy: pure SM-2 only adjusts ease on a graded fail / easy
 * response. We only model pass/fail, so ease is unchanged on pass and
 * drops by `srsEaseStepFail` on fail (clamped to `srsEaseMin`).
 */

const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;
const SRS_BOX_CAP = 5;

const DEFAULTS = {
    srsEaseDefault: 2.5,
    srsEaseMin: 1.3,
    srsEaseStepFail: 0.2,
    srsFailIntervalMinutes: 10
};

function pickSetting(settings, key) {
    const v = settings?.[key];
    return Number.isFinite(v) ? v : DEFAULTS[key];
}

/**
 * Build the default state block for a freshly-created flashcard.
 * Callers spread this onto the rest of the card shape (id, bookId,
 * question, options, etc.) — see Phase 8's generator.
 *
 * A new card's nextReviewAt is `now` so it is immediately considered
 * "due" by the scheduler and shows up in the deck on the next open.
 *
 * @param {Object} settings
 * @param {number} [now]
 * @returns {Object}
 */
export function newCardDefaults(settings = {}, now = Date.now()) {
    return {
        srsBox: 0,
        ease: pickSetting(settings, 'srsEaseDefault'),
        interval: 0,
        repetitions: 0,
        lastResult: 'new',
        lastReviewedAt: null,
        nextReviewAt: now,
        createdAt: now,
        updatedAt: now
    };
}

/**
 * Apply a graded review result to a card.
 *
 * @param {Object} card                  - flashcard record
 * @param {'pass' | 'fail'} result
 * @param {Object} settings              - srsEaseMin, srsEaseStepFail, srsFailIntervalMinutes
 * @param {number} [now]
 * @returns {Object} a NEW card object (input is not mutated)
 */
export function applyReviewResult(card, result, settings = {}, now = Date.now()) {
    if (!card) throw new Error('applyReviewResult: card is required');
    if (result !== 'pass' && result !== 'fail') {
        throw new Error(`applyReviewResult: result must be 'pass' or 'fail', got ${result}`);
    }
    const easeMin = pickSetting(settings, 'srsEaseMin');
    const easeStepFail = pickSetting(settings, 'srsEaseStepFail');
    const failMinutes = pickSetting(settings, 'srsFailIntervalMinutes');

    // Defensively initialize fields that might be missing on legacy cards.
    const prevEase = Number.isFinite(card.ease) ? card.ease : pickSetting(settings, 'srsEaseDefault');
    const prevRepetitions = Number.isFinite(card.repetitions) ? card.repetitions : 0;
    const prevInterval = Number.isFinite(card.interval) ? card.interval : 0;

    const next = {
        ...card,
        ease: prevEase,
        repetitions: prevRepetitions,
        interval: prevInterval,
        lastReviewedAt: now,
        updatedAt: now
    };

    if (result === 'pass') {
        next.repetitions = prevRepetitions + 1;
        next.lastResult = 'pass';
        // SM-2 interval schedule: 1d, 6d, then prev*ease for subsequent passes.
        if (next.repetitions === 1) {
            next.interval = 1;
        } else if (next.repetitions === 2) {
            next.interval = 6;
        } else {
            next.interval = Math.max(1, Math.round(prevInterval * prevEase));
        }
        // Pure SM-2 with binary pass/fail leaves ease unchanged on pass.
        next.nextReviewAt = now + next.interval * MS_PER_DAY;
        next.srsBox = Math.min(SRS_BOX_CAP, next.repetitions);
    } else {
        next.repetitions = 0;
        next.lastResult = 'fail';
        next.ease = Math.max(easeMin, prevEase - easeStepFail);
        next.interval = 0;
        next.nextReviewAt = now + failMinutes * MS_PER_MINUTE;
        next.srsBox = 0;
    }

    return next;
}

/**
 * Whether a card is due for review at the given time.
 * New cards (lastResult === 'new') created with `nextReviewAt = now`
 * are due immediately.
 *
 * @param {Object} card
 * @param {number} [now]
 * @returns {boolean}
 */
export function isDue(card, now = Date.now()) {
    if (!card || !Number.isFinite(card.nextReviewAt)) return false;
    return card.nextReviewAt <= now;
}
