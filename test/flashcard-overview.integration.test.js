/**
 * Integration test for the Flashcard Overview modal end-to-end —
 * exercises the real StorageService + the real FlashcardOverview
 * component + the GraphExplorer.invalidateFlashcardCache contract.
 *
 * Phase 6 of the overview / KG-highlighting feature.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StorageService } from '../js/services/storage.js';
import { FlashcardOverview } from '../js/ui/flashcard-overview.js';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

const seedBook = async (storage) => {
    const nodes = [
        { id: 'n1', bookId: 'b1', canonicalName: 'Arthur', aliases: [],
          type: 'PERSON', bloom: 'Remember', embedding: new Float32Array(1),
          contexts: [], firstSeenChapter: 0, srs: {}, createdAt: 0, updatedAt: 0 },
        { id: 'n2', bookId: 'b1', canonicalName: 'Excalibur', aliases: [],
          type: 'OBJECT', bloom: 'Remember', embedding: new Float32Array(1),
          contexts: [], firstSeenChapter: 0, srs: {}, createdAt: 0, updatedAt: 0 },
        { id: 'n3', bookId: 'b1', canonicalName: 'Merlin', aliases: [],
          type: 'PERSON', bloom: 'Remember', embedding: new Float32Array(1),
          contexts: [], firstSeenChapter: 0, srs: {}, createdAt: 0, updatedAt: 0 }
    ];
    for (const n of nodes) await storage.saveKGNode(n);

    await storage.saveKGEdge({
        id: 'e1', bookId: 'b1', sourceId: 'n1', targetId: 'n2',
        relation: 'wields', contexts: [], createdAt: 0
    });

    const cards = [
        // L1 failing card on Arthur
        { id: 'fc-failing-l1', bookId: 'b1', cognitiveLevel: 1,
          targetNodeIds: ['n1'], targetEdgeIds: [],
          question: 'Who is Arthur?', options: ['king', 'b', 'c', 'd'], correctIndex: 0,
          explanation: 'The legendary king.', primaryChapterIndex: 0,
          primarySentenceIndex: 1,
          srsBox: 0, ease: 2.5, interval: 0, repetitions: 0,
          lastResult: 'new', lastReviewedAt: null,
          nextReviewAt: NOW - 1000, createdAt: 100, updatedAt: 100 },
        // L1 mastered on Excalibur
        { id: 'fc-mastered-l1', bookId: 'b1', cognitiveLevel: 1,
          targetNodeIds: ['n2'], targetEdgeIds: [],
          question: 'What is Excalibur?', options: ['sword', 'b', 'c', 'd'], correctIndex: 0,
          explanation: 'Arthurian sword.', primaryChapterIndex: 0,
          primarySentenceIndex: 3,
          srsBox: 4, ease: 2.5, interval: 6, repetitions: 4,
          lastResult: 'pass', lastReviewedAt: NOW - DAY,
          nextReviewAt: NOW + 10 * DAY, createdAt: 50, updatedAt: 50 },
        // L2 learning on the edge
        { id: 'fc-learning-l2', bookId: 'b1', cognitiveLevel: 2,
          targetNodeIds: ['n1', 'n2'], targetEdgeIds: ['e1'],
          question: 'How are Arthur and Excalibur related?',
          options: ['wields', 'b', 'c', 'd'], correctIndex: 0,
          explanation: 'Arthur wields Excalibur.', primaryChapterIndex: 0,
          primarySentenceIndex: 2,
          srsBox: 2, ease: 2.5, interval: 3, repetitions: 2,
          lastResult: 'pass', lastReviewedAt: NOW - 2 * DAY,
          nextReviewAt: NOW + DAY, createdAt: 200, updatedAt: 200 },
        // L1 learning on Merlin
        { id: 'fc-learning-l1', bookId: 'b1', cognitiveLevel: 1,
          targetNodeIds: ['n3'], targetEdgeIds: [],
          question: 'Who is Merlin?', options: ['wizard', 'b', 'c', 'd'], correctIndex: 0,
          explanation: 'A wizard.', primaryChapterIndex: 0,
          primarySentenceIndex: 5,
          srsBox: 1, ease: 2.5, interval: 1, repetitions: 1,
          lastResult: 'pass', lastReviewedAt: NOW - 2 * DAY,
          nextReviewAt: NOW + 2 * DAY, createdAt: 150, updatedAt: 150 }
    ];
    for (const c of cards) await storage.saveFlashcard(c);
    return { nodes, cards };
};

const mountOverview = ({ confirmAction } = {}) => {
    document.body.innerHTML =
        '<div id="flashcard-overview" class="flashcard-overview-overlay hidden"></div>';
    const container = document.getElementById('flashcard-overview');
    const explorerStub = {
        invalidateFlashcardCache: vi.fn()
    };
    const callbacks = {
        onClose: vi.fn(),
        onJumpToPassage: vi.fn(),
        // Wire the host-side delete bridge the way app.js does in
        // _handleCardDeleted (storage delete + explorer cache invalidation
        // + refresh from storage).
        onCardDeleted: vi.fn(),
        onReviewSelection: vi.fn()
    };
    const overview = new FlashcardOverview({ container, confirmAction }, callbacks);
    return { overview, container, callbacks, explorerStub };
};

beforeEach(() => {
    document.body.innerHTML = '';
});

describe('Flashcard Overview — integration', () => {
    it('renders every seeded card with the correct band badge color class', async () => {
        const storage = new StorageService();
        await storage.init();
        await seedBook(storage);

        const cards = await storage.getFlashcardsForBook('b1');
        const nodes = await storage.getKGNodesForBook('b1');
        const nodesById = new Map(nodes.map((n) => [n.id, n]));

        const { overview, container } = mountOverview();
        overview.show({ cards, nodesById });

        const rows = container.querySelectorAll('.fc-row');
        expect(rows).toHaveLength(4);

        // Each box badge has an inline background-color via bandColor().
        for (const row of rows) {
            const badge = row.querySelector('.fc-box-badge');
            expect(badge.style.backgroundColor || badge.getAttribute('style'))
                .toMatch(/var\(--srs-band-/);
        }
    });

    it('search narrows the list against question + explanation + node names', async () => {
        const storage = new StorageService();
        await storage.init();
        await seedBook(storage);

        const cards = await storage.getFlashcardsForBook('b1');
        const nodes = await storage.getKGNodesForBook('b1');
        const nodesById = new Map(nodes.map((n) => [n.id, n]));

        const { overview, container } = mountOverview();
        overview.show({ cards, nodesById });

        const search = container.querySelector('#fc-search');
        search.value = 'Merlin';
        search.dispatchEvent(new Event('input'));

        const rows = container.querySelectorAll('.fc-row');
        expect(rows).toHaveLength(1);
        expect(rows[0].dataset.fcId).toBe('fc-learning-l1');
    });

    it("'Due asc' sort orders rows by nextReviewAt ascending", async () => {
        const storage = new StorageService();
        await storage.init();
        await seedBook(storage);

        const cards = await storage.getFlashcardsForBook('b1');
        const nodes = await storage.getKGNodesForBook('b1');
        const nodesById = new Map(nodes.map((n) => [n.id, n]));

        const { overview, container } = mountOverview();
        overview.show({ cards, nodesById });

        const sortSel = container.querySelector('#fc-sort');
        sortSel.value = 'due-asc';
        sortSel.dispatchEvent(new Event('change'));

        const ids = Array.from(container.querySelectorAll('.fc-row'))
            .map((r) => r.dataset.fcId);
        // fc-failing-l1 is overdue (past); then learning-l2 (+1d); then
        // learning-l1 (+2d); then mastered-l1 (+10d).
        expect(ids).toEqual([
            'fc-failing-l1',
            'fc-learning-l2',
            'fc-learning-l1',
            'fc-mastered-l1'
        ]);
    });

    it('delete persists to storage AND invalidates the graph-explorer flashcard cache', async () => {
        const storage = new StorageService();
        await storage.init();
        await seedBook(storage);

        const nodes = await storage.getKGNodesForBook('b1');
        const nodesById = new Map(nodes.map((n) => [n.id, n]));

        const confirmAction = vi.fn(async () => true);
        const { overview, container, callbacks, explorerStub } = mountOverview({ confirmAction });

        // Simulate the same host-side wiring as app.js's _handleCardDeleted.
        callbacks.onCardDeleted.mockImplementation(async (card) => {
            await storage.deleteFlashcard(card.id);
            explorerStub.invalidateFlashcardCache();
            // Re-fetch from storage and refresh the overview (the path
            // in app.js's _refreshFlashcardOverview).
            const fresh = await storage.getFlashcardsForBook('b1');
            overview.refresh({ cards: fresh, nodesById });
        });

        const initialCards = await storage.getFlashcardsForBook('b1');
        overview.show({ cards: initialCards, nodesById });
        expect(container.querySelectorAll('.fc-row')).toHaveLength(4);

        // Expand the row we want to delete + click Delete. The list
        // is fully re-rendered on expand, so re-query for the new node.
        container.querySelector('[data-fc-id="fc-failing-l1"] .fc-row-summary').click();
        container.querySelector('[data-fc-id="fc-failing-l1"] .fc-delete-btn').click();
        // Wait for confirmAction + storage delete + refresh().
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));

        // Storage now reflects the delete.
        const after = await storage.getFlashcardsForBook('b1');
        expect(after).toHaveLength(3);
        expect(after.find((c) => c.id === 'fc-failing-l1')).toBeUndefined();

        // Explorer cache was invalidated (gotcha #2).
        expect(explorerStub.invalidateFlashcardCache).toHaveBeenCalledTimes(1);

        // The overview is now authoritative.
        expect(container.querySelectorAll('.fc-row')).toHaveLength(3);
        expect(container.querySelector('[data-fc-id="fc-failing-l1"]')).toBeNull();
    });

    it("'Review Selection' fires onReviewSelection with the currently visible subset", async () => {
        const storage = new StorageService();
        await storage.init();
        await seedBook(storage);

        const cards = await storage.getFlashcardsForBook('b1');
        const nodes = await storage.getKGNodesForBook('b1');
        const nodesById = new Map(nodes.map((n) => [n.id, n]));

        const { overview, container, callbacks } = mountOverview();
        overview.show({ cards, nodesById });

        // Narrow to one card via search.
        const search = container.querySelector('#fc-search');
        search.value = 'Merlin';
        search.dispatchEvent(new Event('input'));

        container.querySelector('#fc-review-btn').click();

        const cardsFired = callbacks.onReviewSelection.mock.calls[0][0];
        expect(cardsFired.map((c) => c.id)).toEqual(['fc-learning-l1']);
    });

    it('clicking Jump fires onJumpToPassage with the card primary coords', async () => {
        const storage = new StorageService();
        await storage.init();
        await seedBook(storage);

        const cards = await storage.getFlashcardsForBook('b1');
        const nodes = await storage.getKGNodesForBook('b1');
        const nodesById = new Map(nodes.map((n) => [n.id, n]));

        const { overview, container, callbacks } = mountOverview();
        overview.show({ cards, nodesById });

        container.querySelector('[data-fc-id="fc-learning-l2"] .fc-row-summary').click(); // expand
        container.querySelector('[data-fc-id="fc-learning-l2"] .fc-jump-btn').click();

        expect(callbacks.onJumpToPassage).toHaveBeenCalledWith({
            chapterIndex: 0,
            sentenceIndex: 2,
            card: expect.objectContaining({ id: 'fc-learning-l2' })
        });
    });
});
