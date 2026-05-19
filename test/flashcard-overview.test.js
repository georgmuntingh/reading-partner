import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FlashcardOverview } from '../js/ui/flashcard-overview.js';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

const makeCard = (overrides = {}) => ({
    id: `fc_${Math.random().toString(36).slice(2, 9)}`,
    bookId: 'b1',
    cognitiveLevel: 1,
    targetNodeIds: [],
    targetEdgeIds: [],
    question: 'Who drew the sword?',
    options: ['Arthur', 'Mordred', 'Merlin', 'Lancelot'],
    correctIndex: 0,
    explanation: 'The passage names Arthur.',
    primaryChapterIndex: 0,
    primarySentenceIndex: 0,
    srsBox: 0,
    nextReviewAt: NOW - 1000,
    ...overrides
});

const mount = (overrides = {}) => {
    document.body.innerHTML = '<div id="flashcard-overview" class="flashcard-overview-overlay hidden"></div>';
    const container = document.getElementById('flashcard-overview');
    const confirmAction = overrides.confirmAction ?? vi.fn(async () => true);
    const callbacks = {
        onClose: vi.fn(),
        onJumpToPassage: vi.fn(),
        onCardDeleted: vi.fn(),
        onReviewSelection: vi.fn(),
        ...overrides.callbacks
    };
    const overview = new FlashcardOverview({ container, confirmAction }, callbacks);
    return { overview, container, callbacks, confirmAction };
};

beforeEach(() => { document.body.innerHTML = ''; });

// ---------- Defaults / empty state ----------

describe('FlashcardOverview — defaults & empty state', () => {
    it('renders an empty-state message when no cards are supplied', () => {
        const { overview, container } = mount();
        overview.show({ cards: [], nodesById: new Map() });
        expect(container.querySelector('.fc-empty').textContent).toMatch(/No flashcards yet/);
        expect(container.querySelector('#fc-review-btn').disabled).toBe(true);
    });

    it('renders one row per supplied card', () => {
        const { overview, container } = mount();
        overview.show({
            cards: [makeCard({ id: 'a' }), makeCard({ id: 'b' }), makeCard({ id: 'c' })],
            nodesById: new Map()
        });
        expect(container.querySelectorAll('.fc-row').length).toBe(3);
    });

    it('shows level chip + box badge + question for each row', () => {
        const { overview, container } = mount();
        overview.show({
            cards: [makeCard({ id: 'a', cognitiveLevel: 2, srsBox: 3, question: 'Q?' })],
            nodesById: new Map()
        });
        const row = container.querySelector('.fc-row');
        expect(row.querySelector('.srs-level-chip').textContent).toBe('L2');
        expect(row.querySelector('.fc-box-badge').textContent).toMatch(/Box 3/);
        expect(row.querySelector('.fc-question').textContent).toBe('Q?');
    });

    it('shows linked node names from nodesById', () => {
        const { overview, container } = mount();
        const nodes = new Map([
            ['n1', { id: 'n1', canonicalName: 'Arthur' }],
            ['n2', { id: 'n2', canonicalName: 'Excalibur' }]
        ]);
        overview.show({
            cards: [makeCard({ id: 'a', targetNodeIds: ['n1', 'n2'] })],
            nodesById: nodes
        });
        expect(container.querySelector('.fc-nodes').textContent).toBe('Arthur, Excalibur');
    });
});

// ---------- show / hide ----------

describe('FlashcardOverview — show/hide', () => {
    it('show() makes the overlay visible', () => {
        const { overview, container } = mount();
        overview.show({ cards: [makeCard()], nodesById: new Map() });
        expect(container.classList.contains('active')).toBe(true);
        expect(container.classList.contains('hidden')).toBe(false);
    });

    it('hide() removes active and clears expansion state', () => {
        const { overview, container } = mount();
        overview.show({ cards: [makeCard({ id: 'a' })], nodesById: new Map() });
        container.querySelector('.fc-row-summary').click();
        expect(overview.getState().expandedIds).toEqual(['a']);
        overview.hide();
        expect(container.classList.contains('active')).toBe(false);
        expect(overview.getState().expandedIds).toEqual([]);
    });

    it('close button fires onClose and hides', () => {
        const { overview, container, callbacks } = mount();
        overview.show({ cards: [makeCard()], nodesById: new Map() });
        container.querySelector('#fc-close-btn').click();
        expect(callbacks.onClose).toHaveBeenCalled();
        expect(container.classList.contains('active')).toBe(false);
    });
});

// ---------- search ----------

