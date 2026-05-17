import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SRSOverlay } from '../js/ui/srs-overlay.js';

const makeCard = (overrides = {}) => ({
    id: 'fc1',
    bookId: 'b1',
    cognitiveLevel: 1,
    question: 'Who drew the sword?',
    options: ['Arthur', 'Mordred', 'Merlin', 'Lancelot'],
    correctIndex: 0,
    explanation: 'The passage names Arthur.',
    primaryChapterIndex: 0,
    primarySentenceIndex: 0,
    ...overrides
});

const mount = (callbacks = {}) => {
    document.body.innerHTML = '<div id="srs-overlay" class="srs-overlay hidden"></div>';
    const container = document.getElementById('srs-overlay');
    const cb = {
        onClose: vi.fn(),
        onAnswer: vi.fn(),
        onContinue: vi.fn(),
        onJump: vi.fn(),
        onGenerateMore: vi.fn(),
        ...callbacks
    };
    const overlay = new SRSOverlay({ container }, cb);
    return { overlay, container, cb };
};

beforeEach(() => { document.body.innerHTML = ''; });

// ---------- Show / hide ----------

describe('SRSOverlay show/hide', () => {
    it('show() makes the overlay visible (active class)', () => {
        const { overlay, container } = mount();
        overlay.show();
        expect(container.classList.contains('hidden')).toBe(false);
        expect(container.classList.contains('active')).toBe(true);
    });

    it('hide() removes the active class and resets state', () => {
        const { overlay, container } = mount();
        overlay.showCard(makeCard());
        overlay.show();
        overlay.hide();
        expect(container.classList.contains('active')).toBe(false);
        expect(container.classList.contains('hidden')).toBe(true);
        expect(overlay.getState().currentCardId).toBeNull();
    });
});

// ---------- showCard ----------

describe('SRSOverlay.showCard', () => {
    it('renders question and 4 options', () => {
        const { overlay, container } = mount();
        overlay.showCard(makeCard());
        expect(container.querySelector('#srs-question').textContent).toBe('Who drew the sword?');
        const optTexts = Array.from(container.querySelectorAll('.srs-option-text'))
            .filter((el) => !el.closest('.srs-option').classList.contains('hidden'))
            .map((el) => el.textContent);
        expect(optTexts).toEqual(['Arthur', 'Mordred', 'Merlin', 'Lancelot']);
    });

    it('shows the level chip with the correct class for the cognitive level', () => {
        const { overlay, container } = mount();
        overlay.showCard(makeCard({ cognitiveLevel: 2 }));
        const chip = container.querySelector('#srs-level-chip');
        expect(chip.classList.contains('hidden')).toBe(false);
        expect(chip.textContent).toBe('L2');
        expect(chip.classList.contains('srs-level-2')).toBe(true);
    });

    it('clears any previous reveal state', () => {
        const { overlay, container } = mount();
        const card = makeCard();
        overlay.showCard(card);
        overlay.revealAnswer({ card, result: 'fail', selectedIndex: 1 });
        // Now show a new card — explanation should disappear, options re-enabled.
        overlay.showCard(makeCard({ id: 'fc2', question: 'Next?' }));
        expect(container.querySelector('#srs-explanation').classList.contains('hidden')).toBe(true);
        const opts = container.querySelectorAll('.srs-option');
        for (const o of opts) expect(o.disabled).toBe(false);
        expect(container.querySelector('#srs-card-actions').classList.contains('hidden')).toBe(true);
    });

    it('switches from status section to card section', () => {
        const { overlay, container } = mount();
        overlay.setLoading();
        expect(container.querySelector('#srs-status-section').classList.contains('hidden')).toBe(false);
        overlay.showCard(makeCard());
        expect(container.querySelector('#srs-status-section').classList.contains('hidden')).toBe(true);
        expect(container.querySelector('#srs-card-section').classList.contains('hidden')).toBe(false);
    });

    it('passing null falls back to setEmpty()', () => {
        const { overlay, container } = mount();
        overlay.showCard(null);
        expect(container.querySelector('#srs-status-text').textContent).toMatch(/Deck complete/);
    });
});

