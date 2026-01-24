/**
 * Reader View UI Component
 * Handles text display and sentence highlighting
 * Uses windowed rendering - only renders sentences near current position
 */

import { scrollIntoViewWithOffset } from '../utils/helpers.js';

export class ReaderView {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.container - The reader content container
     * @param {HTMLElement} options.titleElement - Chapter title element
     * @param {HTMLElement} options.bookTitleElement - Book title element
     * @param {(index: number) => void} options.onSentenceClick - Callback when sentence is clicked
     */
    constructor({ container, titleElement, bookTitleElement, onSentenceClick }) {
        this._container = container;
        this._titleElement = titleElement;
        this._bookTitleElement = bookTitleElement;
        this._onSentenceClick = onSentenceClick;

        this._textContent = container.querySelector('#text-content') || container;
        this._sentences = [];
        this._currentIndex = -1;

        // Windowed rendering
        this._windowSize = 40; // Sentences before and after current
        this._renderedRange = { start: -1, end: -1 };
        this._sentenceElements = new Map(); // index -> element

        // Use event delegation for click handling
        this._setupEventDelegation();
    }

    /**
     * Setup event delegation for sentence clicks
     */
    _setupEventDelegation() {
        this._textContent.addEventListener('click', (e) => {
            const sentenceEl = e.target.closest('.sentence');
            if (sentenceEl && sentenceEl.dataset.index !== undefined) {
                const index = parseInt(sentenceEl.dataset.index, 10);
                this._onSentenceClick?.(index);
            }
        });
    }

    /**
     * Set book title
     * @param {string} title
     */
    setBookTitle(title) {
        if (this._bookTitleElement) {
            this._bookTitleElement.textContent = title;
        }
    }

    /**
     * Set chapter title
     * @param {string} title
     */
    setChapterTitle(title) {
        if (this._titleElement) {
            this._titleElement.textContent = title;
        }
    }

    /**
     * Set sentences for the chapter (does NOT render immediately)
     * @param {string[]} sentences
     * @param {number} [currentIndex=0]
     */
    setSentences(sentences, currentIndex = 0) {
        console.time('ReaderView.setSentences');

        this._sentences = sentences;
        this._currentIndex = currentIndex;
        this._renderedRange = { start: -1, end: -1 };
        this._sentenceElements.clear();

        // Clear existing content
        this._textContent.innerHTML = '';

        if (sentences.length === 0) {
            this._textContent.innerHTML = '<p class="empty-message">No content to display</p>';
            console.timeEnd('ReaderView.setSentences');
            return;
        }

        console.log(`Chapter has ${sentences.length} sentences`);

        // Render initial window around current position
        this._renderWindow(currentIndex);

        console.timeEnd('ReaderView.setSentences');
    }

    /**
     * Render sentences - compatibility method
     * @param {string[]} sentences
     * @param {number} [currentIndex=0]
     */
    renderSentences(sentences, currentIndex = 0) {
        this.setSentences(sentences, currentIndex);
    }

