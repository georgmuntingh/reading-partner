import { describe, it, expect } from 'vitest';
import {
    newCardDefaults,
    applyReviewResult,
    isDue
} from '../js/services/srs-scheduler.js';

const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;

const SETTINGS = {
    srsEaseDefault: 2.5,
    srsEaseMin: 1.3,
    srsEaseStepFail: 0.2,
    srsFailIntervalMinutes: 10
};

const NOW = 1_700_000_000_000;

// A card just past newCardDefaults — convenient base for review tests.
const newCard = (overrides = {}) => ({
    id: 'fc1',
    bookId: 'b1',
    cognitiveLevel: 1,
    targetNodeIds: ['n1'],
    targetEdgeIds: [],
    ...newCardDefaults(SETTINGS, NOW),
    ...overrides
});

// ---------- newCardDefaults ----------

describe('newCardDefaults', () => {
    it('returns the SM-2 starting state from settings', () => {
        const d = newCardDefaults(SETTINGS, NOW);
        expect(d.srsBox).toBe(0);
        expect(d.ease).toBe(2.5);
        expect(d.interval).toBe(0);
        expect(d.repetitions).toBe(0);
        expect(d.lastResult).toBe('new');
        expect(d.lastReviewedAt).toBeNull();
        expect(d.nextReviewAt).toBe(NOW);
        expect(d.createdAt).toBe(NOW);
        expect(d.updatedAt).toBe(NOW);
    });

    it('falls back to sensible defaults when settings are missing', () => {
        const d = newCardDefaults({}, NOW);
        expect(d.ease).toBe(2.5);
    });

    it('respects a custom srsEaseDefault from settings', () => {
        const d = newCardDefaults({ srsEaseDefault: 1.8 }, NOW);
        expect(d.ease).toBe(1.8);
    });
});

// ---------- applyReviewResult: pass progression ----------

describe('applyReviewResult — pass progression', () => {
    it('first pass: interval 1d, srsBox=1, repetitions=1, ease unchanged, lastResult=pass', () => {
        const card = newCard();
        const out = applyReviewResult(card, 'pass', SETTINGS, NOW);
        expect(out.repetitions).toBe(1);
        expect(out.interval).toBe(1);
        expect(out.srsBox).toBe(1);
        expect(out.ease).toBe(2.5);
        expect(out.lastResult).toBe('pass');
        expect(out.nextReviewAt).toBe(NOW + 1 * MS_PER_DAY);
        expect(out.lastReviewedAt).toBe(NOW);
        expect(out.updatedAt).toBe(NOW);
    });

    it('second pass: interval 6d, srsBox=2', () => {
        const card = newCard({ repetitions: 1, interval: 1, srsBox: 1, lastResult: 'pass' });
        const out = applyReviewResult(card, 'pass', SETTINGS, NOW);
        expect(out.repetitions).toBe(2);
        expect(out.interval).toBe(6);
        expect(out.srsBox).toBe(2);
        expect(out.nextReviewAt).toBe(NOW + 6 * MS_PER_DAY);
    });

    it('third pass: interval = round(prevInterval * ease) = round(6 * 2.5) = 15d', () => {
        const card = newCard({ repetitions: 2, interval: 6, srsBox: 2, lastResult: 'pass' });
        const out = applyReviewResult(card, 'pass', SETTINGS, NOW);
        expect(out.repetitions).toBe(3);
        expect(out.interval).toBe(15);
        expect(out.srsBox).toBe(3);
        expect(out.nextReviewAt).toBe(NOW + 15 * MS_PER_DAY);
    });

    it('fourth pass: interval = round(15 * 2.5) = 38d', () => {
        const card = newCard({ repetitions: 3, interval: 15, srsBox: 3, lastResult: 'pass' });
        const out = applyReviewResult(card, 'pass', SETTINGS, NOW);
        expect(out.repetitions).toBe(4);
        expect(out.interval).toBe(38);
        expect(out.srsBox).toBe(4);
    });

    it('srsBox caps at 5 even after many consecutive passes', () => {
        const card = newCard({ repetitions: 8, interval: 100, srsBox: 5, lastResult: 'pass' });
        const out = applyReviewResult(card, 'pass', SETTINGS, NOW);
        expect(out.repetitions).toBe(9);
        expect(out.srsBox).toBe(5);
    });

    it('clamps interval to a minimum of 1 day on the long-tail branch', () => {
        // Hypothetical degenerate input: prevInterval=0 would normally yield 0.
        const card = newCard({ repetitions: 2, interval: 0, srsBox: 2, lastResult: 'pass' });
        const out = applyReviewResult(card, 'pass', SETTINGS, NOW);
        // Branch: repetitions becomes 3, so it's the long-tail branch.
        expect(out.interval).toBeGreaterThanOrEqual(1);
    });
});

// ---------- applyReviewResult: fail behaviour ----------

