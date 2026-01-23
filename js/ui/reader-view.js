/**
 * Reader View UI Component
 * Handles text display and sentence highlighting
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
        this._sentenceElements = [];
        this._currentIndex = -1;
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
     * Render sentences
     * @param {string[]} sentences
     * @param {number} [currentIndex=0]
     */
    renderSentences(sentences, currentIndex = 0) {
        this._sentences = sentences;
        this._sentenceElements = [];
        this._currentIndex = currentIndex;

        // Clear existing content
        this._textContent.innerHTML = '';

        if (sentences.length === 0) {
            this._textContent.innerHTML = '<p class="empty-message">No content to display</p>';
            return;
        }

        // Group sentences into paragraphs (simple heuristic: ~5 sentences per paragraph)
        // Or detect paragraph breaks if they exist in the text
        const fragment = document.createDocumentFragment();
        let currentParagraph = document.createElement('p');
        currentParagraph.className = 'paragraph';

        sentences.forEach((sentence, index) => {
            // Create sentence span
            const span = document.createElement('span');
            span.className = 'sentence';
            span.dataset.index = index.toString();
            span.textContent = sentence + ' ';

            // Add click handler
            span.addEventListener('click', () => {
                this._onSentenceClick?.(index);
            });

            this._sentenceElements.push(span);
            currentParagraph.appendChild(span);

            // Start new paragraph after sentences ending with significant breaks
            // or every ~5-7 sentences for readability
            const endsWithBreak = /[.!?]["']?\s*$/.test(sentence);
            const isParagraphBoundary = (index + 1) % 6 === 0;

            if (endsWithBreak && isParagraphBoundary && index < sentences.length - 1) {
                fragment.appendChild(currentParagraph);
                currentParagraph = document.createElement('p');
                currentParagraph.className = 'paragraph';
            }
        });

        // Append last paragraph if it has content
        if (currentParagraph.hasChildNodes()) {
            fragment.appendChild(currentParagraph);
        }

        this._textContent.appendChild(fragment);

        // Highlight current sentence
        if (currentIndex >= 0 && currentIndex < sentences.length) {
            this.highlightSentence(currentIndex, false); // Don't scroll on initial render
        }
    }

    /**
     * Highlight a specific sentence
     * @param {number} index
     * @param {boolean} [scroll=true] - Whether to scroll to sentence
     */
    highlightSentence(index, scroll = true) {
        // Remove previous highlight
        if (this._currentIndex >= 0 && this._currentIndex < this._sentenceElements.length) {
            const prevElement = this._sentenceElements[this._currentIndex];
            prevElement.classList.remove('current');
            prevElement.classList.add('played');
        }

        this._currentIndex = index;

        // Add new highlight
        if (index >= 0 && index < this._sentenceElements.length) {
            const element = this._sentenceElements[index];
            element.classList.remove('played');
            element.classList.add('current');

            // Remove 'played' class from sentences after current
            for (let i = index + 1; i < this._sentenceElements.length; i++) {
                this._sentenceElements[i].classList.remove('played');
            }

            // Scroll into view
            if (scroll) {
                scrollIntoViewWithOffset(element, this._container, 150);
            }
        }
    }

    /**
     * Clear all highlights
     */
    clearHighlights() {
        this._sentenceElements.forEach(el => {
            el.classList.remove('current', 'played');
        });
        this._currentIndex = -1;
    }

    /**
     * Reset played state (for rewind)
     * @param {number} fromIndex - Reset 'played' class from this index onwards
     */
    resetPlayedState(fromIndex) {
        for (let i = fromIndex; i < this._sentenceElements.length; i++) {
            this._sentenceElements[i].classList.remove('played');
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