describe('FlashcardOverview — search', () => {
    it('filters by question text', () => {
        const { overview, container } = mount();
        overview.show({
            cards: [
                makeCard({ id: 'a', question: 'Who is Beowulf?', explanation: 'old English epic' }),
                makeCard({ id: 'b', question: 'What is Excalibur?', explanation: 'a sword in stone' })
            ],
            nodesById: new Map()
        });
        const search = container.querySelector('#fc-search');
        search.value = 'Beowulf';
        search.dispatchEvent(new Event('input'));
        expect(container.querySelectorAll('.fc-row').length).toBe(1);
        expect(container.querySelector('.fc-row').dataset.fcId).toBe('a');
    });

    it('filters by linked node name', () => {
        const { overview, container } = mount();
        const nodes = new Map([['n1', { id: 'n1', canonicalName: 'Mordred' }]]);
        overview.show({
            cards: [
                makeCard({ id: 'a', question: 'Q1', targetNodeIds: ['n1'] }),
                makeCard({ id: 'b', question: 'Q2', targetNodeIds: [] })
            ],
            nodesById: nodes
        });
        const search = container.querySelector('#fc-search');
        search.value = 'mordred';
        search.dispatchEvent(new Event('input'));
        expect(container.querySelectorAll('.fc-row').length).toBe(1);
        expect(container.querySelector('.fc-row').dataset.fcId).toBe('a');
    });

    it('shows a no-match message when the search yields zero cards', () => {
        const { overview, container } = mount();
        overview.show({ cards: [makeCard({ question: 'Q' })], nodesById: new Map() });
        const search = container.querySelector('#fc-search');
        search.value = 'nothing-matches-this';
        search.dispatchEvent(new Event('input'));
        expect(container.querySelector('.fc-empty').textContent).toMatch(/No cards match/);
    });
});

// ---------- sort ----------

describe('FlashcardOverview — sort', () => {
    it("'box-asc' sorts failing cards first", () => {
        const { overview, container } = mount();
        overview.show({
            cards: [
                makeCard({ id: 'mastered', srsBox: 4 }),
                makeCard({ id: 'failing', srsBox: 0 }),
                makeCard({ id: 'learning', srsBox: 2 })
            ],
            nodesById: new Map()
        });
        // default is box-asc
        expect(Array.from(container.querySelectorAll('.fc-row')).map((r) => r.dataset.fcId))
            .toEqual(['failing', 'learning', 'mastered']);
    });

    it("'due-asc' sorts by nextReviewAt ascending", () => {
        const { overview, container } = mount();
        overview.show({
            cards: [
                makeCard({ id: 'late',  nextReviewAt: NOW + 10 * DAY }),
                makeCard({ id: 'now',   nextReviewAt: NOW - 100 }),
                makeCard({ id: 'soon',  nextReviewAt: NOW + DAY })
            ],
            nodesById: new Map()
        });
        const sel = container.querySelector('#fc-sort');
        sel.value = 'due-asc';
        sel.dispatchEvent(new Event('change'));
        expect(Array.from(container.querySelectorAll('.fc-row')).map((r) => r.dataset.fcId))
            .toEqual(['now', 'soon', 'late']);
    });

    it("'level-asc' sorts L1 before L2 before L3", () => {
        const { overview, container } = mount();
        overview.show({
            cards: [
                makeCard({ id: 'l3', cognitiveLevel: 3 }),
                makeCard({ id: 'l1', cognitiveLevel: 1 }),
                makeCard({ id: 'l2', cognitiveLevel: 2 })
            ],
            nodesById: new Map()
        });
        const sel = container.querySelector('#fc-sort');
        sel.value = 'level-asc';
        sel.dispatchEvent(new Event('change'));
        expect(Array.from(container.querySelectorAll('.fc-row')).map((r) => r.dataset.fcId))
            .toEqual(['l1', 'l2', 'l3']);
    });
});

// ---------- row expand/collapse ----------

describe('FlashcardOverview — row expand/collapse', () => {
    it('clicking a summary expands the row to show options + explanation', () => {
        const { overview, container } = mount();
        overview.show({ cards: [makeCard({ id: 'a' })], nodesById: new Map() });
        container.querySelector('.fc-row-summary').click();
        const row = container.querySelector('.fc-row');
        expect(row.classList.contains('expanded')).toBe(true);
        expect(row.querySelector('.fc-options')).toBeTruthy();
        expect(row.querySelector('.fc-explanation')).toBeTruthy();
    });

    it('highlights the correct option', () => {
        const { overview, container } = mount();
        overview.show({
            cards: [makeCard({ id: 'a', correctIndex: 2 })],
            nodesById: new Map()
        });
        container.querySelector('.fc-row-summary').click();
        const opts = container.querySelectorAll('.fc-opt');
        expect(opts[0].classList.contains('fc-opt-correct')).toBe(false);
        expect(opts[2].classList.contains('fc-opt-correct')).toBe(true);
    });

    it('clicking the summary again collapses', () => {
        const { overview, container } = mount();
        overview.show({ cards: [makeCard({ id: 'a' })], nodesById: new Map() });
        const sumSel = () => container.querySelector('.fc-row-summary');
        sumSel().click();
        expect(container.querySelector('.fc-row').classList.contains('expanded')).toBe(true);
        sumSel().click();
        expect(container.querySelector('.fc-row').classList.contains('expanded')).toBe(false);
    });
});

