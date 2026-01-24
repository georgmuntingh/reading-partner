/**
 * Reader View UI Component
 * Handles text display and sentence highlighting
 * Displays full EPUB HTML with embedded sentence spans for highlighting
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
        this._html = null; // Full HTML content

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
     * Set content for the chapter - supports both HTML and sentences-only mode
     * @param {string[]} sentences
     * @param {number} [currentIndex=0]
     * @param {string|null} [html=null] - Full HTML content with sentence spans
     */
    setSentences(sentences, currentIndex = 0, html = null) {
        console.time('ReaderView.setSentences');

        this._sentences = sentences;
        this._currentIndex = currentIndex;
        this._html = html;

        // Clear existing content
        this._textContent.innerHTML = '';

        if (sentences.length === 0) {
            this._textContent.innerHTML = '<p class="empty-message">No content to display</p>';
            console.timeEnd('ReaderView.setSentences');
            return;
        }

        console.log(`Chapter has ${sentences.length} sentences, HTML mode: ${!!html}`);

        if (html) {
            // Render full HTML with embedded sentence spans
            this._renderHtml(html, currentIndex);
        } else {
            // Fallback to sentences-only rendering
            this._renderSentencesOnly(sentences, currentIndex);
        }

        console.timeEnd('ReaderView.setSentences');
    }

    /**
     * Render sentences - compatibility method
     * @param {string[]} sentences
     * @param {number} [currentIndex=0]
     * @param {string|null} [html=null]
     */
    renderSentences(sentences, currentIndex = 0, html = null) {
        this.setSentences(sentences, currentIndex, html);
    }

    /**
     * Render full HTML content with embedded sentence spans
     * @param {string} html
     * @param {number} currentIndex
     */
    _renderHtml(html, currentIndex) {
        console.time('ReaderView._renderHtml');

        // Set the HTML content
        this._textContent.innerHTML = html;

        // Find all sentence elements and update their state
        const sentenceElements = this._textContent.querySelectorAll('.sentence[data-index]');
        console.log(`Found ${sentenceElements.length} sentence elements in HTML`);

        sentenceElements.forEach(el => {
            const index = parseInt(el.dataset.index, 10);

            // Mark as played if before current
            if (index < currentIndex) {
                el.classList.add('played');
            } else if (index === currentIndex) {
                el.classList.add('current');
            }
        });

        // Scroll to current sentence if needed
        if (currentIndex >= 0 && currentIndex < this._sentences.length) {
            const currentEl = this._textContent.querySelector(`.sentence[data-index="${currentIndex}"]`);
            if (currentEl) {
                setTimeout(() => {
                    scrollIntoViewWithOffset(currentEl, this._container, 150);
                }, 100);
            }
        }

        console.timeEnd('ReaderView._renderHtml');
    }

    /**
     * Fallback: Render sentences only (no HTML)
     * @param {string[]} sentences
     * @param {number} currentIndex
     */
    _renderSentencesOnly(sentences, currentIndex) {
        console.time('ReaderView._renderSentencesOnly');

        const fragment = document.createDocumentFragment();
        let currentParagraph = document.createElement('p');
        currentParagraph.className = 'paragraph';

        for (let i = 0; i < sentences.length; i++) {
            const sentence = sentences[i];

            const span = document.createElement('span');
            span.className = 'sentence';
            span.dataset.index = i.toString();
            span.textContent = sentence + ' ';

            // Mark as played if before current
            if (i < currentIndex) {
                span.classList.add('played');
            } else if (i === currentIndex) {
                span.classList.add('current');
            }

            currentParagraph.appendChild(span);

            // Paragraph breaks every 5-6 sentences
            const endsWithBreak = /[.!?]["']?\s*$/.test(sentence);
            const isParagraphBoundary = (i + 1) % 6 === 0;

            if (endsWithBreak && isParagraphBoundary && i < sentences.length - 1) {
                fragment.appendChild(currentParagraph);
                currentParagraph = document.createElement('p');
                currentParagraph.className = 'paragraph';
            }
        }

        if (currentParagraph.hasChildNodes()) {
            fragment.appendChild(currentParagraph);
        }

        this._textContent.appendChild(fragment);

        console.timeEnd('ReaderView._renderSentencesOnly');
    }

    /**
     * Highlight a specific sentence
     * @param {number} index
     * @param {boolean} [scroll=true] - Whether to scroll to sentence
     */
    highlightSentence(index, scroll = true) {
        // Remove previous highlight
        const prevElement = this._textContent.querySelector(`.sentence[data-index="${this._currentIndex}"]`);
        if (prevElement) {
            prevElement.classList.remove('current');
            prevElement.classList.add('played');
        }

        this._currentIndex = index;

        // Add new highlight
        const element = this._textContent.querySelector(`.sentence[data-index="${index}"]`);
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
        const sentenceElements = this._textContent.querySelectorAll('.sentence');
        sentenceElements.forEach(el => {
            el.classList.remove('current', 'played');
        });
        this._currentIndex = -1;
    }

    /**
     * Reset played state (for rewind)
     * @param {number} fromIndex - Reset 'played' class from this index onwards
     */
    resetPlayedState(fromIndex) {
        const sentenceElements = this._textContent.querySelectorAll('.sentence[data-index]');
        sentenceElements.forEach(el => {
            const idx = parseInt(el.dataset.index, 10);
            if (idx >= fromIndex) {
                el.classList.remove('played');
            }
        });
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
