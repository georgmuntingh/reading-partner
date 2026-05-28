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

// ---------- chapter-range filter ----------

describe('SRSOverlay chapter filter', () => {
    it('is hidden by default until configureChapterFilter is called', () => {
        const { container } = mount();
        const section = container.querySelector('#srs-chapter-filter');
        expect(section.classList.contains('hidden')).toBe(true);
    });

    it('hides the filter when totalChapters < 2', () => {
        const { overlay, container } = mount();
        overlay.configureChapterFilter({ totalChapters: 1, from: 1, to: 1 });
        expect(container.querySelector('#srs-chapter-filter').classList.contains('hidden')).toBe(true);
    });

    it('shows the filter and sets min/max/value when totalChapters >= 2', () => {
        const { overlay, container } = mount();
        overlay.configureChapterFilter({ totalChapters: 10, from: 3, to: 3 });
        const filter = container.querySelector('#srs-chapter-filter');
        expect(filter.classList.contains('hidden')).toBe(false);
        const fromSlider = container.querySelector('#srs-chapter-from');
        const toSlider = container.querySelector('#srs-chapter-to');
        expect(fromSlider.max).toBe('10');
        expect(toSlider.max).toBe('10');
        expect(fromSlider.value).toBe('3');
        expect(toSlider.value).toBe('3');
        expect(container.querySelector('#srs-chapter-from-label').textContent).toBe('3');
        expect(container.querySelector('#srs-chapter-to-label').textContent).toBe('3');
    });

    it('getChapterRange returns the current values when visible, null when hidden', () => {
        const { overlay } = mount();
        expect(overlay.getChapterRange()).toBeNull();
        overlay.configureChapterFilter({ totalChapters: 5, from: 2, to: 4 });
        expect(overlay.getChapterRange()).toEqual({ from: 2, to: 4 });
    });

    it('keeps From <= To by nudging To upward when From moves past it', () => {
        const { overlay, container } = mount();
        overlay.configureChapterFilter({ totalChapters: 10, from: 3, to: 5 });
        const fromSlider = container.querySelector('#srs-chapter-from');
        const toSlider = container.querySelector('#srs-chapter-to');
        fromSlider.value = '7';
        fromSlider.dispatchEvent(new Event('input', { bubbles: true }));
        expect(toSlider.value).toBe('7');
    });

    it('keeps From <= To by nudging From downward when To moves below it', () => {
        const { overlay, container } = mount();
        overlay.configureChapterFilter({ totalChapters: 10, from: 5, to: 7 });
        const fromSlider = container.querySelector('#srs-chapter-from');
        const toSlider = container.querySelector('#srs-chapter-to');
        toSlider.value = '3';
        toSlider.dispatchEvent(new Event('input', { bubbles: true }));
        expect(fromSlider.value).toBe('3');
    });

    it('fires onChapterRangeChange after a debounce', async () => {
        const onChapterRangeChange = vi.fn();
        const { overlay, container } = mount({ onChapterRangeChange });
        overlay.configureChapterFilter({ totalChapters: 10, from: 2, to: 5 });
        const toSlider = container.querySelector('#srs-chapter-to');
        toSlider.value = '8';
        toSlider.dispatchEvent(new Event('input', { bubbles: true }));
        // Not yet — still debounced.
        expect(onChapterRangeChange).not.toHaveBeenCalled();
        await new Promise((r) => setTimeout(r, 200));
        expect(onChapterRangeChange).toHaveBeenCalledTimes(1);
        expect(onChapterRangeChange).toHaveBeenCalledWith({ from: 2, to: 8 });
    });

    it('rebuild button emits onRebuildDeck with the current 1-based range', () => {
        const onRebuildDeck = vi.fn();
        const { overlay, container } = mount({ onRebuildDeck });
        overlay.configureChapterFilter({ totalChapters: 10, from: 3, to: 7 });
        const rebuildBtn = container.querySelector('#srs-rebuild-btn');
        rebuildBtn.click();
        expect(onRebuildDeck).toHaveBeenCalledTimes(1);
        expect(onRebuildDeck).toHaveBeenCalledWith({ from: 3, to: 7 });
    });

    it('rebuild flushes any pending debounced range change so it does not double-fire', async () => {
        const onChapterRangeChange = vi.fn();
        const onRebuildDeck = vi.fn();
        const { overlay, container } = mount({ onChapterRangeChange, onRebuildDeck });
        overlay.configureChapterFilter({ totalChapters: 10, from: 1, to: 1 });
        const toSlider = container.querySelector('#srs-chapter-to');
        toSlider.value = '6';
        toSlider.dispatchEvent(new Event('input', { bubbles: true }));
        // Before the debounce elapses, click Rebuild.
        container.querySelector('#srs-rebuild-btn').click();
        await new Promise((r) => setTimeout(r, 200));
        expect(onChapterRangeChange).not.toHaveBeenCalled();
        expect(onRebuildDeck).toHaveBeenCalledWith({ from: 1, to: 6 });
    });

    it('marks the question, options, and explanation as lookup contexts', () => {
        const { container } = mount();
        expect(container.querySelector('#srs-question').hasAttribute('data-lookup-context')).toBe(true);
        const optionTexts = container.querySelectorAll('.srs-option-text');
        expect(optionTexts.length).toBeGreaterThan(0);
        for (const el of optionTexts) {
            expect(el.hasAttribute('data-lookup-context')).toBe(true);
        }
        expect(container.querySelector('#srs-explanation').hasAttribute('data-lookup-context')).toBe(true);
    });

    it('instantiates a LookupSelection helper for the dialog', () => {
        const { overlay } = mount();
        expect(overlay._lookupSelection).toBeDefined();
        expect(overlay._lookupSelection._container).toBe(overlay._elements.dialog);
    });

    it('forwards onLookup invocations to the host callback', () => {
        const onLookup = vi.fn();
        const { overlay } = mount({ onLookup });
        overlay._lookupSelection._onLookup?.('arthur', 'King Arthur drew the sword.');
        expect(onLookup).toHaveBeenCalledWith('arthur', 'King Arthur drew the sword.');
    });

    it('coalesces multiple rapid changes into a single emission', async () => {
        const onChapterRangeChange = vi.fn();
        const { overlay, container } = mount({ onChapterRangeChange });
        overlay.configureChapterFilter({ totalChapters: 10, from: 1, to: 1 });
        const toSlider = container.querySelector('#srs-chapter-to');
        for (const v of ['2', '3', '4', '5']) {
            toSlider.value = v;
            toSlider.dispatchEvent(new Event('input', { bubbles: true }));
        }
        await new Promise((r) => setTimeout(r, 200));
        expect(onChapterRangeChange).toHaveBeenCalledTimes(1);
        expect(onChapterRangeChange).toHaveBeenCalledWith({ from: 1, to: 5 });
    });
});
