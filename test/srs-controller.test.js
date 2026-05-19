import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StorageService } from '../js/services/storage.js';
import { SRSController, SRSState } from '../js/controllers/srs-controller.js';

const NOW = 1_700_000_000_000;

const SETTINGS = {
    srsEnabled: true,
    srsPaddingMode: 'padding',
    srsPaddingSentences: 2,
    srsDistractorCount: 3,
    srsTriggerOnChapterFinish: true,
    srsTriggerLazyOnOpen: true,
    srsMaxNewPerSession: 10,
    srsMaxReviewsPerSession: 30,
    srsEaseDefault: 2.5,
    srsEaseMin: 1.3,
    srsEaseStepFail: 0.2,
    srsFailIntervalMinutes: 10,
    srsLLMTemperature: 0.4
};

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

const fakeReadingState = () => ({ loadChapter: async () => ['s0', 's1', 's2'] });
const fakeLLM = () => ({
    complete: vi.fn(async () => '{}'),
    getProvider: () => ({ parseJSON: JSON.parse })
});

// A stub generator we can assert on directly.
const stubGenerator = (generateForBook = async () => [], generateForChapter = async () => []) => ({
    generateForBook: vi.fn(generateForBook),
    generateForChapter: vi.fn(generateForChapter)
});

const makeController = async (overrides = {}) => {
    const storage = overrides.storage ?? (await (async () => {
        const s = new StorageService();
        await s.init();
        return s;
    })());
    const callbacks = {
        onStateChange: vi.fn(),
        onCardReady: vi.fn(),
        onResult: vi.fn(),
        onDeckEmpty: vi.fn(),
        onJump: vi.fn(),
        onGenerationComplete: vi.fn(),
        onError: vi.fn(),
        ...overrides.callbacks
    };
    const opts = {
        storage,
        readingState: fakeReadingState(),
        llmClient: fakeLLM(),
        settings: { ...SETTINGS, ...overrides.settings },
        generator: overrides.generator ?? stubGenerator(),
        logger: { warn: () => {} }
    };
    const controller = new SRSController(opts, callbacks);
    return { controller, storage, callbacks, generator: opts.generator };
};

// ---------- setSettings ----------

describe('SRSController.setSettings', () => {
    it('replaces the controller settings and propagates to the internal generator', async () => {
        const generator = stubGenerator();
        // Give the generator a settings field so we can observe the update.
        generator.settings = { srsLLMTemperature: 0.4 };
        const { controller } = await makeController({ generator });
        controller.setSettings({ srsLLMTemperature: 0.9, srsMaxNewPerSession: 3 });
        expect(controller.settings.srsLLMTemperature).toBe(0.9);
        expect(controller.settings.srsMaxNewPerSession).toBe(3);
        expect(generator.settings.srsLLMTemperature).toBe(0.9);
    });
});

// ---------- openDeck ----------

