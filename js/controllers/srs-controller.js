/**
 * SRS Controller — runtime orchestrator for Spaced Review
 *
 * Wires together:
 *   - Phase 6 buildActiveDeck       (deck construction + prerequisite gate)
 *   - Phase 5 applyReviewResult     (SM-2 scheduling on pass/fail)
 *   - Phase 7 injectFallbackCards   (diagnostic L1 fallback on L2/L3 fail)
 *   - Phase 8 SRSGenerator          (lazy-on-open + chapter-finish triggers)
 *
 * Event-based, mirroring quiz-controller's shape so the overlay can
 * consume both with the same patterns. State machine is intentionally
 * loose — three meaningful states (idle, loading, ready, empty) cover
 * the lifecycle; the UI doesn't need more.
 *
 * The controller owns no UI; callers wire callbacks for every event
 * the overlay needs to react to. All async work is awaitable so tests
 * can drive it deterministically.
 */

import { buildActiveDeck } from '../services/srs-deck-builder.js';
import { applyReviewResult } from '../services/srs-scheduler.js';
import { injectFallbackCards } from '../services/srs-fallback.js';
import { SRSGenerator } from '../services/srs-generator.js';

export const SRSState = {
    IDLE: 'idle',
    LOADING: 'loading',
    READY: 'ready',
    EMPTY: 'empty'
};

export class SRSController {
    /**
     * @param {Object} options
     * @param {Object} options.storage              - StorageService instance
     * @param {Object} options.readingState        - { loadChapter(idx) => Promise<string[]> }
     * @param {Object} options.llmClient           - LLM client (for the generator)
     * @param {Object} options.settings            - SRS settings block
     * @param {Object} [options.generator]         - inject SRSGenerator (defaults to a fresh one)
     * @param {Object} [options.logger]
     * @param {Object} [callbacks]
     * @param {(state: string) => void} [callbacks.onStateChange]
     * @param {(card: Object) => void} [callbacks.onCardReady]
     * @param {({card, result, primary}: Object) => void} [callbacks.onResult]
     * @param {() => void} [callbacks.onDeckEmpty]
     * @param {({chapterIndex, sentenceIndex}: Object) => void} [callbacks.onJump]
     * @param {(count: number) => void} [callbacks.onGenerationComplete]
     * @param {(err: Error) => void} [callbacks.onError]
     */
    constructor(options, callbacks = {}) {
        this.storage = options.storage;
        this.readingState = options.readingState;
        this.llmClient = options.llmClient;
        this.settings = options.settings;
        this.logger = options.logger ?? console;

        this.generator = options.generator ?? new SRSGenerator({
            storage: this.storage,
            readingState: this.readingState,
            llmClient: this.llmClient,
            settings: this.settings,
            logger: this.logger
        });

        this._onStateChange = callbacks.onStateChange;
        this._onCardReady = callbacks.onCardReady;
        this._onResult = callbacks.onResult;
        this._onDeckEmpty = callbacks.onDeckEmpty;
        this._onJump = callbacks.onJump;
        this._onGenerationComplete = callbacks.onGenerationComplete;
        this._onError = callbacks.onError;

        this._state = SRSState.IDLE;
        this._bookId = null;
        this._deck = [];
        this._lastResultCard = null; // remembered so jumpToBook works post-submission
    }

    // ---------- introspection ----------

    getState() { return this._state; }
    currentCard() { return this._deck[0] ?? null; }
    getDeckSize() { return this._deck.length; }

    /**
     * Replace the live settings. Propagates to the internal generator
     * so changes the user saves take effect on the very next deck
     * build / generation pass (the controller has long-lived state
     * that would otherwise capture stale settings).
     */
    setSettings(settings) {
        this.settings = settings;
        if (this.generator) this.generator.settings = settings;
    }

    // ---------- internal ----------

    _setState(state) {
        if (state === this._state) return;
        this._state = state;
        try { this._onStateChange?.(state); }
        catch (err) { this.logger.warn?.('[srs-controller] onStateChange threw:', err); }
    }

    _emitError(err) {
        this.logger.warn?.('[srs-controller]', err?.message || err);
        try { this._onError?.(err); }
        catch (cbErr) { this.logger.warn?.('[srs-controller] onError threw:', cbErr); }
    }

    async _rebuildDeck() {
        const { deck } = await buildActiveDeck({
            bookId: this._bookId,
            storage: this.storage,
            settings: this.settings
        });
        this._deck = deck;
    }

    // ---------- lifecycle ----------

