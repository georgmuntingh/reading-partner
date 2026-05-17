import { describe, it, expect, vi } from 'vitest';
import { sortForCustomDeck, closeAllSRSurfaces } from '../js/utils/srs-app-helpers.js';

const c = (overrides = {}) => ({
    id: 'fc1', cognitiveLevel: 1, srsBox: 0, createdAt: 0,
    ...overrides
});

describe('sortForCustomDeck', () => {
    it('orders by cognitiveLevel ascending', () => {
        const out = sortForCustomDeck([
            c({ id: 'l3', cognitiveLevel: 3 }),
            c({ id: 'l1', cognitiveLevel: 1 }),
            c({ id: 'l2', cognitiveLevel: 2 })
        ]);
        expect(out.map((x) => x.id)).toEqual(['l1', 'l2', 'l3']);
    });

    it('breaks ties by srsBox ascending (failing first within a level)', () => {
        const out = sortForCustomDeck([
            c({ id: 'mastered', cognitiveLevel: 1, srsBox: 3 }),
            c({ id: 'failing',  cognitiveLevel: 1, srsBox: 0 }),
            c({ id: 'learning', cognitiveLevel: 1, srsBox: 1 })
        ]);
        expect(out.map((x) => x.id)).toEqual(['failing', 'learning', 'mastered']);
    });

    it('uses createdAt as the final tie-break (stable order)', () => {
        const out = sortForCustomDeck([
            c({ id: 'late',  cognitiveLevel: 1, srsBox: 0, createdAt: 200 }),
            c({ id: 'early', cognitiveLevel: 1, srsBox: 0, createdAt: 100 })
        ]);
        expect(out.map((x) => x.id)).toEqual(['early', 'late']);
    });

    it('returns a new array (does not mutate the input)', () => {
        const input = [
            c({ id: 'b', cognitiveLevel: 2 }),
            c({ id: 'a', cognitiveLevel: 1 })
        ];
        const snapshot = input.slice();
        sortForCustomDeck(input);
        expect(input).toEqual(snapshot);
    });

    it('returns [] for non-array input', () => {
        expect(sortForCustomDeck(null)).toEqual([]);
        expect(sortForCustomDeck(undefined)).toEqual([]);
        expect(sortForCustomDeck('not an array')).toEqual([]);
    });

    it('handles missing fields with safe defaults (level=1, box=0, createdAt=0)', () => {
        const out = sortForCustomDeck([
            { id: 'no-fields' },
            { id: 'has-level', cognitiveLevel: 3 }
        ]);
        expect(out[0].id).toBe('no-fields');
        expect(out[1].id).toBe('has-level');
    });
});

describe('closeAllSRSurfaces', () => {
    it('calls hide() on the flashcard overview when supplied', () => {
        const overview = { hide: vi.fn() };
        closeAllSRSurfaces({ flashcardOverview: overview });
        expect(overview.hide).toHaveBeenCalledTimes(1);
    });

    it('closes the graph explorer when it is open', () => {
        const explorer = { isOpen: vi.fn(() => true), close: vi.fn() };
        closeAllSRSurfaces({ graphExplorer: explorer });
        expect(explorer.close).toHaveBeenCalledTimes(1);
    });

    it('does NOT close the graph explorer when it is not open', () => {
        const explorer = { isOpen: vi.fn(() => false), close: vi.fn() };
        closeAllSRSurfaces({ graphExplorer: explorer });
        expect(explorer.close).not.toHaveBeenCalled();
    });

    it('is a no-op when no surfaces are supplied', () => {
        expect(() => closeAllSRSurfaces()).not.toThrow();
        expect(() => closeAllSRSurfaces({})).not.toThrow();
    });

    it('tolerates surfaces that do not implement the expected methods', () => {
        // Surfaces without hide() / isOpen() / close() must not throw.
        expect(() => closeAllSRSurfaces({
            flashcardOverview: {},
            graphExplorer: {}
        })).not.toThrow();
    });

    it('calls both surfaces independently — failure of one would not block the other', () => {
        const overview = { hide: vi.fn() };
        const explorer = { isOpen: vi.fn(() => true), close: vi.fn() };
        closeAllSRSurfaces({ flashcardOverview: overview, graphExplorer: explorer });
        expect(overview.hide).toHaveBeenCalledTimes(1);
        expect(explorer.close).toHaveBeenCalledTimes(1);
    });
});
