/**
 * Reader View UI Component
 * Handles text display with pagination and sentence highlighting
 * Displays full EPUB HTML with embedded sentence spans for highlighting
 */

import { debounce } from '../utils/helpers.js';

export class ReaderView {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.container - The reader content container
     * @param {HTMLElement} options.titleElement - Chapter title element
     * @param {HTMLElement} options.bookTitleElement - Book title element
     * @param {(index: number) => void} options.onSentenceClick - Callback when sentence is clicked
     * @param {() => void} [options.onPageChange] - Callback when page changes
     * @param {(href: string) => void} [options.onLinkClick] - Callback when an internal EPUB link is clicked
     * @param {(src: string, alt: string) => void} [options.onImageClick] - Callback when an image is clicked
     * @param {(startIndex: number, endIndex: number, text: string) => void} [options.onHighlight] - Callback when user highlights text
     */
    constructor({ container, titleElement, bookTitleElement, onSentenceClick, onPageChange, onLinkClick, onImageClick, onHighlight }) {
        this._container = container;
        this._titleElement = titleElement;
        this._bookTitleElement = bookTitleElement;
        this._onSentenceClick = onSentenceClick;
        this._onPageChange = onPageChange;
        this._onLinkClick = onLinkClick;
        this._onImageClick = onImageClick;
        this._onHighlight = onHighlight;

        this._textContent = container.querySelector('#text-content') || container;
        this._pageContainer = container.querySelector('#page-container');
        this._prevBtn = container.querySelector('#page-prev-btn');
        this._nextBtn = container.querySelector('#page-next-btn');
        this._pageCurrentEl = container.querySelector('#page-current');
        this._pageTotalEl = container.querySelector('#page-total');

        this._sentences = [];
        this._currentIndex = -1;
        this._html = null; // Full HTML content
        this._highlights = []; // Stored highlights for current chapter

        // Pagination state
        this._currentPage = 0;
        this._totalPages = 1;
        this._pageHeight = 0; // Calculated page height
        this._sentenceToPage = new Map(); // Maps sentence index to page number
        this._pageToSentences = new Map(); // Maps page number to array of sentence indices
        this._isCalculatingPages = false;

        // Highlight toolbar
        this._highlightToolbar = null;
        this._createHighlightToolbar();

        // Use event delegation for click handling
        this._setupEventDelegation();
        this._setupPageNavigation();
        this._setupResizeHandler();
        this._setupTextSelection();
    }

    /**
     * Setup event delegation for sentence clicks, image clicks, and internal link interception
     */
    _setupEventDelegation() {
        this._textContent.addEventListener('click', (e) => {
            // Check for image clicks first (before links, as images might be inside links)
            const imgEl = e.target.closest('img');
            if (imgEl && imgEl.src) {
                e.preventDefault();
                const alt = imgEl.alt || '';
                this._onImageClick?.(imgEl.src, alt);
                return;
            }

            // Check for link clicks
            const linkEl = e.target.closest('a[href]');
            if (linkEl) {
                const href = linkEl.getAttribute('href');
                if (href) {
                    // Let mailto/tel links behave normally
                    if (href.startsWith('mailto:') || href.startsWith('tel:')) {
                        return;
                    }
                    // Open external links in a new tab
                    if (href.startsWith('http://') || href.startsWith('https://')) {
                        e.preventDefault();
                        window.open(href, '_blank', 'noopener,noreferrer');
                        return;
                    }
                    // Intercept internal EPUB links
                    e.preventDefault();
                    this._onLinkClick?.(href);
                    return;
                }
            }

            const sentenceEl = e.target.closest('.sentence');
            if (sentenceEl && sentenceEl.dataset.index !== undefined) {
                const index = parseInt(sentenceEl.dataset.index, 10);
                this._onSentenceClick?.(index);
            }
        });
    }

