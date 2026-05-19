import { describe, it, expect, beforeEach } from 'vitest';
import { StorageService } from '../js/services/storage.js';
import { injectFallbackCards } from '../js/services/srs-fallback.js';

const makeNode = (id, overrides = {}) => ({
    id,
    bookId: 'b1',
    canonicalName: id,
    aliases: [],
    type: 'OTHER',
    bloom: 'Remember',
    embedding: new Float32Array(1),
    contexts: [{ chapterIndex: 0, sentenceIndices: [0] }],
    firstSeenChapter: 0,
    relevanceScore: null,
    srs: {},
    createdAt: 0,
    updatedAt: 0,
    ...overrides
});

const makeEdge = (id, sourceId, targetId, overrides = {}) => ({
    id, bookId: 'b1', sourceId, targetId, relation: 'rel',
    contexts: [], createdAt: 0, ...overrides
});

const makeCard = (overrides = {}) => ({
    id: `fc_${Math.random().toString(36).slice(2, 9)}`,
    bookId: 'b1',
    cognitiveLevel: 1,
    targetNodeIds: [],
    targetEdgeIds: [],
    question: 'q', options: ['a', 'b', 'c', 'd'], correctIndex: 0,
    explanation: 'e', primaryChapterIndex: 0, primarySentenceIndex: 0,
    srsBox: 0, ease: 2.5, interval: 0, repetitions: 0,
    lastResult: 'new', lastReviewedAt: null,
    nextReviewAt: 0, createdAt: 0, updatedAt: 0,
    ...overrides
});