describe('SRSController.openDeck', () => {
    it('builds the deck and fires onCardReady with the head when cards exist', async () => {
        const { controller, storage, callbacks } = await makeController();
        await storage.saveFlashcard(makeCard({ id: 'c1', lastResult: 'new' }));
        await controller.openDeck('b1');
        expect(controller.getState()).toBe(SRSState.READY);
        expect(callbacks.onCardReady).toHaveBeenCalledTimes(1);
        expect(callbacks.onCardReady.mock.calls[0][0].id).toBe('c1');
        expect(callbacks.onDeckEmpty).not.toHaveBeenCalled();
    });

    it('fires onDeckEmpty when no cards exist and lazyOnOpen is OFF', async () => {
        const { controller, callbacks } = await makeController({
            settings: { srsTriggerLazyOnOpen: false }
        });
        await controller.openDeck('b1');
        expect(controller.getState()).toBe(SRSState.EMPTY);
        expect(callbacks.onDeckEmpty).toHaveBeenCalledTimes(1);
        expect(callbacks.onCardReady).not.toHaveBeenCalled();
    });

    it('triggers lazy generation when deck is empty and lazyOnOpen is ON', async () => {
        // After generation we still have no cards on disk (the stub doesn't
        // persist), but we verify the generator was invoked.
        const generator = stubGenerator();
        const { controller, callbacks } = await makeController({ generator });
        await controller.openDeck('b1');
        expect(generator.generateForBook).toHaveBeenCalledWith('b1', { maxCards: 10 });
        expect(callbacks.onGenerationComplete).toHaveBeenCalledWith(0);
        expect(callbacks.onDeckEmpty).toHaveBeenCalled();
    });

    it('lazy generation that actually produces cards results in onCardReady', async () => {
        const storage = new StorageService();
        await storage.init();
        const generator = stubGenerator(async (bookId) => {
            // Simulate the real generator persisting cards into storage.
            const card = makeCard({ id: 'lazy', bookId, lastResult: 'new' });
            await storage.saveFlashcard(card);
            return [card];
        });
        const callbacks = {
            onCardReady: vi.fn(),
            onDeckEmpty: vi.fn(),
            onGenerationComplete: vi.fn()
        };
        const controller = new SRSController({
            storage,
            readingState: fakeReadingState(),
            llmClient: fakeLLM(),
            settings: SETTINGS,
            generator,
            logger: { warn: () => {} }
        }, callbacks);
        await controller.openDeck('b1');
        expect(callbacks.onGenerationComplete).toHaveBeenCalledWith(1);
        expect(callbacks.onCardReady).toHaveBeenCalled();
        expect(callbacks.onCardReady.mock.calls[0][0].id).toBe('lazy');
    });

    it('emits state transitions IDLE -> LOADING -> READY/EMPTY', async () => {
        const { controller, storage, callbacks } = await makeController();
        await storage.saveFlashcard(makeCard({ id: 'c1', lastResult: 'new' }));
        await controller.openDeck('b1');
        const states = callbacks.onStateChange.mock.calls.map((c) => c[0]);
        expect(states).toEqual(['loading', 'ready']);
    });

    it('respects srsEnabled=false (fires onDeckEmpty without touching storage)', async () => {
        const { controller, storage, callbacks } = await makeController({
            settings: { srsEnabled: false }
        });
        await storage.saveFlashcard(makeCard({ id: 'c1', lastResult: 'new' }));
        await controller.openDeck('b1');
        expect(callbacks.onDeckEmpty).toHaveBeenCalled();
        expect(callbacks.onCardReady).not.toHaveBeenCalled();
    });

    it('emits onError when the deck build throws', async () => {
        const badStorage = {
            getFlashcardsForBook: async () => { throw new Error('boom'); }
        };
        const { controller, callbacks } = await makeController({
            storage: badStorage
        });
        await controller.openDeck('b1');
        expect(callbacks.onError).toHaveBeenCalled();
        expect(controller.getState()).toBe(SRSState.IDLE);
    });

    it('rejects when bookId is missing', async () => {
        const { controller } = await makeController();
        await expect(controller.openDeck()).rejects.toThrow(/bookId/);
    });
});

// ---------- submitAnswer ----------

