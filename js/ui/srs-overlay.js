/**
 * SRS Overlay UI
 *
 * Renders the Spaced Review deck. The overlay is intentionally narrow:
 *   - Multiple-choice only (no free-form, no TTS, no microphone).
 *   - No live LLM streaming — every card is already grounded by the
 *     time it arrives.
 *
 * Wiring: host (app.js) listens for SRSController events and pipes
 * them in here via the public API:
 *   - showCard(card)                       (onCardReady)
 *   - revealAnswer({card, result, idx})   (onResult)
 *   - setNextCard(card)                    (onCardReady AFTER a result)
 *   - setEmpty()                           (onDeckEmpty)
 *   - setLoading(msg)                      (onStateChange === 'loading')
 *
 * The overlay buffers the next card so the user can read the
 * explanation; clicking "Continue" advances to the buffered card or
 * falls to the empty state.
 */

const OPTION_LABELS = ['A', 'B', 'C', 'D', 'E', 'F'];

export class SRSOverlay {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.container
     * @param {Object} callbacks
     * @param {() => void} callbacks.onClose
     * @param {(index: number) => void} callbacks.onAnswer
     * @param {() => void} [callbacks.onContinue]
     * @param {() => void} [callbacks.onJump]
     * @param {() => void} [callbacks.onGenerateMore]
     * @param {() => void} [callbacks.onCardOverview]   open the Flashcard Overview modal
     */
    constructor(options, callbacks = {}) {
        this._container = options.container;
        this._callbacks = callbacks;

        this._currentCard = null;
        this._bufferedCard = null;
        this._isRevealing = false;
        this._answered = 0;

        this._buildUI();
        this._setupEventListeners();
    }

    // ---------- DOM build ----------

    _buildUI() {
        this._container.innerHTML = `
            <div class="srs-dialog">
                <div class="srs-header">
                    <div class="srs-header-titles">
                        <h2 class="srs-title">Spaced Review</h2>
                        <span class="srs-level-chip hidden" id="srs-level-chip"></span>
                    </div>
                    <button class="srs-cards-btn srs-close-btn" id="srs-cards-btn" aria-label="All flashcards" title="View all flashcards">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <rect x="3" y="5" width="14" height="14" rx="2"/>
                            <rect x="7" y="3" width="14" height="14" rx="2" fill="currentColor" fill-opacity="0.12"/>
                        </svg>
                    </button>
                    <button class="srs-close-btn" id="srs-close-btn" aria-label="Close">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="18" y1="6" x2="6" y2="18"/>
                            <line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </button>
                </div>

                <div class="srs-content">
                    <!-- Status (loading / empty / error) -->
                    <div class="srs-status-section" id="srs-status-section">
                        <div class="srs-status-text" id="srs-status-text">Loading…</div>
                        <button class="btn btn-primary hidden" id="srs-generate-more-btn">Generate more cards</button>
                    </div>

                    <!-- Card body -->
                    <div class="srs-card-section hidden" id="srs-card-section">
                        <div class="srs-question" id="srs-question"></div>
                        <div class="srs-options" id="srs-options">
                            <button class="srs-option" data-index="0"><span class="srs-option-label">A)</span> <span class="srs-option-text"></span></button>
                            <button class="srs-option" data-index="1"><span class="srs-option-label">B)</span> <span class="srs-option-text"></span></button>
                            <button class="srs-option" data-index="2"><span class="srs-option-label">C)</span> <span class="srs-option-text"></span></button>
                            <button class="srs-option" data-index="3"><span class="srs-option-label">D)</span> <span class="srs-option-text"></span></button>
                        </div>

                        <!-- Explanation (after answer) -->
                        <div class="srs-explanation hidden" id="srs-explanation"></div>

                        <div class="srs-card-actions hidden" id="srs-card-actions">
                            <button class="btn btn-secondary srs-jump-btn hidden" id="srs-jump-btn">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3h7v7"/><path d="M10 14L21 3"/><path d="M21 14v7h-7"/></svg>
                                Jump to passage
                            </button>
                            <button class="btn btn-primary srs-continue-btn" id="srs-continue-btn">Continue</button>
                        </div>
                    </div>
                </div>

                <div class="srs-footer">
                    <span class="srs-progress" id="srs-progress"></span>
                </div>
            </div>
        `;

        this._elements = {
            dialog: this._container.querySelector('.srs-dialog'),
            closeBtn: this._container.querySelector('#srs-close-btn'),
            cardsBtn: this._container.querySelector('#srs-cards-btn'),
            levelChip: this._container.querySelector('#srs-level-chip'),
            statusSection: this._container.querySelector('#srs-status-section'),
            statusText: this._container.querySelector('#srs-status-text'),
            generateMoreBtn: this._container.querySelector('#srs-generate-more-btn'),
            cardSection: this._container.querySelector('#srs-card-section'),
            question: this._container.querySelector('#srs-question'),
            optionsContainer: this._container.querySelector('#srs-options'),
            options: Array.from(this._container.querySelectorAll('.srs-option')),
            optionTexts: Array.from(this._container.querySelectorAll('.srs-option-text')),
            explanation: this._container.querySelector('#srs-explanation'),
            cardActions: this._container.querySelector('#srs-card-actions'),
            jumpBtn: this._container.querySelector('#srs-jump-btn'),
            continueBtn: this._container.querySelector('#srs-continue-btn'),
            progress: this._container.querySelector('#srs-progress')
        };
    }

