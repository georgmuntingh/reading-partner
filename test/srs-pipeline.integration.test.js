/**
 * SRS Pipeline — end-to-end integration tests
 *
 * Drives the real SRSController against fake-indexeddb storage and a
 * mocked LLM client, asserting behaviours that span multiple modules:
 *
 *   - Generator (Phase 8) -> Scheduler (Phase 6) -> Evaluator (Phase 5)
 *   - Prerequisite gate transitions under realistic state changes
 *   - Diagnostic fallback (Phase 7) ordering on L3 fail
 *   - Grounded text retrieval (Phase 3) — the prompt actually carries
 *     the expected windowed sentences
 *   - Chapter-finish trigger -> generator -> deck
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StorageService } from '../js/services/storage.js';
import { SRSController } from '../js/controllers/srs-controller.js';
import { SRSGenerator } from '../js/services/srs-generator.js';

const NOW = 1_700_000_000_000;

const SETTINGS = {
    srsEnabled: true,
    srsPaddingMode: 'padding',
    srsPaddingSentences: 2,
    srsDistractorCount: 3,
    srsTriggerOnChapterFinish: true,
    srsTriggerLazyOnOpen: true,
    srsMaxNewPerSession: 50,
    srsMaxReviewsPerSession: 50,
    srsEaseDefault: 2.5,
    srsEaseMin: 1.3,
    srsEaseStepFail: 0.2,
    srsFailIntervalMinutes: 10,
    srsLLMTemperature: 0.4
};

// ----- Fixtures: a small but realistic book graph -----
const CH0 = Array.from({ length: 8 }, (_, i) => `c0s${i}`);
const CH2 = Array.from({ length: 24 }, (_, i) => `c2s${i}`);

const makeNode = (id, overrides = {}) => ({
    id,
    bookId: 'b1',
    canonicalName: id,
    aliases: [],
    type: 'PERSON',
    bloom: 'Remember',
    definition: `${id} is described in the book.`,
    embedding: new Float32Array(1),
    contexts: [{ chapterIndex: 0, sentenceIndices: [3] }],
    firstSeenChapter: 0,
    relevanceScore: null,
    srs: {},
    createdAt: 0,
    updatedAt: 0,
    ...overrides
});

const makeEdge = (id, sourceId, targetId, overrides = {}) => ({
    id, bookId: 'b1', sourceId, targetId, relation: 'relates to',
    contexts: [{ chapterIndex: 0, sentenceIndices: [3] }], createdAt: 0,
    ...overrides
});

const makeCard = (overrides = {}) => ({
    id: `fc_${Math.random().toString(36).slice(2, 9)}`,
    bookId: 'b1',
    cognitiveLevel: 1,
    targetNodeIds: [],
    targetEdgeIds: [],
    question: 'q?', options: ['a', 'b', 'c', 'd'], correctIndex: 0,
    explanation: 'e', primaryChapterIndex: 0, primarySentenceIndex: 0,
    srsBox: 0, ease: 2.5, interval: 0, repetitions: 0,
    lastResult: 'new', lastReviewedAt: null,
    nextReviewAt: NOW - 1000, createdAt: 0, updatedAt: 0,
    ...overrides
});

// A reading-state stub with chapters at indices 0 and 2.
const fakeReadingState = () => ({
    loadChapter: vi.fn(async (idx) => ({ 0: CH0, 2: CH2 })[idx] ?? null)
});

// A deterministic LLM that records every call and returns the same valid payload.
const fakeLLM = (response) => {
    const complete = vi.fn(async () => JSON.stringify(response));
    return {
        complete,
        getProvider: () => ({ parseJSON: (txt) => JSON.parse(String(txt).trim()) }),
        _complete: complete
    };
};

const validPayload = {
    question: 'What does the passage describe?',
    options: ['Arthur', 'Bedivere', 'Merlin', 'Mordred'],
    correctIndex: 0,
    explanation: 'The passage names Arthur explicitly.'
};

const setup = async ({ llm, generator } = {}) => {
    const storage = new StorageService();
    await storage.init();
    const llmClient = llm ?? fakeLLM(validPayload);
    const readingState = fakeReadingState();

    const events = {
        stateChanges: [],
        cardsReady: [],
        results: [],
        deckEmpty: 0,
        jumps: [],
        generated: [],
        errors: []
    };

    const controller = new SRSController({
        storage,
        readingState,
        llmClient,
        settings: SETTINGS,
        generator,
        logger: { warn: () => {} }
    }, {
        onStateChange: (s) => events.stateChanges.push(s),
        onCardReady: (c) => events.cardsReady.push(c),
        onResult: (r) => events.results.push(r),
        onDeckEmpty: () => events.deckEmpty++,
        onJump: (p) => events.jumps.push(p),
        onGenerationComplete: (n) => events.generated.push(n),
        onError: (e) => events.errors.push(e)
    });

    return { storage, llmClient, readingState, controller, events };
};

// ----- Tests -----

describe('SRS pipeline — generator → scheduler → evaluator (happy path)', () => {
    it('lazy generation produces cards and opens the deck with the highest-centrality card first', async () => {
        const { storage, controller, events } = await setup();
        // 3 nodes: A is the hub (degree 3), B has degree 1, C has degree 0.
        await storage.saveKGNode(makeNode('A'));
        await storage.saveKGNode(makeNode('B'));
        await storage.saveKGNode(makeNode('C'));
        await storage.saveKGEdge(makeEdge('e1', 'A', 'B'));
        await storage.saveKGEdge(makeEdge('e2', 'A', 'X'));
        await storage.saveKGEdge(makeEdge('e3', 'A', 'Y'));

        await controller.openDeck('b1');

        // Generator should have persisted L1 cards for A, B, C.
        const persisted = await storage.getFlashcardsForBook('b1');
        expect(persisted.length).toBeGreaterThanOrEqual(3);

        // First card shown should be the highest-centrality one (A).
        expect(events.cardsReady[0].targetNodeIds).toEqual(['A']);
        expect(events.generated[0]).toBeGreaterThanOrEqual(3);
    });
});

describe('SRS pipeline — SM-2 progression through the controller', () => {
    it('passing a new card 3 times yields repetitions=3, srsBox=3, interval≈6×ease', async () => {
        const { storage, controller } = await setup();
        await storage.saveFlashcard(makeCard({ id: 'c1', correctIndex: 0, lastResult: 'new' }));
        await controller.openDeck('b1');

        // Pass three times. After each pass the controller saves the
        // updated card; on the third openDeck the same card returns
        // (since it's due — we control time via Date.now stubbing? Not
        // necessary, the controller re-fetches on each openDeck but the
        // card is gone from the deck after the first pass since
        // nextReviewAt is in the future.)
        // Pass 1 inside this session, then re-open after fast-forwarding.
        await controller.submitAnswer(0);
        let saved = await storage.getFlashcard('c1');
        expect(saved.repetitions).toBe(1);
        expect(saved.srsBox).toBe(1);
        expect(saved.interval).toBe(1);
        expect(saved.lastResult).toBe('pass');

        // Simulate fast-forward by manually rewinding nextReviewAt.
        await storage.saveFlashcard({ ...saved, nextReviewAt: 0 });
        await controller.openDeck('b1');
        await controller.submitAnswer(0);
        saved = await storage.getFlashcard('c1');
        expect(saved.repetitions).toBe(2);
        expect(saved.srsBox).toBe(2);
        expect(saved.interval).toBe(6);

        await storage.saveFlashcard({ ...saved, nextReviewAt: 0 });
        await controller.openDeck('b1');
        await controller.submitAnswer(0);
        saved = await storage.getFlashcard('c1');
        expect(saved.repetitions).toBe(3);
        expect(saved.srsBox).toBe(3);
        // interval = round(6 * 2.5) = 15
        expect(saved.interval).toBe(15);
    });

    it('failing a passed card resets srsBox to 0, lastResult to fail, ease drops', async () => {
        const { storage, controller } = await setup();
        await storage.saveFlashcard(makeCard({
            id: 'c1', correctIndex: 0,
            srsBox: 3, repetitions: 3, interval: 15, ease: 2.5,
            lastResult: 'pass', nextReviewAt: NOW - 1000
        }));
        await controller.openDeck('b1');
        await controller.submitAnswer(2); // wrong → fail
        const saved = await storage.getFlashcard('c1');
        expect(saved.srsBox).toBe(0);
        expect(saved.repetitions).toBe(0);
        expect(saved.lastResult).toBe('fail');
        expect(saved.ease).toBeCloseTo(2.3, 5);
    });
});

describe('SRS pipeline — prerequisite gate transitions', () => {
    it('an L2 card is gated out until its L1 prereq is mastered, then becomes available', async () => {
        const { storage, controller } = await setup();
        // L1 for node n1 (new, srsBox=0); L2 covering n1.
        await storage.saveFlashcard(makeCard({
            id: 'l1', cognitiveLevel: 1, targetNodeIds: ['n1'],
            correctIndex: 0, lastResult: 'new'
        }));
        await storage.saveFlashcard(makeCard({
            id: 'l2', cognitiveLevel: 2, targetNodeIds: ['n1'],
            correctIndex: 0, lastResult: 'new'
        }));

        // Pass 1: open the deck — L2 is gated (its L1 prereq is still
        // srsBox=0, lastResult='new').
        await controller.openDeck('b1');
        const idsBeforePass = [];
        let head = controller.currentCard();
        while (head) {
            idsBeforePass.push(head.id);
            await controller.submitAnswer(2); // wrong on purpose so deck doesn't change
            // Re-open with the L1 still failing — gate should still hold.
            // Break after the first observation; we just want the initial deck.
            break;
        }
        expect(idsBeforePass).toEqual(['l1']);

        // Reset and master the L1 properly.
        await storage.saveFlashcard(makeCard({
            id: 'l1', cognitiveLevel: 1, targetNodeIds: ['n1'],
            correctIndex: 0, srsBox: 1, repetitions: 1,
            lastResult: 'pass', nextReviewAt: NOW - 1000
        }));
        await storage.saveFlashcard(makeCard({
            id: 'l2', cognitiveLevel: 2, targetNodeIds: ['n1'],
            correctIndex: 0, lastResult: 'new'
        }));

        // Pass 2: open the deck — L2 should now be eligible.
        await controller.openDeck('b1');
        const idsAfterMastery = [];
        head = controller.currentCard();
        while (head) {
            idsAfterMastery.push(head.id);
            // Pass each card just to walk through; both should appear.
            await controller.submitAnswer(0);
            head = controller.currentCard();
            if (idsAfterMastery.length > 5) break; // safety
        }
        expect(idsAfterMastery).toContain('l2');
    });
});

describe('SRS pipeline — diagnostic fallback ordering on L3 fail', () => {
    it('failing an L3 card pushes its three L1 prereqs to the front in centrality order', async () => {
        const { storage, controller, events } = await setup();
        // Graph: A degree 3 (hub), B degree 1, C degree 0.
        await storage.saveKGNode(makeNode('A'));
        await storage.saveKGNode(makeNode('B'));
        await storage.saveKGNode(makeNode('C'));
        await storage.saveKGEdge(makeEdge('e1', 'A', 'X'));
        await storage.saveKGEdge(makeEdge('e2', 'A', 'Y'));
        await storage.saveKGEdge(makeEdge('e3', 'A', 'B'));

        // L1 cards for each, all mastered so the L3 isn't gated.
        // Make them NOT due so they don't show up in the deck on their own.
        for (const id of ['A', 'B', 'C']) {
            await storage.saveFlashcard(makeCard({
                id: `l1-${id}`, cognitiveLevel: 1, targetNodeIds: [id],
                correctIndex: 0, srsBox: 2, repetitions: 2,
                lastResult: 'pass', nextReviewAt: NOW + 86_400_000
            }));
        }
        // The L3 that the user will fail.
        await storage.saveFlashcard(makeCard({
            id: 'l3', cognitiveLevel: 3, targetNodeIds: ['A', 'B', 'C'],
            correctIndex: 0, lastResult: 'pass', srsBox: 1,
            nextReviewAt: NOW - 1000
        }));

        await controller.openDeck('b1');
        // The deck should hold just l3 (the L1s aren't due).
        expect(controller.currentCard().id).toBe('l3');

        // Fail it.
        events.cardsReady.length = 0;
        await controller.submitAnswer(2);

        // After the fallback runs, deck head should be one of the three L1s,
        // and they should be ordered A, B, C by centrality (A hub > B > C).
        const remainingHeads = [];
        while (controller.currentCard()) {
            remainingHeads.push(controller.currentCard().id);
            // Pass each to walk through.
            await controller.submitAnswer(0);
        }
        expect(remainingHeads.slice(0, 3)).toEqual(['l1-A', 'l1-B', 'l1-C']);
    });
});

describe('SRS pipeline — grounded text retrieval reaches the LLM prompt', () => {
    it('a node with contexts={ch2,[5,17]} and padding=2 ships windows [3..7,15..19] tagged with [ch2 sN-M]', async () => {
        const llm = fakeLLM(validPayload);
        const { storage, controller } = await setup({ llm });
        // Node mentioned at sentence 5 AND sentence 17 of chapter 2.
        // CH2 has 24 sentences so windows clamp inside bounds.
        await storage.saveKGNode(makeNode('Topic', {
            firstSeenChapter: 2,
            contexts: [{ chapterIndex: 2, sentenceIndices: [5, 17] }]
        }));

        await controller.openDeck('b1');

        // LLM should have been invoked at least once.
        expect(llm._complete).toHaveBeenCalled();
        const prompt = llm._complete.mock.calls[0][0].prompt;

        // Two non-overlapping windows, each tagged [ch2 sStart-End].
        expect(prompt).toContain('[ch2 s3-7]');
        expect(prompt).toContain('[ch2 s15-19]');
        // Sentences should be carried through verbatim from the chapter.
        expect(prompt).toContain('c2s3');
        expect(prompt).toContain('c2s7');
        expect(prompt).toContain('c2s15');
        expect(prompt).toContain('c2s19');
    });

    it('overlapping context windows in the same chapter are merged before being sent', async () => {
        const llm = fakeLLM(validPayload);
        const { storage, controller } = await setup({ llm });
        // Sentences 3 and 5 with padding=2 → spans [1..5] and [3..7] → merge to [1..7].
        await storage.saveKGNode(makeNode('Topic', {
            contexts: [{ chapterIndex: 0, sentenceIndices: [3, 5] }]
        }));
        await controller.openDeck('b1');
        const prompt = llm._complete.mock.calls[0][0].prompt;
        expect(prompt).toContain('[ch0 s1-7]');
        // No separate [ch0 s3-5] or [ch0 s3-7] tags should appear.
        expect(prompt).not.toMatch(/\[ch0 s3-7\]/);
    });
});

describe('SRS pipeline — chapter-finish trigger', () => {
    it('onChapterFinished generates L1 cards for new nodes in that chapter and persists them', async () => {
        const { storage, controller, events } = await setup();
        // Two nodes, one in chapter 0, one in chapter 2.
        await storage.saveKGNode(makeNode('first', { firstSeenChapter: 0 }));
        await storage.saveKGNode(makeNode('later', { firstSeenChapter: 2 }));

        const cards = await controller.onChapterFinished('b1', 0);
        expect(cards.length).toBeGreaterThanOrEqual(1);
        expect(cards.every((c) => c.targetNodeIds.includes('first'))).toBe(true);

        // 'later' shouldn't be in the chapter-0 batch.
        const persisted = await storage.getFlashcardsForBook('b1');
        const coveredNodes = new Set(persisted.flatMap((c) => c.targetNodeIds));
        expect(coveredNodes.has('first')).toBe(true);
        expect(coveredNodes.has('later')).toBe(false);

        expect(events.generated[events.generated.length - 1]).toBe(cards.length);
    });

    it('a card persisted by the chapter-finish trigger shows up in the next openDeck', async () => {
        const { storage, controller, events } = await setup();
        await storage.saveKGNode(makeNode('A', { firstSeenChapter: 0 }));

        await controller.onChapterFinished('b1', 0);
        events.cardsReady.length = 0;

        await controller.openDeck('b1');
        expect(events.cardsReady.length).toBeGreaterThanOrEqual(1);
        expect(events.cardsReady[0].targetNodeIds).toEqual(['A']);
    });

    it('is a no-op when srsEnabled is false (no LLM calls, no cards)', async () => {
        const llm = fakeLLM(validPayload);
        const generator = new SRSGenerator({
            storage: null, readingState: fakeReadingState(), llmClient: llm, settings: SETTINGS
        });
        // We need a real storage for the controller, but the generator
        // should never be invoked.
        const storage = new StorageService();
        await storage.init();
        generator.storage = storage;
        await storage.saveKGNode(makeNode('A'));

        const controller = new SRSController({
            storage,
            readingState: fakeReadingState(),
            llmClient: llm,
            settings: { ...SETTINGS, srsEnabled: false },
            generator,
            logger: { warn: () => {} }
        }, {});

        const cards = await controller.onChapterFinished('b1', 0);
        expect(cards).toEqual([]);
        expect(llm._complete).not.toHaveBeenCalled();
        expect(await storage.getFlashcardsForBook('b1')).toEqual([]);
    });
});

describe('SRS pipeline — empty + manual top-up flow', () => {
    it('opening an empty book with lazyOnOpen=false yields onDeckEmpty without LLM calls', async () => {
        const llm = fakeLLM(validPayload);
        const { storage: _s, controller, events } = await setup({ llm });
        // No nodes. Disable lazy.
        controller.setSettings({ ...SETTINGS, srsTriggerLazyOnOpen: false });
        await controller.openDeck('b1');
        expect(events.deckEmpty).toBe(1);
        expect(events.cardsReady.length).toBe(0);
        expect(llm._complete).not.toHaveBeenCalled();
    });
});

describe('SRS pipeline — jump-to-passage', () => {
    it('after failing a card, jumpToBook emits primary (chapterIndex, sentenceIndex)', async () => {
        const { storage, controller, events } = await setup();
        await storage.saveFlashcard(makeCard({
            id: 'c1', correctIndex: 0,
            primaryChapterIndex: 4, primarySentenceIndex: 12,
            lastResult: 'new'
        }));
        await controller.openDeck('b1');
        await controller.submitAnswer(1); // wrong → fail
        controller.jumpToBook();
        expect(events.jumps).toEqual([{ chapterIndex: 4, sentenceIndex: 12 }]);
    });
});