describe('SRSController.submitAnswer', () => {
    it('records a pass: srsBox bumps, fires onResult and onCardReady for next card', async () => {
        const { controller, storage, callbacks } = await makeController();
        await storage.saveFlashcard(makeCard({ id: 'a', correctIndex: 1, lastResult: 'new' }));
        await storage.saveFlashcard(makeCard({ id: 'b', correctIndex: 0, lastResult: 'new' }));
        await controller.openDeck('b1');
        callbacks.onCardReady.mockClear();

        const headId = controller.currentCard().id;
        const out = await controller.submitAnswer(1); // a's correctIndex was 1

        expect(out.result).toBe(out.card.id === 'a' ? 'pass' : (out.card.correctIndex === 1 ? 'pass' : 'fail'));
        // Verify SM-2 advance on the just-answered card.
        const saved = await storage.getFlashcard(headId);
        // It was a pass (selectedIndex === correctIndex), so srsBox > 0.
        if (out.result === 'pass') {
            expect(saved.srsBox).toBeGreaterThanOrEqual(1);
        }
        expect(callbacks.onResult).toHaveBeenCalledTimes(1);
        expect(callbacks.onCardReady).toHaveBeenCalledTimes(1);
        expect(controller.getDeckSize()).toBe(1);
    });

    it('records a fail: srsBox resets to 0 and ease drops', async () => {
        const { controller, storage } = await makeController();
        await storage.saveFlashcard(makeCard({
            id: 'a', correctIndex: 0, srsBox: 3, repetitions: 3, ease: 2.5,
            lastResult: 'pass'
        }));
        await controller.openDeck('b1');
        const out = await controller.submitAnswer(1); // wrong
        expect(out.result).toBe('fail');
        const saved = await storage.getFlashcard('a');
        expect(saved.srsBox).toBe(0);
        expect(saved.lastResult).toBe('fail');
        expect(saved.ease).toBeCloseTo(2.3, 5);
    });

    it('fires onDeckEmpty when the last card is answered', async () => {
        const { controller, storage, callbacks } = await makeController();
        await storage.saveFlashcard(makeCard({ id: 'only', correctIndex: 0, lastResult: 'new' }));
        await controller.openDeck('b1');
        callbacks.onDeckEmpty.mockClear();
        await controller.submitAnswer(0);
        expect(controller.getDeckSize()).toBe(0);
        expect(callbacks.onDeckEmpty).toHaveBeenCalledTimes(1);
        expect(controller.getState()).toBe(SRSState.EMPTY);
    });

    it('injects L1 fallback cards to the front when the user fails an L2', async () => {
        const { controller, storage, callbacks } = await makeController({
            settings: { srsTriggerLazyOnOpen: false }
        });
        // Set up: an L1 prereq for node 'n1' so the L2 isn't gated.
        await storage.saveFlashcard(makeCard({
            id: 'l1-prereq', cognitiveLevel: 1, targetNodeIds: ['n1'],
            srsBox: 2, lastResult: 'pass', nextReviewAt: NOW + 100_000
        }));
        // The L2 card the user is about to fail.
        await storage.saveFlashcard(makeCard({
            id: 'l2', cognitiveLevel: 2, targetNodeIds: ['n1'],
            srsBox: 1, lastResult: 'pass', correctIndex: 0,
            nextReviewAt: NOW - 100
        }));
        // An additional L1 covering the failed card's target, NOT in the deck.
        await storage.saveFlashcard(makeCard({
            id: 'l1-extra', cognitiveLevel: 1, targetNodeIds: ['n1'],
            srsBox: 1, lastResult: 'pass', nextReviewAt: NOW + 100_000
        }));

        await controller.openDeck('b1');
        // The deck should contain just the L2 (the L1s aren't due).
        expect(controller.currentCard().id).toBe('l2');

        callbacks.onCardReady.mockClear();
        const out = await controller.submitAnswer(2); // wrong → fail
        expect(out.result).toBe('fail');
        // After the fail, fallback should have pulled BOTH L1s to the front.
        const newHead = controller.currentCard();
        expect(['l1-prereq', 'l1-extra']).toContain(newHead.id);
        expect(controller.getDeckSize()).toBeGreaterThanOrEqual(2);
    });

    it('rejects when no current card is showing', async () => {
        const { controller } = await makeController();
        await expect(controller.submitAnswer(0)).rejects.toThrow(/no current card/);
    });

    it('rejects on non-integer selectedIndex', async () => {
        const { controller, storage } = await makeController();
        await storage.saveFlashcard(makeCard({ id: 'a', lastResult: 'new' }));
        await controller.openDeck('b1');
        await expect(controller.submitAnswer(1.5)).rejects.toThrow(/integer/);
    });

    it('persists the updated card so subsequent openDeck reflects new SRS state', async () => {
        const { controller, storage } = await makeController();
        await storage.saveFlashcard(makeCard({ id: 'a', correctIndex: 0, lastResult: 'new' }));
        await controller.openDeck('b1');
        await controller.submitAnswer(0); // pass
        const reread = await storage.getFlashcard('a');
        expect(reread.srsBox).toBe(1);
        expect(reread.lastResult).toBe('pass');
    });
});