describe('applyReviewResult — fail', () => {
    it('fail on a new card: srsBox=0, repetitions=0, nextReviewAt = now + failMinutes', () => {
        const card = newCard();
        const out = applyReviewResult(card, 'fail', SETTINGS, NOW);
        expect(out.repetitions).toBe(0);
        expect(out.srsBox).toBe(0);
        expect(out.interval).toBe(0);
        expect(out.lastResult).toBe('fail');
        expect(out.nextReviewAt).toBe(NOW + 10 * MS_PER_MINUTE);
        expect(out.ease).toBe(2.5 - 0.2);
    });

    it('fail resets a previously-passed card to srsBox=0 and drops ease', () => {
        const card = newCard({ repetitions: 3, interval: 15, srsBox: 3, ease: 2.5, lastResult: 'pass' });
        const out = applyReviewResult(card, 'fail', SETTINGS, NOW);
        expect(out.repetitions).toBe(0);
        expect(out.srsBox).toBe(0);
        expect(out.interval).toBe(0);
        expect(out.ease).toBeCloseTo(2.3, 5);
    });

    it('ease cannot drop below srsEaseMin no matter how many failures', () => {
        // Start at the floor and fail twice.
        const card = newCard({ ease: 1.3 });
        const after1 = applyReviewResult(card, 'fail', SETTINGS, NOW);
        expect(after1.ease).toBe(1.3);
        const after2 = applyReviewResult(after1, 'fail', SETTINGS, NOW);
        expect(after2.ease).toBe(1.3);
    });

    it('respects a custom srsFailIntervalMinutes', () => {
        const card = newCard();
        const out = applyReviewResult(card, 'fail', { ...SETTINGS, srsFailIntervalMinutes: 30 }, NOW);
        expect(out.nextReviewAt).toBe(NOW + 30 * MS_PER_MINUTE);
    });

    it('respects a custom srsEaseStepFail', () => {
        const card = newCard({ ease: 2.5 });
        const out = applyReviewResult(card, 'fail', { ...SETTINGS, srsEaseStepFail: 0.4 }, NOW);
        expect(out.ease).toBeCloseTo(2.1, 5);
    });
});

// ---------- applyReviewResult: invariants ----------

describe('applyReviewResult — invariants', () => {
    it('does not mutate the input card', () => {
        const card = newCard();
        const snapshot = JSON.parse(JSON.stringify(card));
        applyReviewResult(card, 'pass', SETTINGS, NOW);
        expect(card).toEqual(snapshot);
    });

    it('updates lastReviewedAt and updatedAt to `now` on every review', () => {
        const card = newCard();
        const out = applyReviewResult(card, 'pass', SETTINGS, NOW + 999);
        expect(out.lastReviewedAt).toBe(NOW + 999);
        expect(out.updatedAt).toBe(NOW + 999);
    });

    it('throws on an invalid result string', () => {
        expect(() => applyReviewResult(newCard(), 'maybe', SETTINGS, NOW)).toThrow();
    });

    it('throws when the card is missing', () => {
        expect(() => applyReviewResult(null, 'pass', SETTINGS, NOW)).toThrow();
    });

    it('initializes missing fields safely (legacy / partial cards)', () => {
        const card = {
            id: 'fc1', bookId: 'b1', cognitiveLevel: 1,
            targetNodeIds: ['n1'], targetEdgeIds: [],
            nextReviewAt: NOW
            // ease, interval, repetitions, srsBox missing
        };
        const out = applyReviewResult(card, 'pass', SETTINGS, NOW);
        expect(out.repetitions).toBe(1);
        expect(out.interval).toBe(1);
        expect(out.ease).toBe(2.5);
        expect(out.srsBox).toBe(1);
    });

    it('uses pickSetting fallbacks when a setting is missing', () => {
        const card = newCard();
        const out = applyReviewResult(card, 'fail', {}, NOW);
        // Uses DEFAULTS: srsFailIntervalMinutes=10, easeMin=1.3, easeStepFail=0.2
        expect(out.nextReviewAt).toBe(NOW + 10 * MS_PER_MINUTE);
        expect(out.ease).toBeCloseTo(2.3, 5);
    });
});

// ---------- isDue ----------

describe('isDue', () => {
    it('returns true when nextReviewAt is in the past', () => {
        expect(isDue({ nextReviewAt: NOW - 1000 }, NOW)).toBe(true);
    });

    it('returns true when nextReviewAt equals now (inclusive boundary)', () => {
        expect(isDue({ nextReviewAt: NOW }, NOW)).toBe(true);
    });

    it('returns false when nextReviewAt is in the future', () => {
        expect(isDue({ nextReviewAt: NOW + 1000 }, NOW)).toBe(false);
    });

    it('returns true for a brand-new card (nextReviewAt = createdAt = now)', () => {
        const card = newCard();
        expect(isDue(card, NOW)).toBe(true);
    });

    it('returns false for null/undefined or missing nextReviewAt', () => {
        expect(isDue(null, NOW)).toBe(false);
        expect(isDue(undefined, NOW)).toBe(false);
        expect(isDue({}, NOW)).toBe(false);
        expect(isDue({ nextReviewAt: 'not a number' }, NOW)).toBe(false);
    });
});