// ---------- jump-to-passage ----------

describe('FlashcardOverview — jump to passage', () => {
    it('clicking jump fires onJumpToPassage with primary coords', () => {
        const { overview, container, callbacks } = mount();
        overview.show({
            cards: [makeCard({ id: 'a', primaryChapterIndex: 4, primarySentenceIndex: 17 })],
            nodesById: new Map()
        });
        container.querySelector('.fc-row-summary').click(); // expand
        container.querySelector('.fc-jump-btn').click();
        expect(callbacks.onJumpToPassage).toHaveBeenCalledWith({
            chapterIndex: 4,
            sentenceIndex: 17,
            card: expect.objectContaining({ id: 'a' })
        });
    });
});

// ---------- delete ----------

describe('FlashcardOverview — delete', () => {
    it('clicking delete opens the confirm dialog and on accept fires onCardDeleted + removes the row', async () => {
        const confirmAction = vi.fn(async () => true);
        const { overview, container, callbacks } = mount({ confirmAction });
        overview.show({
            cards: [makeCard({ id: 'a', question: 'Q1' }), makeCard({ id: 'b', question: 'Q2' })],
            nodesById: new Map()
        });
        container.querySelectorAll('.fc-row-summary')[0].click();
        const deleteBtn = container.querySelector('.fc-delete-btn');
        deleteBtn.click();
        // Wait for the async confirm.
        await new Promise((r) => setTimeout(r, 0));
        expect(confirmAction).toHaveBeenCalledWith(expect.objectContaining({ danger: true }));
        expect(callbacks.onCardDeleted).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
        expect(container.querySelectorAll('.fc-row').length).toBe(1);
    });

    it('on cancel, leaves the row in place and does NOT fire onCardDeleted', async () => {
        const confirmAction = vi.fn(async () => false);
        const { overview, container, callbacks } = mount({ confirmAction });
        overview.show({ cards: [makeCard({ id: 'a' })], nodesById: new Map() });
        container.querySelector('.fc-row-summary').click();
        container.querySelector('.fc-delete-btn').click();
        await new Promise((r) => setTimeout(r, 0));
        expect(callbacks.onCardDeleted).not.toHaveBeenCalled();
        expect(container.querySelectorAll('.fc-row').length).toBe(1);
    });
});

// ---------- review selection ----------

describe('FlashcardOverview — review selection', () => {
    it("'Review Selection' is disabled when the visible set is empty", () => {
        const { overview, container } = mount();
        overview.show({ cards: [], nodesById: new Map() });
        expect(container.querySelector('#fc-review-btn').disabled).toBe(true);
    });

    it('fires onReviewSelection with the currently visible subset (post-filter)', () => {
        const { overview, container, callbacks } = mount();
        overview.show({
            cards: [
                makeCard({ id: 'a', question: 'about Beowulf', explanation: 'epic' }),
                makeCard({ id: 'b', question: 'about Merlin', explanation: 'wizard' })
            ],
            nodesById: new Map()
        });
        const search = container.querySelector('#fc-search');
        search.value = 'Beowulf';
        search.dispatchEvent(new Event('input'));
        container.querySelector('#fc-review-btn').click();
        const cardsFired = callbacks.onReviewSelection.mock.calls[0][0];
        expect(cardsFired.map((c) => c.id)).toEqual(['a']);
    });
});

// ---------- refresh ----------

describe('FlashcardOverview — refresh()', () => {
    it('updates the displayed deck without re-mounting', () => {
        const { overview, container } = mount();
        overview.show({ cards: [makeCard({ id: 'a' })], nodesById: new Map() });
        expect(container.querySelectorAll('.fc-row').length).toBe(1);
        overview.refresh({
            cards: [makeCard({ id: 'a' }), makeCard({ id: 'b' })],
            nodesById: new Map()
        });
        expect(container.querySelectorAll('.fc-row').length).toBe(2);
    });
});

// ---------- scrollToCardId ----------

describe('FlashcardOverview — scrollToCardId', () => {
    it('auto-expands the target card so its details are visible', () => {
        const { overview, container } = mount();
        const cards = [
            makeCard({ id: 'a' }),
            makeCard({ id: 'target' }),
            makeCard({ id: 'c' })
        ];
        overview.show({ cards, nodesById: new Map(), scrollToCardId: 'target' });
        const targetRow = container.querySelector('[data-fc-id="target"]');
        expect(targetRow.classList.contains('expanded')).toBe(true);
    });
});
