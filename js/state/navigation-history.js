/**
 * Navigation History
 * Manages browser-like back/forward navigation for the reader.
 * Tracks positions as (chapterIndex, sentenceIndex, page) entries.
 * Does not persist across sessions.
 */

export class NavigationHistory {
    /**
     * @param {Object} options
     * @param {number} [options.maxDepth=50] - Maximum number of history entries
     * @param {() => void} [options.onChange] - Called when back/forward availability changes
     */
    constructor({ maxDepth = 50, onChange } = {}) {
        this._maxDepth = maxDepth;
        this._onChange = onChange;

        /** @type {Array<{chapterIndex: number, sentenceIndex: number, page: number}>} */
        this._backStack = [];

        /** @type {Array<{chapterIndex: number, sentenceIndex: number, page: number}>} */
        this._forwardStack = [];
    }

    /**
     * Push the current position onto the back stack before navigating away.
     * Clears the forward stack (browser semantics).
     * @param {number} chapterIndex
     * @param {number} sentenceIndex
     * @param {number} page - The current page number (0-indexed)
     */
    pushCurrentPosition(chapterIndex, sentenceIndex, page) {
        this._backStack.push({ chapterIndex, sentenceIndex, page });

        // Enforce max depth
        if (this._backStack.length > this._maxDepth) {
            this._backStack.shift();
        }

        // Clear forward stack (new navigation clears forward history)
        this._forwardStack = [];

        this._onChange?.();
    }

    /**
     * Go back: pops from back stack, returns the position to navigate to,
     * and pushes the current position onto the forward stack.
     * @param {number} currentChapterIndex - Current position before going back
     * @param {number} currentSentenceIndex
     * @param {number} currentPage
     * @returns {{chapterIndex: number, sentenceIndex: number, page: number}|null}
     */
    goBack(currentChapterIndex, currentSentenceIndex, currentPage) {
        if (this._backStack.length === 0) return null;

        // Save current position to forward stack
        this._forwardStack.push({
            chapterIndex: currentChapterIndex,
            sentenceIndex: currentSentenceIndex,
            page: currentPage
        });

        const entry = this._backStack.pop();
        this._onChange?.();
        return entry;
    }

    /**
     * Go forward: pops from forward stack, returns the position to navigate to,
     * and pushes the current position onto the back stack.
     * @param {number} currentChapterIndex - Current position before going forward
     * @param {number} currentSentenceIndex
     * @param {number} currentPage
     * @returns {{chapterIndex: number, sentenceIndex: number, page: number}|null}
     */
    goForward(currentChapterIndex, currentSentenceIndex, currentPage) {
        if (this._forwardStack.length === 0) return null;

        // Save current position to back stack
        this._backStack.push({
            chapterIndex: currentChapterIndex,
            sentenceIndex: currentSentenceIndex,
            page: currentPage
        });

        // Enforce max depth on back stack
        if (this._backStack.length > this._maxDepth) {
            this._backStack.shift();
        }

        const entry = this._forwardStack.pop();
        this._onChange?.();
        return entry;
    }

    /**
     * Whether back navigation is available
     * @returns {boolean}
     */
    canGoBack() {
        return this._backStack.length > 0;
    }

    /**
     * Whether forward navigation is available
     * @returns {boolean}
     */
    canGoForward() {
        return this._forwardStack.length > 0;
    }

    /**
     * Clear all history
     */
    clear() {
        this._backStack = [];
        this._forwardStack = [];
        this._onChange?.();
    }
}