    _setupEventListeners() {
        this._elements.closeBtn.addEventListener('click', () => this._callbacks.onClose?.());
        this._elements.cardsBtn?.addEventListener('click', () => this._callbacks.onCardOverview?.());

        for (const optBtn of this._elements.options) {
            optBtn.addEventListener('click', () => {
                if (this._isRevealing || !this._currentCard) return;
                const idx = Number(optBtn.dataset.index);
                this._callbacks.onAnswer?.(idx);
            });
        }

        this._elements.continueBtn.addEventListener('click', () => {
            this._callbacks.onContinue?.();
            if (this._bufferedCard) {
                const next = this._bufferedCard;
                this._bufferedCard = null;
                this.showCard(next);
            } else {
                this.setEmpty();
            }
        });

        this._elements.jumpBtn.addEventListener('click', () => {
            this._callbacks.onJump?.();
        });

        this._elements.generateMoreBtn.addEventListener('click', () => {
            this._callbacks.onGenerateMore?.();
        });
    }

    // ---------- show / hide ----------

    show() {
        this._container.classList.remove('hidden');
        this._container.offsetHeight; // force reflow for transition
        this._container.classList.add('active');
    }

    hide() {
        this._container.classList.remove('active');
        this._container.classList.add('hidden');
        this._currentCard = null;
        this._bufferedCard = null;
        this._isRevealing = false;
        this._answered = 0;
    }

    // ---------- state setters (driven by host wiring controller events) ----------

    setLoading(message = 'Loading deck…') {
        this._elements.statusText.textContent = message;
        this._elements.generateMoreBtn.classList.add('hidden');
        this._elements.statusSection.classList.remove('hidden');
        this._elements.cardSection.classList.add('hidden');
        this._elements.levelChip.classList.add('hidden');
    }

    setEmpty(message = 'Deck complete. Come back later for due reviews.') {
        this._currentCard = null;
        this._bufferedCard = null;
        this._isRevealing = false;
        this._elements.statusText.textContent = message;
        this._elements.generateMoreBtn.classList.remove('hidden');
        this._elements.statusSection.classList.remove('hidden');
        this._elements.cardSection.classList.add('hidden');
        this._elements.levelChip.classList.add('hidden');
        this._updateProgress();
    }

    setError(message) {
        this._elements.statusText.textContent = `Error: ${message}`;
        this._elements.generateMoreBtn.classList.add('hidden');
        this._elements.statusSection.classList.remove('hidden');
        this._elements.cardSection.classList.add('hidden');
    }