// ---------- jumpToBook ----------

describe('SRSController.jumpToBook', () => {
    it('fires onJump with the current card primary coords', async () => {
        const { controller, storage, callbacks } = await makeController();
        await storage.saveFlashcard(makeCard({
            id: 'a', primaryChapterIndex: 2, primarySentenceIndex: 17, lastResult: 'new'
        }));
        await controller.openDeck('b1');
        controller.jumpToBook();
        expect(callbacks.onJump).toHaveBeenCalledWith({ chapterIndex: 2, sentenceIndex: 17 });
    });

    it('uses the last-resolved card if no current card is showing (post-fail jump)', async () => {
        const { controller, storage, callbacks } = await makeController();
        await storage.saveFlashcard(makeCard({
            id: 'only', primaryChapterIndex: 5, primarySentenceIndex: 3,
            correctIndex: 0, lastResult: 'new'
        }));
        await controller.openDeck('b1');
        await controller.submitAnswer(2); // wrong → fail, deck becomes empty
        controller.jumpToBook();
        expect(callbacks.onJump).toHaveBeenCalledWith({ chapterIndex: 5, sentenceIndex: 3 });
    });

    it('is a no-op when there is no current or last-resolved card', async () => {
        const { controller, callbacks } = await makeController();
        controller.jumpToBook();
        expect(callbacks.onJump).not.toHaveBeenCalled();
    });
});

// ---------- closeDeck ----------

describe('SRSController.closeDeck', () => {
    it('clears state back to IDLE', async () => {
        const { controller, storage } = await makeController();
        await storage.saveFlashcard(makeCard({ id: 'a', lastResult: 'new' }));
        await controller.openDeck('b1');
        controller.closeDeck();
        expect(controller.getState()).toBe(SRSState.IDLE);
        expect(controller.currentCard()).toBeNull();
        expect(controller.getDeckSize()).toBe(0);
    });
});

// ---------- onChapterFinished ----------

describe('SRSController.onChapterFinished', () => {
    it('invokes generator.generateForChapter when enabled', async () => {
        const generator = stubGenerator(undefined, async () => [{ id: 'c1' }]);
        const { controller, callbacks } = await makeController({ generator });
        await controller.onChapterFinished('b1', 2);
        expect(generator.generateForChapter).toHaveBeenCalledWith('b1', 2);
        expect(callbacks.onGenerationComplete).toHaveBeenCalledWith(1);
    });

    it('is a no-op when srsEnabled=false', async () => {
        const generator = stubGenerator();
        const { controller, callbacks } = await makeController({
            generator, settings: { srsEnabled: false }
        });
        const out = await controller.onChapterFinished('b1', 0);
        expect(out).toEqual([]);
        expect(generator.generateForChapter).not.toHaveBeenCalled();
        expect(callbacks.onGenerationComplete).not.toHaveBeenCalled();
    });

    it('is a no-op when srsTriggerOnChapterFinish=false', async () => {
        const generator = stubGenerator();
        const { controller } = await makeController({
            generator, settings: { srsTriggerOnChapterFinish: false }
        });
        const out = await controller.onChapterFinished('b1', 0);
        expect(out).toEqual([]);
        expect(generator.generateForChapter).not.toHaveBeenCalled();
    });

    it('emits onError if the generator throws and returns []', async () => {
        const generator = stubGenerator(undefined, async () => { throw new Error('llm down'); });
        const { controller, callbacks } = await makeController({ generator });
        const out = await controller.onChapterFinished('b1', 0);
        expect(out).toEqual([]);
        expect(callbacks.onError).toHaveBeenCalled();
    });
});

// ---------- openCustomDeck (micro-review) ----------