// ---------- option click ----------

describe('SRSOverlay option clicks', () => {
    it('calling onAnswer with the option index when an option is clicked', () => {
        const { overlay, container, cb } = mount();
        overlay.showCard(makeCard());
        container.querySelectorAll('.srs-option')[2].click();
        expect(cb.onAnswer).toHaveBeenCalledWith(2);
    });

    it('ignores option clicks once the answer has been revealed', () => {
        const { overlay, container, cb } = mount();
        const card = makeCard();
        overlay.showCard(card);
        overlay.revealAnswer({ card, result: 'pass', selectedIndex: 0 });
        cb.onAnswer.mockClear();
        container.querySelectorAll('.srs-option')[1].click();
        expect(cb.onAnswer).not.toHaveBeenCalled();
    });
});

// ---------- revealAnswer ----------

describe('SRSOverlay.revealAnswer', () => {
    it('marks the correct option green', () => {
        const { overlay, container } = mount();
        const card = makeCard();
        overlay.showCard(card);
        overlay.revealAnswer({ card, result: 'pass', selectedIndex: 0 });
        const opts = container.querySelectorAll('.srs-option');
        expect(opts[0].classList.contains('srs-option-correct')).toBe(true);
        expect(opts[1].classList.contains('srs-option-incorrect')).toBe(false);
    });

    it('on fail, marks the selected option red and shows the jump button', () => {
        const { overlay, container } = mount();
        const card = makeCard();
        overlay.showCard(card);
        overlay.revealAnswer({ card, result: 'fail', selectedIndex: 2 });
        const opts = container.querySelectorAll('.srs-option');
        expect(opts[0].classList.contains('srs-option-correct')).toBe(true);   // correct still green
        expect(opts[2].classList.contains('srs-option-incorrect')).toBe(true); // user's pick red
        expect(container.querySelector('#srs-jump-btn').classList.contains('hidden')).toBe(false);
    });

    it('on pass, the jump button stays hidden', () => {
        const { overlay, container } = mount();
        const card = makeCard();
        overlay.showCard(card);
        overlay.revealAnswer({ card, result: 'pass', selectedIndex: 0 });
        expect(container.querySelector('#srs-jump-btn').classList.contains('hidden')).toBe(true);
    });

    it('shows the explanation', () => {
        const { overlay, container } = mount();
        const card = makeCard();
        overlay.showCard(card);
        overlay.revealAnswer({ card, result: 'pass', selectedIndex: 0 });
        const expl = container.querySelector('#srs-explanation');
        expect(expl.classList.contains('hidden')).toBe(false);
        expect(expl.textContent).toBe('The passage names Arthur.');
    });

    it('disables all options', () => {
        const { overlay, container } = mount();
        const card = makeCard();
        overlay.showCard(card);
        overlay.revealAnswer({ card, result: 'fail', selectedIndex: 1 });
        const opts = container.querySelectorAll('.srs-option');
        for (let i = 0; i < 4; i++) {
            expect(opts[i].disabled).toBe(true);
        }
    });

    it('shows the Continue button', () => {
        const { overlay, container } = mount();
        const card = makeCard();
        overlay.showCard(card);
        overlay.revealAnswer({ card, result: 'pass', selectedIndex: 0 });
        expect(container.querySelector('#srs-card-actions').classList.contains('hidden')).toBe(false);
    });

    it('increments answered count', () => {
        const { overlay } = mount();
        const card = makeCard();
        overlay.showCard(card);
        expect(overlay.getState().answered).toBe(0);
        overlay.revealAnswer({ card, result: 'pass', selectedIndex: 0 });
        expect(overlay.getState().answered).toBe(1);
    });
});

// ---------- continue button ----------