    /**
     * Setup page navigation button handlers
     */
    _setupPageNavigation() {
        if (this._prevBtn) {
            this._prevBtn.addEventListener('click', () => this.previousPage());
        }
        if (this._nextBtn) {
            this._nextBtn.addEventListener('click', () => this.nextPage());
        }
    }

    /**
     * Setup resize handler to recalculate pages
     */
    _setupResizeHandler() {
        this._debouncedRecalculate = debounce(() => {
            if (this._sentences.length > 0 || this._html) {
                this._recalculatePages();
            }
        }, 250);

        window.addEventListener('resize', this._debouncedRecalculate);
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
        this._currentPage = 0;

        // Clear existing content
        this._textContent.innerHTML = '';

        if (sentences.length === 0 && !html) {
            this._textContent.innerHTML = '<p class="empty-message">No content to display</p>';
            this._updatePageIndicator();
            console.timeEnd('ReaderView.setSentences');
            return;
        }

        console.log(`Chapter has ${sentences.length} sentences, HTML mode: ${!!html}`);

        if (html) {
            // Render full HTML with embedded sentence spans (also used for image-only chapters)
            this._renderHtml(html, currentIndex);
        } else {
            // Fallback to sentences-only rendering
            this._renderSentencesOnly(sentences, currentIndex);
        }

        // Calculate pagination after content is rendered
        // Use double requestAnimationFrame to ensure layout is complete
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                this._calculatePages();
                // Navigate to page containing current sentence
                if (currentIndex > 0) {
                    const page = this._sentenceToPage.get(currentIndex);
                    if (page !== undefined) {
                        this._goToPageInternal(page, false);
                    }
                }
            });
        });

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
     * Calculate page boundaries based on container height
     */
    _calculatePages() {
        if (this._isCalculatingPages) return;
        this._isCalculatingPages = true;

        console.time('ReaderView._calculatePages');

        // Use page container height as the reference (it's constrained by flexbox)
        // Fall back to text content if page container isn't available
        const referenceContainer = this._pageContainer || this._textContent.parentElement || this._textContent;
        let pageHeight = referenceContainer.clientHeight;

        // Get the full content height
        const scrollHeight = this._textContent.scrollHeight;

        console.log(`Page calculation: container=${pageHeight}px, content=${scrollHeight}px`);

        // If container height is 0 or not properly constrained, use a sensible default
        // based on viewport height minus header/footer/padding (~400px for UI elements)
        if (pageHeight <= 0 || pageHeight >= scrollHeight) {
            pageHeight = Math.max(300, window.innerHeight - 400);
            console.log(`Using fallback page height: ${pageHeight}px`);
        }

        // Reset pagination state
        this._sentenceToPage = new Map();
        this._pageToSentences = new Map();
        this._pageHeight = pageHeight; // Store for use in navigation

        const sentenceElements = this._textContent.querySelectorAll('.sentence[data-index]');
        if (sentenceElements.length === 0) {
            // Still calculate total pages from scroll height for image-only chapters
            // Add tolerance: if content is within 20px of page boundary, don't count extra page
            const pageRatio = scrollHeight / pageHeight;
            const fractionalPart = pageRatio % 1;
            this._totalPages = fractionalPart < 0.05 ? Math.floor(pageRatio) : Math.ceil(pageRatio);
            this._totalPages = Math.max(1, this._totalPages);
            this._updatePageIndicator();
            this._updatePageButtons();
            this._isCalculatingPages = false;
            console.log(`No sentence elements; ${this._totalPages} pages from content height (${scrollHeight}px)`);
            console.timeEnd('ReaderView._calculatePages');
            return;
        }

        // Calculate total pages with tolerance for small overflow
        // If content is within 5% of a page boundary, don't count it as an extra page
        const pageRatio = scrollHeight / pageHeight;
        const fractionalPart = pageRatio % 1;
        this._totalPages = fractionalPart < 0.05 ? Math.floor(pageRatio) : Math.ceil(pageRatio);
        this._totalPages = Math.max(1, this._totalPages);

        // Map each sentence to a page based on its position
        sentenceElements.forEach(el => {
            const index = parseInt(el.dataset.index, 10);
            const elementTop = el.offsetTop;
            const page = Math.floor(elementTop / pageHeight);

            this._sentenceToPage.set(index, page);

            if (!this._pageToSentences.has(page)) {
                this._pageToSentences.set(page, []);
            }
            this._pageToSentences.get(page).push(index);
        });

        // Ensure total pages is at least the max page number + 1
        const maxPage = Math.max(...this._sentenceToPage.values(), 0);
        this._totalPages = Math.max(this._totalPages, maxPage + 1);

        console.log(`Calculated ${this._totalPages} pages for ${sentenceElements.length} sentences (pageHeight=${pageHeight}px)`);
        console.timeEnd('ReaderView._calculatePages');

        this._updatePageIndicator();
        this._updatePageButtons();
        this._isCalculatingPages = false;
    }

    /**
     * Recalculate pages (e.g., after resize)
     */
    _recalculatePages() {
        const currentSentence = this._currentIndex;
        this._calculatePages();

        // Navigate to page containing current sentence
        if (currentSentence >= 0) {
            const page = this._sentenceToPage.get(currentSentence);
            if (page !== undefined && page !== this._currentPage) {
                this._goToPageInternal(page, false);
            }
        }
    }

    /**
     * Go to a specific page
     * @param {number} pageNumber - 0-indexed page number
     */
    goToPage(pageNumber) {
        this._goToPageInternal(pageNumber, true);
    }

    /**
     * Internal page navigation
     * @param {number} pageNumber
     * @param {boolean} triggerCallback
     */
    _goToPageInternal(pageNumber, triggerCallback = true) {
        const targetPage = Math.max(0, Math.min(pageNumber, this._totalPages - 1));

        if (targetPage === this._currentPage && this._totalPages > 1) {
            return;
        }

        this._currentPage = targetPage;

        // Scroll to the correct position using stored page height
        const pageHeight = this._pageHeight || this._textContent.clientHeight;
        const scrollTop = targetPage * pageHeight;
        this._textContent.scrollTop = scrollTop;

        this._updatePageIndicator();
        this._updatePageButtons();

        if (triggerCallback) {
            this._onPageChange?.();
        }
    }

    /**
     * Go to next page
     * @returns {boolean} Whether navigation occurred
     */
    nextPage() {
        if (this._currentPage < this._totalPages - 1) {
            this._goToPageInternal(this._currentPage + 1);
            return true;
        }
        return false;
    }

    /**
     * Go to previous page
     * @returns {boolean} Whether navigation occurred
     */
    previousPage() {
        if (this._currentPage > 0) {
            this._goToPageInternal(this._currentPage - 1);
            return true;
        }
        return false;
    }

    /**
     * Go to the first page
     * @returns {boolean} Whether navigation occurred
     */
    firstPage() {
        if (this._currentPage > 0) {
            this._goToPageInternal(0);
            return true;
        }
        return false;
    }

    /**
     * Go to the last page
     * @returns {boolean} Whether navigation occurred
     */
    lastPage() {
        if (this._currentPage < this._totalPages - 1) {
            this._goToPageInternal(this._totalPages - 1);
            return true;
        }
        return false;
    }

    /**
     * Get current page (0-indexed)
     * @returns {number}
     */
    getCurrentPage() {
        return this._currentPage;
    }

    /**
     * Get total pages
     * @returns {number}
     */
    getTotalPages() {
        return this._totalPages;
    }

    /**
     * Update page indicator display
     */
    _updatePageIndicator() {
        if (this._pageCurrentEl) {
            this._pageCurrentEl.textContent = (this._currentPage + 1).toString();
        }
        if (this._pageTotalEl) {
            this._pageTotalEl.textContent = this._totalPages.toString();
        }
    }

    /**
     * Update page navigation button states
     */
    _updatePageButtons() {
        if (this._prevBtn) {
            this._prevBtn.disabled = this._currentPage <= 0;
        }
        if (this._nextBtn) {
            this._nextBtn.disabled = this._currentPage >= this._totalPages - 1;
        }
    }

    /**
     * Navigate to page containing a specific sentence
     * @param {number} sentenceIndex
     * @returns {boolean} Whether page change occurred
     */
    _navigateToSentencePage(sentenceIndex) {
        const page = this._sentenceToPage.get(sentenceIndex);
        if (page !== undefined && page !== this._currentPage) {
            this._goToPageInternal(page, false);
            return true;
        }
        return false;
    }

    /**
     * Highlight a specific sentence
     * @param {number} index
     * @param {boolean} [scroll=true] - Whether to navigate to page containing sentence
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
                // Navigate to page containing this sentence
                this._navigateToSentencePage(index);
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
        this._totalPages = 1;
        this._currentPage = 0;
        this._updatePageIndicator();
        this._updatePageButtons();
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
        this._totalPages = 1;
        this._currentPage = 0;
        this._updatePageIndicator();
        this._updatePageButtons();
    }

    /**
     * Scroll to top of content (go to first page)
     */
    scrollToTop() {
        this._goToPageInternal(0, false);
    }

    /**
     * Scroll to an element with the given ID (for internal EPUB link targets)
     * @param {string} fragmentId - The element ID to scroll to
     * @returns {boolean} Whether the element was found and scrolled to
     */
    scrollToFragment(fragmentId) {
        if (!fragmentId) return false;

        try {
            const target = this._textContent.querySelector(`[id="${CSS.escape(fragmentId)}"]`);
            if (target) {
                // Calculate which page this element is on
                const elementTop = target.offsetTop;
                const pageHeight = this._pageHeight || this._textContent.clientHeight;
                if (pageHeight > 0) {
                    const page = Math.floor(elementTop / pageHeight);
                    this._goToPageInternal(page, false);
                }

                // Briefly highlight the target element
                target.classList.add('link-target');
                setTimeout(() => target.classList.remove('link-target'), 2000);

                return true;
            }
        } catch (e) {
            console.warn('Failed to scroll to fragment:', fragmentId, e);
        }
        return false;
    }

    // ========== Selection Support ==========

    /**
     * Get the text of the currently selected sentences, if any true selection exists.
     * Returns null if there is no selection or the selection is collapsed (just a click position).
     * @returns {string[]|null} Array of selected sentence texts, or null
     */
    getSelectedSentenceTexts() {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
            return null;
        }

        const range = selection.getRangeAt(0);
        if (!this._textContent.contains(range.startContainer) || !this._textContent.contains(range.endContainer)) {
            return null;
        }

        const startSentence = this._findSentenceElement(range.startContainer);
        const endSentence = this._findSentenceElement(range.endContainer);
        if (!startSentence || !endSentence) {
            return null;
        }

        const startIndex = parseInt(startSentence.dataset.index, 10);
        const endIndex = parseInt(endSentence.dataset.index, 10);

        // Collect sentence texts from the stored sentences array
        const sentences = [];
        for (let i = startIndex; i <= endIndex; i++) {
            if (i >= 0 && i < this._sentences.length) {
                sentences.push(this._sentences[i]);
            }
        }

        return sentences.length > 0 ? sentences : null;
    }

    // ========== Highlight Support ==========

    /**
     * Create the floating highlight toolbar element
     */
    _createHighlightToolbar() {
        this._highlightToolbar = document.createElement('div');
        this._highlightToolbar.className = 'highlight-toolbar hidden';
        this._highlightToolbar.innerHTML = `
            <button class="highlight-btn highlight-btn-yellow" data-color="yellow" title="Highlight yellow">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                    <path d="M15.243 3.515l5.242 5.242-12.02 12.02H3.222v-5.243l12.02-12.02zm1.414-1.414l2.829 2.828-1.415 1.414-2.828-2.828 1.414-1.414z"/>
                </svg>
            </button>
            <button class="highlight-btn highlight-btn-green" data-color="green" title="Highlight green">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                    <path d="M15.243 3.515l5.242 5.242-12.02 12.02H3.222v-5.243l12.02-12.02zm1.414-1.414l2.829 2.828-1.415 1.414-2.828-2.828 1.414-1.414z"/>
                </svg>
            </button>
            <button class="highlight-btn highlight-btn-blue" data-color="blue" title="Highlight blue">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                    <path d="M15.243 3.515l5.242 5.242-12.02 12.02H3.222v-5.243l12.02-12.02zm1.414-1.414l2.829 2.828-1.415 1.414-2.828-2.828 1.414-1.414z"/>
                </svg>
            </button>
            <button class="highlight-btn highlight-btn-pink" data-color="pink" title="Highlight pink">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                    <path d="M15.243 3.515l5.242 5.242-12.02 12.02H3.222v-5.243l12.02-12.02zm1.414-1.414l2.829 2.828-1.415 1.414-2.828-2.828 1.414-1.414z"/>
                </svg>
            </button>
        `;
        document.body.appendChild(this._highlightToolbar);

        // Handle highlight button clicks
        this._highlightToolbar.addEventListener('mousedown', (e) => {
            // Prevent text deselection
            e.preventDefault();
        });
        this._highlightToolbar.addEventListener('click', (e) => {
            const btn = e.target.closest('.highlight-btn');
            if (btn) {
                const color = btn.dataset.color;
                this._createHighlightFromSelection(color);
            }
        });
    }

    /**
     * Setup text selection handler for highlighting
     */
    _setupTextSelection() {
        document.addEventListener('selectionchange', () => {
            this._handleSelectionChange();
        });

        // Hide toolbar when clicking outside
        document.addEventListener('mousedown', (e) => {
            if (!this._highlightToolbar.contains(e.target) && !this._textContent.contains(e.target)) {
                this._hideHighlightToolbar();
            }
        });
    }

    /**
     * Handle text selection changes
     */
    _handleSelectionChange() {
        const selection = window.getSelection();

        if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
            // Delay hiding to allow toolbar button clicks
            this._hideToolbarTimeout = setTimeout(() => {
                this._hideHighlightToolbar();
            }, 200);
            return;
        }

        // Check if selection is within our text content
        const range = selection.getRangeAt(0);
        if (!this._textContent.contains(range.startContainer) || !this._textContent.contains(range.endContainer)) {
            return;
        }

        // Find sentence elements in the selection
        const startSentence = this._findSentenceElement(range.startContainer);
        const endSentence = this._findSentenceElement(range.endContainer);

        if (!startSentence || !endSentence) {
            return;
        }

        // Clear any pending hide
        if (this._hideToolbarTimeout) {
            clearTimeout(this._hideToolbarTimeout);
            this._hideToolbarTimeout = null;
        }

        // Position and show the toolbar
        const rect = range.getBoundingClientRect();
        this._showHighlightToolbar(rect);
    }

    /**
     * Find the parent sentence element for a node
     * @param {Node} node
     * @returns {HTMLElement|null}
     */
    _findSentenceElement(node) {
        let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
        while (el && el !== this._textContent) {
            if (el.classList && el.classList.contains('sentence') && el.dataset.index !== undefined) {
                return el;
            }
            el = el.parentElement;
        }
        return null;
    }

    /**
     * Show the highlight toolbar near the selection
     * @param {DOMRect} selectionRect
     */
    _showHighlightToolbar(selectionRect) {
        const toolbar = this._highlightToolbar;
        toolbar.classList.remove('hidden');

        // Position above the selection
        const toolbarHeight = toolbar.offsetHeight;
        const toolbarWidth = toolbar.offsetWidth;

        let top = selectionRect.top - toolbarHeight - 8 + window.scrollY;
        let left = selectionRect.left + (selectionRect.width / 2) - (toolbarWidth / 2) + window.scrollX;

        // Keep within viewport
        if (top < window.scrollY + 4) {
            top = selectionRect.bottom + 8 + window.scrollY;
        }
        left = Math.max(4, Math.min(left, window.innerWidth - toolbarWidth - 4));

        toolbar.style.top = `${top}px`;
        toolbar.style.left = `${left}px`;
    }

    /**
     * Hide the highlight toolbar
     */
    _hideHighlightToolbar() {
        this._highlightToolbar.classList.add('hidden');
    }

    /**
     * Create a highlight from the current text selection
     * @param {string} color
     */
    _createHighlightFromSelection(color = 'yellow') {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
            return;
        }

        const range = selection.getRangeAt(0);
        const startSentence = this._findSentenceElement(range.startContainer);
        const endSentence = this._findSentenceElement(range.endContainer);

        if (!startSentence || !endSentence) {
            return;
        }

        const startIndex = parseInt(startSentence.dataset.index, 10);
        const endIndex = parseInt(endSentence.dataset.index, 10);
        const text = selection.toString().trim();

        if (!text) return;

        // Apply visual highlight immediately
        this._applyHighlightToSentences(startIndex, endIndex, color);

        // Clear selection and hide toolbar
        selection.removeAllRanges();
        this._hideHighlightToolbar();

        // Notify callback
        this._onHighlight?.(startIndex, endIndex, text, color);
    }

    /**
     * Apply visual highlight to sentence elements
     * @param {number} startIndex
     * @param {number} endIndex
     * @param {string} color
     */
    _applyHighlightToSentences(startIndex, endIndex, color = 'yellow') {
        for (let i = startIndex; i <= endIndex; i++) {
            const el = this._textContent.querySelector(`.sentence[data-index="${i}"]`);
            if (el) {
                el.classList.add('user-highlight', `highlight-${color}`);
            }
        }
    }

    /**
     * Remove visual highlight from sentence elements
     * @param {number} startIndex
     * @param {number} endIndex
     */
    _removeHighlightFromSentences(startIndex, endIndex) {
        for (let i = startIndex; i <= endIndex; i++) {
            const el = this._textContent.querySelector(`.sentence[data-index="${i}"]`);
            if (el) {
                el.classList.remove('user-highlight', 'highlight-yellow', 'highlight-green', 'highlight-blue', 'highlight-pink');
            }
        }
    }

    /**
     * Set highlights for the current chapter and apply them visually
     * @param {Object[]} highlights - Array of highlight objects
     */
    setHighlights(highlights) {
        this._highlights = highlights;
        this._applyAllHighlights();
    }

    /**
     * Apply all stored highlights to the rendered content
     */
    _applyAllHighlights() {
        // Remove any existing user highlights
        const existingHighlights = this._textContent.querySelectorAll('.user-highlight');
        existingHighlights.forEach(el => {
            el.classList.remove('user-highlight', 'highlight-yellow', 'highlight-green', 'highlight-blue', 'highlight-pink');
        });

        // Apply stored highlights
        for (const highlight of this._highlights) {
            this._applyHighlightToSentences(
                highlight.startSentenceIndex,
                highlight.endSentenceIndex,
                highlight.color || 'yellow'
            );
        }
    }

    /**
     * Cleanup event listeners
     */
    destroy() {
        window.removeEventListener('resize', this._debouncedRecalculate);
        if (this._highlightToolbar) {
            this._highlightToolbar.remove();
        }
        if (this._hideToolbarTimeout) {
            clearTimeout(this._hideToolbarTimeout);
        }
    }
}