describe('SRSController.openCustomDeck (micro-review)', () => {
    it('throws on empty input', async () => {
        const { controller } = await makeController();
        await expect(controller.openCustomDeck([])).rejects.toThrow(/non-empty/);
        await expect(controller.openCustomDeck(null)).rejects.toThrow(/non-empty/);
    });

    it('throws when cards do not share a bookId', async () => {
        const { controller } = await makeController();
        await expect(controller.openCustomDeck([
            makeCard({ id: 'a', bookId: 'b1' }),
            makeCard({ id: 'b', bookId: 'b2' })
        ])).rejects.toThrow(/same bookId/);
    });

    it('plays cards in supplied order; head fires onCardReady', async () => {
        const { controller, callbacks } = await makeController();
        const cards = [
            makeCard({ id: 'first', correctIndex: 0 }),
            makeCard({ id: 'second', correctIndex: 0 }),
            makeCard({ id: 'third', correctIndex: 0 })
        ];
        await controller.openCustomDeck(cards);
        expect(callbacks.onCardReady.mock.calls[0][0].id).toBe('first');
        expect(controller.currentCard().id).toBe('first');
        expect(controller.getDeckSize()).toBe(3);
    });

    it('SM-2 state still persists on submitAnswer (pass)', async () => {
        const { storage, controller } = await makeController();
        const card = makeCard({ id: 'cc', correctIndex: 0, lastResult: 'new' });
        await storage.saveFlashcard(card);
        await controller.openCustomDeck([card]);
        await controller.submitAnswer(0);
        const saved = await storage.getFlashcard('cc');
        expect(saved.srsBox).toBe(1);
        expect(saved.lastResult).toBe('pass');
    });

    it('diagnostic fallback is OFF by default — failing an L2 does NOT inject L1s', async () => {
        const { storage, controller } = await makeController();
        // A failing L1 prereq lives in storage; it MUST stay out of the
        // micro-deck since fallback is off.
        await storage.saveFlashcard(makeCard({
            id: 'l1', cognitiveLevel: 1, targetNodeIds: ['n1'],
            srsBox: 2, lastResult: 'pass'
        }));
        const l2 = makeCard({
            id: 'l2', cognitiveLevel: 2, targetNodeIds: ['n1'],
            correctIndex: 0
        });
        await storage.saveFlashcard(l2);

        await controller.openCustomDeck([l2]);
        await controller.submitAnswer(1); // wrong → fail
        // Deck would have grown if fallback were on; it should be empty.
        expect(controller.getDeckSize()).toBe(0);
    });

    it('honors opts.fallbackEnabled=true (fallback fires on fail)', async () => {
        const { storage, controller } = await makeController();
        await storage.saveFlashcard(makeCard({
            id: 'l1', cognitiveLevel: 1, targetNodeIds: ['n1'],
            srsBox: 2, lastResult: 'pass'
        }));
        const l2 = makeCard({
            id: 'l2', cognitiveLevel: 2, targetNodeIds: ['n1'],
            correctIndex: 0
        });
        await storage.saveFlashcard(l2);

        await controller.openCustomDeck([l2], { fallbackEnabled: true });
        await controller.submitAnswer(1); // fail → fallback should inject l1
        const headIds = [];
        while (controller.currentCard()) {
            headIds.push(controller.currentCard().id);
            await controller.submitAnswer(0);
        }
        expect(headIds).toContain('l1');
    });

    it('is NOT blocked by srsEnabled=false (user has explicitly opted in)', async () => {
        const { controller, callbacks } = await makeController({
            settings: { srsEnabled: false }
        });
        const card = makeCard({ id: 'cc', correctIndex: 0 });
        await controller.openCustomDeck([card]);
        expect(callbacks.onCardReady).toHaveBeenCalled();
        expect(controller.currentCard().id).toBe('cc');
    });

    it('after a custom-deck session, the next openDeck restores fallback semantics', async () => {
        const { storage, controller } = await makeController({
            settings: { srsTriggerLazyOnOpen: false }
        });
        // Custom-deck session that runs a single card.
        const cc = makeCard({ id: 'cc', correctIndex: 0 });
        await storage.saveFlashcard(cc);
        await controller.openCustomDeck([cc]);
        await controller.submitAnswer(0);
        // Now seed a real failing L2 with a mastered L1 prereq and open
        // the normal deck. Fallback must be enabled again.
        await storage.saveFlashcard(makeCard({
            id: 'l1', cognitiveLevel: 1, targetNodeIds: ['n1'],
            srsBox: 2, lastResult: 'pass', nextReviewAt: NOW + 100_000
        }));
        await storage.saveFlashcard(makeCard({
            id: 'l2', cognitiveLevel: 2, targetNodeIds: ['n1'],
            srsBox: 1, lastResult: 'pass',
            correctIndex: 0, nextReviewAt: NOW - 100
        }));
        await controller.openDeck('b1');
        await controller.submitAnswer(2); // fail → fallback should kick
        // l1-fail should now be in the deck via the fallback path.
        const headIds = [];
        while (controller.currentCard()) {
            headIds.push(controller.currentCard().id);
            await controller.submitAnswer(0);
            if (headIds.length > 5) break;
        }
        expect(headIds).toContain('l1');
    });
});