    /**
     * Render a window of sentences around the given index
     * @param {number} centerIndex
     */
    _renderWindow(centerIndex) {
        const start = Math.max(0, centerIndex - this._windowSize);
        const end = Math.min(this._sentences.length, centerIndex + this._windowSize + 1);

        // Check if we need to re-render
        if (start === this._renderedRange.start && end === this._renderedRange.end) {
            return; // Already rendered this range
        }

        console.time('ReaderView._renderWindow');
        console.log(`Rendering window: sentences ${start}-${end} (${end - start} sentences)`);

        // Clear and re-render
        this._textContent.innerHTML = '';
        this._sentenceElements.clear();

        // Add "earlier content" indicator if not at start
        if (start > 0) {
            const indicator = document.createElement('div');
            indicator.className = 'content-indicator';
            indicator.textContent = `↑ ${start} earlier sentences`;
            this._textContent.appendChild(indicator);
        }

        // Render sentences
        const fragment = document.createDocumentFragment();
        let currentParagraph = document.createElement('p');
        currentParagraph.className = 'paragraph';

        for (let i = start; i < end; i++) {
            const sentence = this._sentences[i];

            const span = document.createElement('span');
            span.className = 'sentence';
            span.dataset.index = i.toString();
            span.textContent = sentence + ' ';

            // Mark as played if before current
            if (i < this._currentIndex) {
                span.classList.add('played');
            } else if (i === this._currentIndex) {
                span.classList.add('current');
            }

            this._sentenceElements.set(i, span);
            currentParagraph.appendChild(span);

            // Paragraph breaks every 5-6 sentences
            const endsWithBreak = /[.!?]["']?\s*$/.test(sentence);
            const isParagraphBoundary = (i - start + 1) % 6 === 0;

            if (endsWithBreak && isParagraphBoundary && i < end - 1) {
                fragment.appendChild(currentParagraph);
                currentParagraph = document.createElement('p');
                currentParagraph.className = 'paragraph';
            }
        }

        if (currentParagraph.hasChildNodes()) {
            fragment.appendChild(currentParagraph);
        }

        this._textContent.appendChild(fragment);

        // Add "more content" indicator if not at end
        if (end < this._sentences.length) {
            const indicator = document.createElement('div');
            indicator.className = 'content-indicator';
            indicator.textContent = `↓ ${this._sentences.length - end} more sentences`;
            this._textContent.appendChild(indicator);
        }

        this._renderedRange = { start, end };

        console.timeEnd('ReaderView._renderWindow');
    }

    /**
     * Highlight a specific sentence
     * @param {number} index
     * @param {boolean} [scroll=true] - Whether to scroll to sentence
     */
    highlightSentence(index, scroll = true) {
        // Check if we need to re-render the window
        const needsRerender =
            index < this._renderedRange.start + 10 ||
            index > this._renderedRange.end - 10;

        if (needsRerender && index >= 0 && index < this._sentences.length) {
            this._renderWindow(index);
        }

        // Remove previous highlight
        const prevElement = this._sentenceElements.get(this._currentIndex);
        if (prevElement) {
            prevElement.classList.remove('current');
            prevElement.classList.add('played');
        }

        this._currentIndex = index;

        // Add new highlight
        const element = this._sentenceElements.get(index);
        if (element) {
            element.classList.remove('played');
            element.classList.add('current');

            if (scroll) {
                scrollIntoViewWithOffset(element, this._container, 150);
            }
        }
    }

    /**
     * Clear all highlights
     */
    clearHighlights() {
        for (const el of this._sentenceElements.values()) {
            el.classList.remove('current', 'played');
        }
        this._currentIndex = -1;
    }

    /**
     * Reset played state (for rewind)
     * @param {number} fromIndex - Reset 'played' class from this index onwards
     */
    resetPlayedState(fromIndex) {
        for (const [idx, el] of this._sentenceElements.entries()) {
            if (idx >= fromIndex) {
                el.classList.remove('played');
            }
        }
    }

    /**
     * Get current sentence index
     * @returns {number}
     */
    getCurrentIndex() {
        return this._currentIndex;
    }

    /**
     * Get total sentence count
     * @returns {number}
     */
    getSentenceCount() {
        return this._sentences.length;
    }

    /**
     * Show loading state
     */
    showLoading() {
        this._textContent.innerHTML = `
            <div class="loading">
                <div class="spinner"></div>
                <p>Loading chapter...</p>
            </div>
        `;
    }

    /**
     * Show error state
     * @param {string} message
     */
    showError(message) {
        this._textContent.innerHTML = `
            <div class="error-message">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="12" y1="8" x2="12" y2="12"/>
                    <line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                <span>${message}</span>
            </div>
        `;
    }

    /**
     * Scroll to top of content
     */
    scrollToTop() {
        this._container.scrollTo({ top: 0, behavior: 'smooth' });
    }
}