    /**
     * Open the deck for a book. Builds the active queue, runs a lazy
     * generation pass if enabled and the deck is empty, and fires
     * either onCardReady (with the head) or onDeckEmpty.
     *
     * @param {string} bookId
     */
    async openDeck(bookId) {
        if (!bookId) throw new Error('openDeck: bookId is required');
        if (this.settings?.srsEnabled === false) {
            this._setState(SRSState.EMPTY);
            try { this._onDeckEmpty?.(); }
            catch (err) { this.logger.warn?.('[srs-controller] onDeckEmpty threw:', err); }
            return;
        }

        this._bookId = bookId;
        this._lastResultCard = null;
        this._setState(SRSState.LOADING);
        try {
            await this._rebuildDeck();

            if (this._deck.length === 0 && this.settings?.srsTriggerLazyOnOpen) {
                const cards = await this.generator.generateForBook(bookId, {
                    maxCards: this.settings?.srsMaxNewPerSession ?? 10
                });
                try { this._onGenerationComplete?.(cards.length); }
                catch (err) { this.logger.warn?.('[srs-controller] onGenerationComplete threw:', err); }
                await this._rebuildDeck();
            }

            if (this._deck.length === 0) {
                this._setState(SRSState.EMPTY);
                try { this._onDeckEmpty?.(); }
                catch (err) { this.logger.warn?.('[srs-controller] onDeckEmpty threw:', err); }
            } else {
                this._setState(SRSState.READY);
                try { this._onCardReady?.(this._deck[0]); }
                catch (err) { this.logger.warn?.('[srs-controller] onCardReady threw:', err); }
            }
        } catch (err) {
            this._setState(SRSState.IDLE);
            this._emitError(err);
        }
    }

    /**
     * Apply a pass/fail review based on the selected option index for
     * the current card, advance the deck, and fire the appropriate
     * follow-up events. If the user fails an L2/L3 card, the
     * diagnostic fallback injects the underlying L1 cards to the front
     * before the next onCardReady fires.
     *
     * @param {number} selectedIndex
     * @returns {Promise<{card: Object, result: 'pass'|'fail'}>}
     */
    async submitAnswer(selectedIndex) {
        const card = this._deck[0];
        if (!card) throw new Error('submitAnswer: no current card');
        if (!Number.isInteger(selectedIndex)) {
            throw new Error('submitAnswer: selectedIndex must be an integer');
        }

        const result = selectedIndex === card.correctIndex ? 'pass' : 'fail';
        const updated = applyReviewResult(card, result, this.settings);
        await this.storage.saveFlashcard(updated);

        // Drop the head; we'll re-prepend remediation if needed.
        this._deck.shift();
        if (result === 'fail') {
            this._deck = await injectFallbackCards({
                failedCard: updated,
                deck: this._deck,
                storage: this.storage,
                bookId: this._bookId
            });
        }

        this._lastResultCard = updated;

        try {
            this._onResult?.({
                card: updated,
                result,
                primary: {
                    chapterIndex: updated.primaryChapterIndex,
                    sentenceIndex: updated.primarySentenceIndex
                }
            });
        } catch (err) { this.logger.warn?.('[srs-controller] onResult threw:', err); }

        if (this._deck.length === 0) {
            this._setState(SRSState.EMPTY);
            try { this._onDeckEmpty?.(); }
            catch (err) { this.logger.warn?.('[srs-controller] onDeckEmpty threw:', err); }
        } else {
            this._setState(SRSState.READY);
            try { this._onCardReady?.(this._deck[0]); }
            catch (err) { this.logger.warn?.('[srs-controller] onCardReady threw:', err); }
        }

        return { card: updated, result };
    }

    /**
     * Emit a jump event so the host (reader-view) can scroll to the
     * sentence the current card is grounded in. Uses the head card if
     * one is showing, otherwise the most recently-resolved card —
     * which is what the user just failed and presumably wants to look
     * up.
     */
    jumpToBook() {
        const card = this._deck[0] ?? this._lastResultCard;
        if (!card) return;
        const payload = {
            chapterIndex: card.primaryChapterIndex,
            sentenceIndex: card.primarySentenceIndex
        };
        try { this._onJump?.(payload); }
        catch (err) { this.logger.warn?.('[srs-controller] onJump threw:', err); }
    }

    /**
     * Clear deck state. The overlay should call this when it closes.
     */
    closeDeck() {
        this._bookId = null;
        this._deck = [];
        this._lastResultCard = null;
        this._setState(SRSState.IDLE);
    }

    /**
     * Chapter-finish trigger (Workflow 1, on-chapter-finish hook).
     * Fire-and-forget by design — the caller in reading-state should
     * NOT await unless they have a reason to (e.g. tests). Returns the
     * generator's promise so progress can be observed.
     *
     * @param {string} bookId
     * @param {number} chapterIndex
     * @returns {Promise<Object[]>} cards generated (empty array if disabled/skipped)
     */
    async onChapterFinished(bookId, chapterIndex) {
        if (this.settings?.srsEnabled === false) return [];
        if (this.settings?.srsTriggerOnChapterFinish === false) return [];
        try {
            const cards = await this.generator.generateForChapter(bookId, chapterIndex);
            try { this._onGenerationComplete?.(cards.length); }
            catch (err) { this.logger.warn?.('[srs-controller] onGenerationComplete threw:', err); }
            return cards;
        } catch (err) {
            this._emitError(err);
            return [];
        }
    }
}
