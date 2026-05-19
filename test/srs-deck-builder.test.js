import { describe, it, expect, beforeEach } from 'vitest';
import { StorageService } from '../js/services/storage.js';
import { buildActiveDeck } from '../js/services/srs-deck-builder.js';

const NOW = 1_700_000_000_000;
const PAST = NOW - 60_000;
const FUTURE = NOW + 60_000;

const SETTINGS = {
    srsMaxNewPerSession: 100,
    srsMaxReviewsPerSession: 100
};

// ---------- Helpers ----------

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
    id,
    bookId: 'b1',
    sourceId,
    targetId,
    relation: 'rel',
    contexts: [],
    createdAt: 0,
    ...overrides
});

const makeCard = (overrides = {}) => ({
    id: `fc_${Math.random().toString(36).slice(2, 9)}`,
    bookId: 'b1',
    cognitiveLevel: 1,
    targetNodeIds: [],
    targetEdgeIds: [],
    question: 'q',
    options: ['a', 'b', 'c', 'd'],
    correctIndex: 0,
    explanation: 'e',
    primaryChapterIndex: 0,
    primarySentenceIndex: 0,
    srsBox: 0,
    ease: 2.5,
    interval: 0,
    repetitions: 0,
    lastResult: 'new',
    lastReviewedAt: null,
    nextReviewAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
});

// ---------- Test harness ----------