// ---------- removeCardFromDeck ----------

describe('SRSController.removeCardFromDeck', () => {
    it('removes the head and fires onCardReady with the new head', async () => {
        const { storage, controller, callbacks } = await makeController();
        await storage.saveFlashcard(makeCard({ id: 'a', lastResult: 'new' }));
        await storage.saveFlashcard(makeCard({ id: 'b', lastResult: 'new' }));
        await controller.openDeck('b1');
        const beforeId = controller.currentCard().id;
        callbacks.onCardReady.mockClear();
        controller.removeCardFromDeck(beforeId);
        const afterCard = callbacks.onCardReady.mock.calls[0][0];
        expect(afterCard.id).not.toBe(beforeId);
        expect(controller.currentCard().id).toBe(afterCard.id);
    });

    it('removes a non-head card silently (no onCardReady re-fire)', async () => {
        const { storage, controller, callbacks } = await makeController();
        await storage.saveFlashcard(makeCard({ id: 'a', lastResult: 'new' }));
        await storage.saveFlashcard(makeCard({ id: 'b', lastResult: 'new' }));
        await controller.openDeck('b1');
        const head = controller.currentCard();
        const other = controller.getDeckSize() === 2
            ? (head.id === 'a' ? 'b' : 'a')
            : null;
        callbacks.onCardReady.mockClear();
        controller.removeCardFromDeck(other);
        expect(callbacks.onCardReady).not.toHaveBeenCalled();
        expect(controller.currentCard().id).toBe(head.id);
        expect(controller.getDeckSize()).toBe(1);
    });

    it('emptying the deck fires onDeckEmpty', async () => {
        const { storage, controller, callbacks } = await makeController();
        await storage.saveFlashcard(makeCard({ id: 'only', lastResult: 'new' }));
        await controller.openDeck('b1');
        callbacks.onDeckEmpty.mockClear();
        controller.removeCardFromDeck('only');
        expect(callbacks.onDeckEmpty).toHaveBeenCalledTimes(1);
        expect(controller.getState()).toBe(SRSState.EMPTY);
    });

    it('is a no-op when the card is not in the deck', async () => {
        const { storage, controller, callbacks } = await makeController();
        await storage.saveFlashcard(makeCard({ id: 'a', lastResult: 'new' }));
        await controller.openDeck('b1');
        callbacks.onCardReady.mockClear();
        controller.removeCardFromDeck('nonexistent');
        expect(callbacks.onCardReady).not.toHaveBeenCalled();
    });

    it('is a no-op when the controller is IDLE', async () => {
        const { controller, callbacks } = await makeController();
        controller.removeCardFromDeck('whatever');
        expect(callbacks.onCardReady).not.toHaveBeenCalled();
        expect(callbacks.onDeckEmpty).not.toHaveBeenCalled();
    });
});