describe('injectFallbackCards', () => {
    let storage;

    beforeEach(async () => {
        storage = new StorageService();
        await storage.init();
    });

    it('returns the deck unchanged when the failed card is L1 (no fallback for foundations)', async () => {
        const deck = [makeCard({ id: 'next' })];
        const failed = makeCard({ id: 'l1', cognitiveLevel: 1, targetNodeIds: ['n1'] });
        const out = await injectFallbackCards({ failedCard: failed, deck, storage, bookId: 'b1' });
        expect(out.map((c) => c.id)).toEqual(['next']);
    });

    it('returns the deck unchanged when the failed card has no target nodes', async () => {
        const deck = [makeCard({ id: 'next' })];
        const failed = makeCard({ id: 'l2', cognitiveLevel: 2, targetNodeIds: [] });
        const out = await injectFallbackCards({ failedCard: failed, deck, storage, bookId: 'b1' });
        expect(out.map((c) => c.id)).toEqual(['next']);
    });

    it('returns a copy of the deck when no L1 prereqs exist for the failed targets', async () => {
        const deck = [makeCard({ id: 'next' })];
        const failed = makeCard({ id: 'l2', cognitiveLevel: 2, targetNodeIds: ['ghost'] });
        const out = await injectFallbackCards({ failedCard: failed, deck, storage, bookId: 'b1' });
        expect(out.map((c) => c.id)).toEqual(['next']);
        expect(out).not.toBe(deck); // a copy, even when no changes
    });

    it('pulls all L1 prereqs to the front of the deck when an L2 fails', async () => {
        await storage.saveFlashcard(makeCard({
            id: 'l1-a', cognitiveLevel: 1, targetNodeIds: ['n1']
        }));
        await storage.saveFlashcard(makeCard({
            id: 'l1-b', cognitiveLevel: 1, targetNodeIds: ['n2']
        }));
        const deck = [makeCard({ id: 'next' })];
        const failed = makeCard({ id: 'l2', cognitiveLevel: 2, targetNodeIds: ['n1', 'n2'] });
        const out = await injectFallbackCards({ failedCard: failed, deck, storage, bookId: 'b1' });
        const ids = out.map((c) => c.id);
        expect(ids).toContain('l1-a');
        expect(ids).toContain('l1-b');
        // The deck's original head ("next") must be pushed back.
        expect(ids[ids.length - 1]).toBe('next');
    });

    it('deduplicates when one L1 card covers multiple of the failed targets', async () => {
        // Single L1 card that lists both n1 and n2 as targets.
        await storage.saveFlashcard(makeCard({
            id: 'shared-l1', cognitiveLevel: 1, targetNodeIds: ['n1', 'n2']
        }));
        const deck = [];
        const failed = makeCard({ id: 'l2', cognitiveLevel: 2, targetNodeIds: ['n1', 'n2'] });
        const out = await injectFallbackCards({ failedCard: failed, deck, storage, bookId: 'b1' });
        expect(out.map((c) => c.id)).toEqual(['shared-l1']);
    });

    it('skips L1 cards already present in the deck', async () => {
        await storage.saveFlashcard(makeCard({
            id: 'l1-already', cognitiveLevel: 1, targetNodeIds: ['n1']
        }));
        await storage.saveFlashcard(makeCard({
            id: 'l1-new', cognitiveLevel: 1, targetNodeIds: ['n2']
        }));
        const deck = [makeCard({ id: 'l1-already', cognitiveLevel: 1, targetNodeIds: ['n1'] })];
        const failed = makeCard({ id: 'l2', cognitiveLevel: 2, targetNodeIds: ['n1', 'n2'] });
        const out = await injectFallbackCards({ failedCard: failed, deck, storage, bookId: 'b1' });
        // Order: only l1-new is injected; l1-already stays in its original slot.
        expect(out.map((c) => c.id)).toEqual(['l1-new', 'l1-already']);
    });

    it('does NOT pull non-L1 cards even if they cover the failed targets', async () => {
        await storage.saveFlashcard(makeCard({
            id: 'l1', cognitiveLevel: 1, targetNodeIds: ['n1']
        }));
        await storage.saveFlashcard(makeCard({
            id: 'other-l2', cognitiveLevel: 2, targetNodeIds: ['n1']
        }));
        const failed = makeCard({ id: 'failed-l2', cognitiveLevel: 2, targetNodeIds: ['n1'] });
        const out = await injectFallbackCards({ failedCard: failed, deck: [], storage, bookId: 'b1' });
        expect(out.map((c) => c.id)).toEqual(['l1']);
    });

    it('sorts injected remediation by centrality descending', async () => {
        // 3 nodes; edges give A degree 3, B degree 1, C degree 0.
        await storage.saveKGNode(makeNode('A'));
        await storage.saveKGNode(makeNode('B'));
        await storage.saveKGNode(makeNode('C'));
        await storage.saveKGEdge(makeEdge('e1', 'A', 'B'));
        await storage.saveKGEdge(makeEdge('e2', 'A', 'X'));
        await storage.saveKGEdge(makeEdge('e3', 'A', 'Y'));

        await storage.saveFlashcard(makeCard({
            id: 'fc-C', cognitiveLevel: 1, targetNodeIds: ['C']
        }));
        await storage.saveFlashcard(makeCard({
            id: 'fc-A', cognitiveLevel: 1, targetNodeIds: ['A']
        }));
        await storage.saveFlashcard(makeCard({
            id: 'fc-B', cognitiveLevel: 1, targetNodeIds: ['B']
        }));

        const failed = makeCard({
            id: 'l3', cognitiveLevel: 3, targetNodeIds: ['A', 'B', 'C']
        });
        const out = await injectFallbackCards({ failedCard: failed, deck: [], storage, bookId: 'b1' });
        expect(out.map((c) => c.id)).toEqual(['fc-A', 'fc-B', 'fc-C']);
    });

    it('attaches __centrality to each injected card', async () => {
        await storage.saveKGNode(makeNode('A'));
        await storage.saveFlashcard(makeCard({
            id: 'l1-A', cognitiveLevel: 1, targetNodeIds: ['A']
        }));
        const failed = makeCard({ id: 'l2', cognitiveLevel: 2, targetNodeIds: ['A'] });
        const out = await injectFallbackCards({ failedCard: failed, deck: [], storage, bookId: 'b1' });
        expect(typeof out[0].__centrality).toBe('number');
    });

    it('works for L3 failures (same logic — pulls all L1 prereqs)', async () => {
        await storage.saveFlashcard(makeCard({
            id: 'l1-a', cognitiveLevel: 1, targetNodeIds: ['n1']
        }));
        await storage.saveFlashcard(makeCard({
            id: 'l1-b', cognitiveLevel: 1, targetNodeIds: ['n2']
        }));
        await storage.saveFlashcard(makeCard({
            id: 'l1-c', cognitiveLevel: 1, targetNodeIds: ['n3']
        }));
        const failed = makeCard({
            id: 'l3', cognitiveLevel: 3, targetNodeIds: ['n1', 'n2', 'n3']
        });
        const out = await injectFallbackCards({ failedCard: failed, deck: [], storage, bookId: 'b1' });
        expect(out.map((c) => c.id).sort()).toEqual(['l1-a', 'l1-b', 'l1-c']);
    });

    it('does not mutate the input deck array', async () => {
        await storage.saveFlashcard(makeCard({
            id: 'l1', cognitiveLevel: 1, targetNodeIds: ['n1']
        }));
        const deck = [makeCard({ id: 'next' })];
        const snapshot = deck.slice();
        const failed = makeCard({ id: 'l2', cognitiveLevel: 2, targetNodeIds: ['n1'] });
        await injectFallbackCards({ failedCard: failed, deck, storage, bookId: 'b1' });
        expect(deck).toEqual(snapshot);
    });

    it('returns the deck unchanged when failedCard is null/undefined', async () => {
        const deck = [makeCard({ id: 'next' })];
        const out = await injectFallbackCards({ failedCard: null, deck, storage, bookId: 'b1' });
        expect(out).toBe(deck);
    });

    it('ignores L1 prereqs from other books (bookId scoped)', async () => {
        await storage.saveFlashcard(makeCard({
            id: 'mine', bookId: 'b1', cognitiveLevel: 1, targetNodeIds: ['n1']
        }));
        await storage.saveFlashcard(makeCard({
            id: 'theirs', bookId: 'b2', cognitiveLevel: 1, targetNodeIds: ['n1']
        }));
        const failed = makeCard({ id: 'l2', bookId: 'b1', cognitiveLevel: 2, targetNodeIds: ['n1'] });
        const out = await injectFallbackCards({ failedCard: failed, deck: [], storage, bookId: 'b1' });
        expect(out.map((c) => c.id)).toEqual(['mine']);
    });
});