describe('buildActiveDeck', () => {
    let storage;

    beforeEach(async () => {
        storage = new StorageService();
        await storage.init();
    });

    // ---- empty / trivial cases ----

    it('returns empty deck and empty gatedOut when the book has no cards', async () => {
        const out = await buildActiveDeck({ bookId: 'b1', storage, settings: SETTINGS, now: NOW });
        expect(out).toEqual({ deck: [], gatedOut: [] });
    });

    it('omits cards that are neither due nor new', async () => {
        await storage.saveFlashcard(makeCard({
            id: 'future', cognitiveLevel: 1, lastResult: 'pass', srsBox: 2,
            nextReviewAt: FUTURE
        }));
        const out = await buildActiveDeck({ bookId: 'b1', storage, settings: SETTINGS, now: NOW });
        expect(out.deck).toEqual([]);
        expect(out.gatedOut).toEqual([]);
    });

    // ---- prerequisite gate ----

    it('gates out an L2 card when its target node has no L1 card', async () => {
        await storage.saveFlashcard(makeCard({
            id: 'l2-orphan', cognitiveLevel: 2, targetNodeIds: ['n1'], lastResult: 'new'
        }));
        const out = await buildActiveDeck({ bookId: 'b1', storage, settings: SETTINGS, now: NOW });
        expect(out.deck).toEqual([]);
        expect(out.gatedOut.map((c) => c.id)).toEqual(['l2-orphan']);
    });

    it('gates out an L2 card when ALL L1 prereqs are at srsBox=0', async () => {
        await storage.saveFlashcard(makeCard({
            id: 'l1', cognitiveLevel: 1, targetNodeIds: ['n1'],
            srsBox: 0, lastResult: 'fail', nextReviewAt: PAST
        }));
        await storage.saveFlashcard(makeCard({
            id: 'l2', cognitiveLevel: 2, targetNodeIds: ['n1'], lastResult: 'new'
        }));
        const out = await buildActiveDeck({ bookId: 'b1', storage, settings: SETTINGS, now: NOW });
        expect(out.deck.map((c) => c.id)).toEqual(['l1']); // L1 still plays as P1
        expect(out.gatedOut.map((c) => c.id)).toEqual(['l2']);
    });

    it('passes an L2 card when ALL its target nodes have srsBox>=1', async () => {
        await storage.saveFlashcard(makeCard({
            id: 'l1a', cognitiveLevel: 1, targetNodeIds: ['n1'],
            srsBox: 1, lastResult: 'pass', nextReviewAt: FUTURE
        }));
        await storage.saveFlashcard(makeCard({
            id: 'l1b', cognitiveLevel: 1, targetNodeIds: ['n2'],
            srsBox: 2, lastResult: 'pass', nextReviewAt: FUTURE
        }));
        await storage.saveFlashcard(makeCard({
            id: 'l2', cognitiveLevel: 2, targetNodeIds: ['n1', 'n2'], lastResult: 'new'
        }));
        const out = await buildActiveDeck({ bookId: 'b1', storage, settings: SETTINGS, now: NOW });
        expect(out.deck.map((c) => c.id)).toEqual(['l2']);
        expect(out.gatedOut).toEqual([]);
    });

    it('gates out an L3 card if ANY single target node is unmastered', async () => {
        // Two prereqs mastered, one not.
        await storage.saveFlashcard(makeCard({
            id: 'l1a', cognitiveLevel: 1, targetNodeIds: ['n1'],
            srsBox: 2, lastResult: 'pass', nextReviewAt: FUTURE
        }));
        await storage.saveFlashcard(makeCard({
            id: 'l1b', cognitiveLevel: 1, targetNodeIds: ['n2'],
            srsBox: 2, lastResult: 'pass', nextReviewAt: FUTURE
        }));
        await storage.saveFlashcard(makeCard({
            id: 'l1c', cognitiveLevel: 1, targetNodeIds: ['n3'],
            srsBox: 0, lastResult: 'new', nextReviewAt: NOW
        }));
        await storage.saveFlashcard(makeCard({
            id: 'l3', cognitiveLevel: 3, targetNodeIds: ['n1', 'n2', 'n3'], lastResult: 'new'
        }));
        const out = await buildActiveDeck({ bookId: 'b1', storage, settings: SETTINGS, now: NOW });
        expect(out.gatedOut.map((c) => c.id)).toEqual(['l3']);
    });

    it('L1 cards are never gated (no prerequisites)', async () => {
        await storage.saveFlashcard(makeCard({
            id: 'l1', cognitiveLevel: 1, targetNodeIds: ['n1'], lastResult: 'new'
        }));
        const out = await buildActiveDeck({ bookId: 'b1', storage, settings: SETTINGS, now: NOW });
        expect(out.deck.map((c) => c.id)).toEqual(['l1']);
        expect(out.gatedOut).toEqual([]);
    });

    // ---- priority bucket ordering ----

    it('orders P1 (failed L1) before P2 (other due) before P3 (new)', async () => {
        await storage.saveFlashcard(makeCard({
            id: 'p3-new', cognitiveLevel: 1, targetNodeIds: ['n1'], lastResult: 'new'
        }));
        await storage.saveFlashcard(makeCard({
            id: 'p2-due', cognitiveLevel: 1, targetNodeIds: ['n2'],
            srsBox: 2, lastResult: 'pass', nextReviewAt: PAST
        }));
        await storage.saveFlashcard(makeCard({
            id: 'p1-fail', cognitiveLevel: 1, targetNodeIds: ['n3'],
            srsBox: 0, lastResult: 'fail', nextReviewAt: PAST
        }));
        const out = await buildActiveDeck({ bookId: 'b1', storage, settings: SETTINGS, now: NOW });
        expect(out.deck.map((c) => c.id)).toEqual(['p1-fail', 'p2-due', 'p3-new']);
    });

    it('a failed L2 card goes to P2, NOT P1 (only L1 failures are foundational)', async () => {
        await storage.saveFlashcard(makeCard({
            id: 'l1-prereq', cognitiveLevel: 1, targetNodeIds: ['n1'],
            srsBox: 2, lastResult: 'pass', nextReviewAt: FUTURE
        }));
        await storage.saveFlashcard(makeCard({
            id: 'failed-l2', cognitiveLevel: 2, targetNodeIds: ['n1'],
            srsBox: 0, lastResult: 'fail', nextReviewAt: PAST
        }));
        await storage.saveFlashcard(makeCard({
            id: 'failed-l1', cognitiveLevel: 1, targetNodeIds: ['n1'],
            srsBox: 0, lastResult: 'fail', nextReviewAt: PAST + 1000
        }));
        const out = await buildActiveDeck({ bookId: 'b1', storage, settings: SETTINGS, now: NOW });
        expect(out.deck.map((c) => c.id)).toEqual(['failed-l1', 'failed-l2']);
    });

    // ---- intra-bucket sort ----

    it('P1: oldest nextReviewAt first', async () => {
        await storage.saveFlashcard(makeCard({
            id: 'newer', cognitiveLevel: 1, srsBox: 0, lastResult: 'fail',
            nextReviewAt: PAST + 2000
        }));
        await storage.saveFlashcard(makeCard({
            id: 'older', cognitiveLevel: 1, srsBox: 0, lastResult: 'fail',
            nextReviewAt: PAST
        }));
        const out = await buildActiveDeck({ bookId: 'b1', storage, settings: SETTINGS, now: NOW });
        expect(out.deck.map((c) => c.id)).toEqual(['older', 'newer']);
    });

    it('P2: oldest due first, tie-break by cognitive level ascending', async () => {
        // Prereq so the L2 isn't gated.
        await storage.saveFlashcard(makeCard({
            id: 'prereq', cognitiveLevel: 1, targetNodeIds: ['n1'],
            srsBox: 2, lastResult: 'pass', nextReviewAt: FUTURE
        }));
        // Same timestamp; expect L1 before L2.
        await storage.saveFlashcard(makeCard({
            id: 'tied-l2', cognitiveLevel: 2, targetNodeIds: ['n1'],
            srsBox: 1, lastResult: 'pass', nextReviewAt: PAST
        }));
        await storage.saveFlashcard(makeCard({
            id: 'tied-l1', cognitiveLevel: 1, targetNodeIds: ['n2'],
            srsBox: 1, lastResult: 'pass', nextReviewAt: PAST
        }));
        // Newer timestamp.
        await storage.saveFlashcard(makeCard({
            id: 'newer-l1', cognitiveLevel: 1, targetNodeIds: ['n3'],
            srsBox: 1, lastResult: 'pass', nextReviewAt: PAST + 5000
        }));
        const out = await buildActiveDeck({ bookId: 'b1', storage, settings: SETTINGS, now: NOW });
        expect(out.deck.map((c) => c.id)).toEqual(['tied-l1', 'tied-l2', 'newer-l1']);
    });

    it('P3: centrality descending', async () => {
        // 3 nodes; edges give A degree 3, B degree 1, C degree 0.
        await storage.saveKGNode(makeNode('A'));
        await storage.saveKGNode(makeNode('B'));
        await storage.saveKGNode(makeNode('C'));
        await storage.saveKGEdge(makeEdge('e1', 'A', 'B'));
        await storage.saveKGEdge(makeEdge('e2', 'A', 'C'));
        await storage.saveKGEdge(makeEdge('e3', 'A', 'D'));

        await storage.saveFlashcard(makeCard({
            id: 'card-A', cognitiveLevel: 1, targetNodeIds: ['A'], lastResult: 'new'
        }));
        await storage.saveFlashcard(makeCard({
            id: 'card-B', cognitiveLevel: 1, targetNodeIds: ['B'], lastResult: 'new'
        }));
        await storage.saveFlashcard(makeCard({
            id: 'card-C', cognitiveLevel: 1, targetNodeIds: ['C'], lastResult: 'new'
        }));

        const out = await buildActiveDeck({ bookId: 'b1', storage, settings: SETTINGS, now: NOW });
        expect(out.deck.map((c) => c.id)).toEqual(['card-A', 'card-B', 'card-C']);
    });

    it('attaches __centrality to cards in the deck', async () => {
        await storage.saveKGNode(makeNode('A'));
        await storage.saveKGNode(makeNode('B'));
        await storage.saveKGEdge(makeEdge('e1', 'A', 'B'));
        await storage.saveFlashcard(makeCard({
            id: 'c', cognitiveLevel: 1, targetNodeIds: ['A'], lastResult: 'new'
        }));
        const out = await buildActiveDeck({ bookId: 'b1', storage, settings: SETTINGS, now: NOW });
        expect(out.deck[0].__centrality).toBeGreaterThanOrEqual(0);
        expect(typeof out.deck[0].__centrality).toBe('number');
    });

    it("a card's centrality is the mean of its target nodes' centralities", async () => {
        // A has degree 3, C has degree 0. Mean centrality of [A,C] < centrality of [A].
        await storage.saveKGNode(makeNode('A'));
        await storage.saveKGNode(makeNode('B'));
        await storage.saveKGNode(makeNode('C'));
        await storage.saveKGEdge(makeEdge('e1', 'A', 'B'));
        await storage.saveKGEdge(makeEdge('e2', 'A', 'X'));
        await storage.saveKGEdge(makeEdge('e3', 'A', 'Y'));

        await storage.saveFlashcard(makeCard({
            id: 'just-A', cognitiveLevel: 1, targetNodeIds: ['A'], lastResult: 'new'
        }));
        await storage.saveFlashcard(makeCard({
            id: 'A-and-C', cognitiveLevel: 1, targetNodeIds: ['A', 'C'], lastResult: 'new'
        }));
        const out = await buildActiveDeck({ bookId: 'b1', storage, settings: SETTINGS, now: NOW });
        const byId = Object.fromEntries(out.deck.map((c) => [c.id, c]));
        expect(byId['just-A'].__centrality).toBeGreaterThan(byId['A-and-C'].__centrality);
    });

    it('cards with missing target nodes get __centrality = 0 and are last in P3', async () => {
        await storage.saveKGNode(makeNode('A'));
        await storage.saveKGEdge(makeEdge('e1', 'A', 'X'));
        await storage.saveFlashcard(makeCard({
            id: 'has-A', cognitiveLevel: 1, targetNodeIds: ['A'], lastResult: 'new'
        }));
        await storage.saveFlashcard(makeCard({
            id: 'no-targets', cognitiveLevel: 1, targetNodeIds: [], lastResult: 'new'
        }));
        await storage.saveFlashcard(makeCard({
            id: 'missing-node', cognitiveLevel: 1, targetNodeIds: ['ghost'], lastResult: 'new'
        }));
        const out = await buildActiveDeck({ bookId: 'b1', storage, settings: SETTINGS, now: NOW });
        expect(out.deck[0].id).toBe('has-A');
        // The two zero-centrality cards come after; relative order is stable.
        const tail = out.deck.slice(1).map((c) => c.id);
        expect(tail).toEqual(expect.arrayContaining(['no-targets', 'missing-node']));
    });

    // ---- session caps ----

    it('caps P3 at srsMaxNewPerSession', async () => {
        for (let i = 0; i < 5; i++) {
            await storage.saveFlashcard(makeCard({
                id: `new-${i}`, cognitiveLevel: 1, lastResult: 'new'
            }));
        }
        const out = await buildActiveDeck({
            bookId: 'b1', storage,
            settings: { srsMaxNewPerSession: 2, srsMaxReviewsPerSession: 100 },
            now: NOW
        });
        expect(out.deck).toHaveLength(2);
    });

    it('caps P2 at srsMaxReviewsPerSession', async () => {
        for (let i = 0; i < 5; i++) {
            await storage.saveFlashcard(makeCard({
                id: `due-${i}`, cognitiveLevel: 1,
                srsBox: 2, lastResult: 'pass', nextReviewAt: PAST + i
            }));
        }
        const out = await buildActiveDeck({
            bookId: 'b1', storage,
            settings: { srsMaxNewPerSession: 100, srsMaxReviewsPerSession: 3 },
            now: NOW
        });
        expect(out.deck.map((c) => c.id)).toEqual(['due-0', 'due-1', 'due-2']);
    });

    it('P1 (failed L1) is uncapped even when maxReviews=0', async () => {
        for (let i = 0; i < 3; i++) {
            await storage.saveFlashcard(makeCard({
                id: `fail-${i}`, cognitiveLevel: 1,
                srsBox: 0, lastResult: 'fail', nextReviewAt: PAST + i
            }));
        }
        const out = await buildActiveDeck({
            bookId: 'b1', storage,
            settings: { srsMaxNewPerSession: 0, srsMaxReviewsPerSession: 0 },
            now: NOW
        });
        expect(out.deck.map((c) => c.id)).toEqual(['fail-0', 'fail-1', 'fail-2']);
    });

    it('treats missing session limits as unlimited', async () => {
        for (let i = 0; i < 5; i++) {
            await storage.saveFlashcard(makeCard({
                id: `new-${i}`, cognitiveLevel: 1, lastResult: 'new'
            }));
        }
        const out = await buildActiveDeck({ bookId: 'b1', storage, settings: {}, now: NOW });
        expect(out.deck).toHaveLength(5);
    });

    it('does not include cards from a different book', async () => {
        await storage.saveFlashcard(makeCard({ id: 'mine', bookId: 'b1', lastResult: 'new' }));
        await storage.saveFlashcard(makeCard({ id: 'theirs', bookId: 'b2', lastResult: 'new' }));
        const out = await buildActiveDeck({ bookId: 'b1', storage, settings: SETTINGS, now: NOW });
        expect(out.deck.map((c) => c.id)).toEqual(['mine']);
    });

    // ---- new cards are eligible regardless of nextReviewAt timestamp ----

    it('a new card is eligible even if nextReviewAt is in the future', async () => {
        await storage.saveFlashcard(makeCard({
            id: 'new-future', cognitiveLevel: 1, lastResult: 'new', nextReviewAt: FUTURE
        }));
        const out = await buildActiveDeck({ bookId: 'b1', storage, settings: SETTINGS, now: NOW });
        expect(out.deck.map((c) => c.id)).toEqual(['new-future']);
    });
});