    /**
     * Show a card and accept input. Resets reveal/explanation state.
     */
    showCard(card) {
        if (!card) {
            this.setEmpty();
            return;
        }
        this._currentCard = card;
        this._bufferedCard = null;
        this._isRevealing = false;

        this._elements.statusSection.classList.add('hidden');
        this._elements.cardSection.classList.remove('hidden');

        this._elements.question.textContent = card.question ?? '';

        // Render options. Pad/trim the DOM to match the card's option count.
        const optCount = Array.isArray(card.options) ? card.options.length : 0;
        for (let i = 0; i < this._elements.options.length; i++) {
            const optBtn = this._elements.options[i];
            if (i < optCount) {
                this._elements.optionTexts[i].textContent = card.options[i];
                optBtn.querySelector('.srs-option-label').textContent = `${OPTION_LABELS[i] ?? (i + 1)})`;
                optBtn.classList.remove('hidden');
                optBtn.classList.remove('srs-option-correct', 'srs-option-incorrect');
                optBtn.disabled = false;
            } else {
                optBtn.classList.add('hidden');
            }
        }

        this._elements.explanation.classList.add('hidden');
        this._elements.explanation.textContent = '';
        this._elements.cardActions.classList.add('hidden');
        this._elements.jumpBtn.classList.add('hidden');

        // Level chip.
        const level = card.cognitiveLevel ?? 1;
        this._elements.levelChip.textContent = `L${level}`;
        this._elements.levelChip.classList.remove('hidden', 'srs-level-1', 'srs-level-2', 'srs-level-3');
        this._elements.levelChip.classList.add(`srs-level-${level}`);

        this._updateProgress();
    }

    /**
     * Reveal correctness on the current card. Marks the correct option
     * green and (if the user was wrong) marks their selection red.
     * Shows the explanation and the Continue button. On fail, also
     * shows the "Jump to passage" button.
     */
    revealAnswer({ card, result, selectedIndex }) {
        if (!card) return;
        // If the card identity changed for any reason, ignore — defensive.
        this._currentCard = card;
        this._isRevealing = true;
        this._answered += 1;

        const correctIndex = card.correctIndex;
        const optCount = Array.isArray(card.options) ? card.options.length : 0;
        for (let i = 0; i < optCount; i++) {
            const optBtn = this._elements.options[i];
            optBtn.disabled = true;
            if (i === correctIndex) {
                optBtn.classList.add('srs-option-correct');
            } else if (i === selectedIndex && result === 'fail') {
                optBtn.classList.add('srs-option-incorrect');
            }
        }

        if (card.explanation) {
            this._elements.explanation.textContent = card.explanation;
            this._elements.explanation.classList.remove('hidden');
        }

        this._elements.cardActions.classList.remove('hidden');
        if (result === 'fail') {
            this._elements.jumpBtn.classList.remove('hidden');
        } else {
            this._elements.jumpBtn.classList.add('hidden');
        }

        this._updateProgress();
    }

    /**
     * Buffer the next card so it can be shown when the user clicks
     * Continue. If revealAnswer hasn't been called yet, the buffer is
     * still kept — the next Continue click will pick it up.
     */
    setNextCard(card) {
        this._bufferedCard = card;
    }

    /**
     * Update the progress display. Shows answered count and remaining
     * (current + buffered). Called whenever state changes.
     */
    _updateProgress() {
        const remaining = (this._currentCard && !this._isRevealing ? 1 : 0)
            + (this._bufferedCard ? 1 : 0);
        const parts = [];
        if (this._answered > 0) parts.push(`Answered: ${this._answered}`);
        if (remaining > 0 || this._isRevealing) parts.push(`Remaining: ${remaining}`);
        this._elements.progress.textContent = parts.join(' · ');
    }

    // ---------- introspection for tests ----------

    getState() {
        return {
            currentCardId: this._currentCard?.id ?? null,
            bufferedCardId: this._bufferedCard?.id ?? null,
            isRevealing: this._isRevealing,
            answered: this._answered
        };
    }
}