describe('SRSOverlay continue', () => {
    it('clicking Continue advances to the buffered next card', () => {
        const { overlay, container, cb } = mount();
        const c1 = makeCard({ id: 'c1', question: 'Q1?' });
        const c2 = makeCard({ id: 'c2', question: 'Q2?' });
        overlay.showCard(c1);
        overlay.revealAnswer({ card: c1, result: 'pass', selectedIndex: 0 });
        overlay.setNextCard(c2);
        container.querySelector('#srs-continue-btn').click();
        expect(cb.onContinue).toHaveBeenCalled();
        expect(container.querySelector('#srs-question').textContent).toBe('Q2?');
        expect(overlay.getState().currentCardId).toBe('c2');
        expect(overlay.getState().bufferedCardId).toBeNull();
        expect(overlay.getState().isRevealing).toBe(false);
    });

    it('clicking Continue with no buffered card falls to empty state', () => {
        const { overlay, container } = mount();
        const card = makeCard();
        overlay.showCard(card);
        overlay.revealAnswer({ card, result: 'pass', selectedIndex: 0 });
        container.querySelector('#srs-continue-btn').click();
        expect(container.querySelector('#srs-status-text').textContent).toMatch(/Deck complete/);
        expect(container.querySelector('#srs-card-section').classList.contains('hidden')).toBe(true);
    });
});

// ---------- jump / generate-more / close ----------

describe('SRSOverlay jump/close/generate-more', () => {
    it('clicking the jump button calls onJump', () => {
        const { overlay, container, cb } = mount();
        const card = makeCard();
        overlay.showCard(card);
        overlay.revealAnswer({ card, result: 'fail', selectedIndex: 2 });
        container.querySelector('#srs-jump-btn').click();
        expect(cb.onJump).toHaveBeenCalled();
    });

    it('clicking the close button calls onClose', () => {
        const { container, cb } = mount();
        container.querySelector('#srs-close-btn').click();
        expect(cb.onClose).toHaveBeenCalled();
    });

    it('clicking the all-cards header button calls onCardOverview', () => {
        const { container, cb } = mount({ onCardOverview: vi.fn() });
        container.querySelector('#srs-cards-btn').click();
        expect(cb.onCardOverview).toHaveBeenCalledTimes(1);
        // The close button is independent.
        expect(cb.onClose).not.toHaveBeenCalled();
    });

    it('clicking "Generate more" in empty state calls onGenerateMore', () => {
        const { overlay, container, cb } = mount();
        overlay.setEmpty();
        container.querySelector('#srs-generate-more-btn').click();
        expect(cb.onGenerateMore).toHaveBeenCalled();
    });
});

// ---------- progress ----------

describe('SRSOverlay progress strip', () => {
    it('shows "Remaining: 1" when a card is awaiting answer', () => {
        const { overlay, container } = mount();
        overlay.showCard(makeCard());
        expect(container.querySelector('#srs-progress').textContent).toContain('Remaining: 1');
    });

    it('shows "Answered" once a card has been answered', () => {
        const { overlay, container } = mount();
        const card = makeCard();
        overlay.showCard(card);
        overlay.revealAnswer({ card, result: 'pass', selectedIndex: 0 });
        expect(container.querySelector('#srs-progress').textContent).toContain('Answered: 1');
    });

    it('shows total remaining including the buffered next card', () => {
        const { overlay, container } = mount();
        const c1 = makeCard({ id: 'c1' });
        const c2 = makeCard({ id: 'c2' });
        overlay.showCard(c1);
        overlay.revealAnswer({ card: c1, result: 'pass', selectedIndex: 0 });
        overlay.setNextCard(c2);
        overlay._updateProgress();
        expect(container.querySelector('#srs-progress').textContent).toMatch(/Remaining: 1/);
    });
});

// ---------- variable option count ----------

describe('SRSOverlay variable option count', () => {
    it('hides extra DOM options when a card has fewer than 4 options', () => {
        const { overlay, container } = mount();
        const card = makeCard({ options: ['Yes', 'No', 'Maybe'], correctIndex: 1 });
        overlay.showCard(card);
        const opts = container.querySelectorAll('.srs-option');
        expect(opts[0].classList.contains('hidden')).toBe(false);
        expect(opts[1].classList.contains('hidden')).toBe(false);
        expect(opts[2].classList.contains('hidden')).toBe(false);
        expect(opts[3].classList.contains('hidden')).toBe(true);
    });
});
