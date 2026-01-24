/**
 * Reader View UI Component
 * Handles text display and sentence highlighting
 * Uses chunked rendering for large chapters
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
        this._renderAbortController = null;

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
     * Render sentences with chunked processing
     * @param {string[]} sentences
     * @param {number} [currentIndex=0]
     * @returns {Promise<void>}
     */
    async renderSentences(sentences, currentIndex = 0) {
        // Abort any ongoing render
        if (this._renderAbortController) {
            this._renderAbortController.abort();
        }
        this._renderAbortController = new AbortController();
        const signal = this._renderAbortController.signal;

        this._sentences = sentences;
        this._sentenceElements = new Array(sentences.length);
        this._currentIndex = currentIndex;

        // Clear existing content
        this._textContent.innerHTML = '';

        if (sentences.length === 0) {
            this._textContent.innerHTML = '<p class="empty-message">No content to display</p>';
            return;
        }

        // For small chapters, render synchronously
        if (sentences.length <= 100) {
            this._renderSentencesSync(sentences, currentIndex);
            return;
        }

        // For large chapters, use chunked rendering
        console.log(`Rendering ${sentences.length} sentences in chunks...`);

        // Show loading indicator
        const loadingDiv = document.createElement('div');
        loadingDiv.className = 'render-progress';
        loadingDiv.innerHTML = '<span>Loading chapter...</span>';
        this._textContent.appendChild(loadingDiv);

        const fragment = document.createDocumentFragment();
        let currentParagraph = document.createElement('p');
        currentParagraph.className = 'paragraph';

        const CHUNK_SIZE = 50; // Process 50 sentences per frame
        let processedCount = 0;

        for (let i = 0; i < sentences.length; i += CHUNK_SIZE) {
            if (signal.aborted) return;

            const chunkEnd = Math.min(i + CHUNK_SIZE, sentences.length);

            // Process chunk
            for (let j = i; j < chunkEnd; j++) {
                const sentence = sentences[j];

                // Create sentence span (no individual event listener - using delegation)
                const span = document.createElement('span');
                span.className = 'sentence';
                span.dataset.index = j.toString();
                span.textContent = sentence + ' ';

                this._sentenceElements[j] = span;
                currentParagraph.appendChild(span);

                // Paragraph breaks
                const endsWithBreak = /[.!?]["']?\s*$/.test(sentence);
                const isParagraphBoundary = (j + 1) % 6 === 0;

                if (endsWithBreak && isParagraphBoundary && j < sentences.length - 1) {
                    fragment.appendChild(currentParagraph);
                    currentParagraph = document.createElement('p');
                    currentParagraph.className = 'paragraph';
                }
            }

            processedCount = chunkEnd;

            // Update progress
            const percent = Math.round((processedCount / sentences.length) * 100);
            loadingDiv.innerHTML = `<span>Loading chapter... ${percent}%</span>`;

            // Yield to main thread
            await this._yieldToMain();
        }

        if (signal.aborted) return;

        // Append last paragraph
        if (currentParagraph.hasChildNodes()) {
            fragment.appendChild(currentParagraph);
        }

        // Remove loading indicator and append content
        loadingDiv.remove();
        this._textContent.appendChild(fragment);

        // Highlight current sentence
        if (currentIndex >= 0 && currentIndex < sentences.length) {
            this.highlightSentence(currentIndex, false);
        }

        console.log(`Rendered ${sentences.length} sentences`);
    }

    /**
     * Synchronous render for small chapters
     * @param {string[]} sentences
     * @param {number} currentIndex
     */
    _renderSentencesSync(sentences, currentIndex) {
        const fragment = document.createDocumentFragment();
        let currentParagraph = document.createElement('p');
        currentParagraph.className = 'paragraph';

        sentences.forEach((sentence, index) => {
            const span = document.createElement('span');
            span.className = 'sentence';
            span.dataset.index = index.toString();
            span.textContent = sentence + ' ';

            this._sentenceElements[index] = span;
            currentParagraph.appendChild(span);

            const endsWithBreak = /[.!?]["']?\s*$/.test(sentence);
            const isParagraphBoundary = (index + 1) % 6 === 0;

            if (endsWithBreak && isParagraphBoundary && index < sentences.length - 1) {
                fragment.appendChild(currentParagraph);
                currentParagraph = document.createElement('p');
                currentParagraph.className = 'paragraph';
            }
        });

        if (currentParagraph.hasChildNodes()) {
            fragment.appendChild(currentParagraph);
        }

        this._textContent.appendChild(fragment);

        if (currentIndex >= 0 && currentIndex < sentences.length) {
            this.highlightSentence(currentIndex, false);
        }
    }

    /**
     * Yield to main thread to keep UI responsive
     * @returns {Promise<void>}
     */
    _yieldToMain() {
        return new Promise(resolve => {
            if ('requestIdleCallback' in window) {
                requestIdleCallback(resolve, { timeout: 50 });
            } else {
                setTimeout(resolve, 0);
            }
        });
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
            if (prevElement) {
                prevElement.classList.remove('current');
                prevElement.classList.add('played');
            }
        }

        this._currentIndex = index;

        // Add new highlight
        if (index >= 0 && index < this._sentenceElements.length) {
            const element = this._sentenceElements[index];
            if (element) {
                element.classList.remove('played');
                element.classList.add('current');

                // Scroll into view
                if (scroll) {
                    scrollIntoViewWithOffset(element, this._container, 150);
                }
            }
        }
    }

    /**
     * Clear all highlights
     */
    clearHighlights() {
        this._sentenceElements.forEach(el => {
            if (el) el.classList.remove('current', 'played');
        });
        this._currentIndex = -1;
    }

    /**
     * Reset played state (for rewind)
     * @param {number} fromIndex - Reset 'played' class from this index onwards
     */
    resetPlayedState(fromIndex) {
        for (let i = fromIndex; i < this._sentenceElements.length; i++) {
            if (this._sentenceElements[i]) {
                this._sentenceElements[i].classList.remove('played');
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
