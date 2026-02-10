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
     * @param {() => void} [options.onPrevChapter] - Callback when navigating to previous chapter
     * @param {() => void} [options.onNextChapter] - Callback when navigating to next chapter
     */
    constructor({ container, titleElement, bookTitleElement, onSentenceClick, onPageChange, onLinkClick, onImageClick, onHighlight, onPrevChapter, onNextChapter }) {
        this._container = container;
        this._titleElement = titleElement;
        this._bookTitleElement = bookTitleElement;
        this._onSentenceClick = onSentenceClick;
        this._onPageChange = onPageChange;
        this._onLinkClick = onLinkClick;
        this._onImageClick = onImageClick;
        this._onHighlight = onHighlight;
        this._onPrevChapter = onPrevChapter;
        this._onNextChapter = onNextChapter;

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

        // Chapter boundary state
        this._isFirstChapter = true;
        this._isLastChapter = true;
        this._prevBtnMode = 'page'; // 'page' or 'chapter'
        this._nextBtnMode = 'page'; // 'page' or 'chapter'
        this._pendingGoToLastPage = false; // Set before rendering to jump to last page after layout

        // SVG icons for page vs chapter navigation buttons
        this._PAGE_ARROW_SVG = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>';
        this._PAGE_ARROW_SVG_NEXT = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>';
        this._CHAPTER_ARROW_SVG = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 18 11 12 17 6"/><line x1="7" y1="6" x2="7" y2="18"/></svg>';
        this._CHAPTER_ARROW_SVG_NEXT = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="7 18 13 12 7 6"/><line x1="17" y1="6" x2="17" y2="18"/></svg>';

        // Multi-column state
        this._columnCount = 1;
        this._columnAutoCenter = true;
        this._multiColumnContainer = null;
        this._columnViewports = [];
        this._visiblePages = []; // Array of page numbers currently visible in columns
        this._MIN_COLUMN_WIDTH = 250; // Minimum column width in px

        // Highlight toolbar
        this._highlightToolbar = null;
        this._createHighlightToolbar();

        // Touch/swipe state
        this._touchStartX = 0;
        this._touchStartY = 0;
        this._touchStartTime = 0;
        this._isSwiping = false;

        // Use event delegation for click handling
        this._setupEventDelegation();
        this._setupPageNavigation();
        this._setupResizeHandler();
        this._setupTextSelection();
        this._setupMultiColumnContainer();
        this._setupSwipeNavigation();
    }

    // ========== Multi-Column Support ==========

    /**
     * Create the multi-column container structure
     */
    _setupMultiColumnContainer() {
        this._multiColumnContainer = document.createElement('div');
        this._multiColumnContainer.className = 'multi-column-container multi-column-inactive';
        // Insert after textContent in the page container
        this._textContent.parentElement.insertBefore(this._multiColumnContainer, this._textContent.nextSibling);

        // Event delegation for cloned column viewports
        this._multiColumnContainer.addEventListener('click', (e) => {
            // Check for image clicks
            const imgEl = e.target.closest('img');
            if (imgEl && imgEl.src) {
                e.preventDefault();
                this._onImageClick?.(imgEl.src, imgEl.alt || '');
                return;
            }

            // Check for link clicks
            const linkEl = e.target.closest('a[href]');
            if (linkEl) {
                const href = linkEl.getAttribute('href');
                if (href) {
                    if (href.startsWith('mailto:') || href.startsWith('tel:')) return;
                    if (href.startsWith('http://') || href.startsWith('https://')) {
                        e.preventDefault();
                        window.open(href, '_blank', 'noopener,noreferrer');
                        return;
                    }
                    e.preventDefault();
                    this._onLinkClick?.(href);
                    return;
                }
            }

            // Check for sentence clicks
            const sentenceEl = e.target.closest('.sentence');
            if (sentenceEl && sentenceEl.dataset.index !== undefined) {
                const index = parseInt(sentenceEl.dataset.index, 10);
                this._onSentenceClick?.(index);
            }
        });
    }

    /**
     * Set the number of visible columns
     * @param {number} count - Number of columns (1-5)
     */
    setColumnCount(count) {
        const newCount = Math.max(1, Math.min(5, count));
        if (newCount === this._columnCount) return;
        this._columnCount = newCount;
        this._updateMultiColumnMode();
    }

    /**
     * Set whether active page auto-centers in columns
     * @param {boolean} autoCenter
     */
    setColumnAutoCenter(autoCenter) {
        this._columnAutoCenter = autoCenter;
        if (this._columnCount > 1) {
            this._updateMultiColumnDisplay();
        }
    }

    /**
     * Get current column count
     * @returns {number}
     */
    getColumnCount() {
        return this._columnCount;
    }

    /**
     * Calculate the effective number of columns based on available width
     * @returns {number}
     */
    _getEffectiveColumnCount() {
        if (this._columnCount <= 1) return 1;
        const containerWidth = this._pageContainer?.clientWidth || window.innerWidth;
        const maxColumns = Math.floor(containerWidth / this._MIN_COLUMN_WIDTH);
        return Math.max(1, Math.min(this._columnCount, maxColumns));
    }

    /**
     * Update multi-column mode (show/hide containers, recalculate display)
     */
    _updateMultiColumnMode() {
        const effectiveColumns = this._getEffectiveColumnCount();

        if (effectiveColumns <= 1) {
            // Single column mode: show textContent, hide multi-column container
            this._textContent.classList.remove('multi-column-hidden');
            this._multiColumnContainer.classList.add('multi-column-inactive');
            this._columnViewports = [];
            // Restore scroll position for current page
            this._goToPageInternal(this._currentPage, false);
        } else {
            // Multi-column mode: hide textContent scrolling, show multi-column container
            this._textContent.classList.add('multi-column-hidden');
            this._multiColumnContainer.classList.remove('multi-column-inactive');
            this._buildColumnViewports(effectiveColumns);
            this._updateMultiColumnDisplay();
        }
        this._updatePageIndicator();
        this._updatePageButtons();
    }

    /**
     * Build the column viewport elements
     * @param {number} count - Number of columns to build
     */
    _buildColumnViewports(count) {
        this._multiColumnContainer.innerHTML = '';
        this._columnViewports = [];

        for (let i = 0; i < count; i++) {
            const viewport = document.createElement('div');
            viewport.className = 'column-viewport';

            const content = document.createElement('div');
            content.className = 'column-content';
            viewport.appendChild(content);

            this._multiColumnContainer.appendChild(viewport);
            this._columnViewports.push({ viewport, content });
        }
    }

    /**
     * Compute which pages should be visible in each column, given the current page
     * @returns {number[]} Array of page numbers for each column (-1 for empty/padding)
     */
    _computeVisiblePages() {
        const effectiveColumns = this._getEffectiveColumnCount();
        if (effectiveColumns <= 1) return [this._currentPage];

        const activePage = this._currentPage;
        const pages = [];

        if (this._columnAutoCenter) {
            // Center the active page
            let centerIndex;
            if (effectiveColumns % 2 === 0) {
                // Even: active page is center-left (index = n/2 - 1)
                centerIndex = Math.floor(effectiveColumns / 2) - 1;
            } else {
                // Odd: active page is center (index = floor(n/2))
                centerIndex = Math.floor(effectiveColumns / 2);
            }

            let startPage = activePage - centerIndex;

            // Clamp: at start of chapter, shift right
            if (startPage < 0) {
                startPage = 0;
            }
            // Clamp: at end of chapter, shift left
            if (startPage + effectiveColumns > this._totalPages) {
                startPage = Math.max(0, this._totalPages - effectiveColumns);
            }

            for (let i = 0; i < effectiveColumns; i++) {
                const p = startPage + i;
                pages.push(p < this._totalPages ? p : -1);
            }
        } else {
            // Non-centering mode: pages advance in groups
            // The visible window starts at a multiple of effectiveColumns that contains activePage
            const windowStart = Math.floor(activePage / effectiveColumns) * effectiveColumns;
            for (let i = 0; i < effectiveColumns; i++) {
                const p = windowStart + i;
                pages.push(p < this._totalPages ? p : -1);
            }
        }

        return pages;
    }

    /**
     * Update the multi-column display with the correct pages
     */
    _updateMultiColumnDisplay() {
        const effectiveColumns = this._getEffectiveColumnCount();
        if (effectiveColumns <= 1 || this._columnViewports.length === 0) return;

        // Rebuild viewports if count changed (e.g., after resize)
        if (this._columnViewports.length !== effectiveColumns) {
            this._buildColumnViewports(effectiveColumns);
        }

        this._visiblePages = this._computeVisiblePages();

        for (let i = 0; i < this._columnViewports.length; i++) {
            const { viewport, content } = this._columnViewports[i];
            const pageNum = this._visiblePages[i];

            if (pageNum < 0 || pageNum >= this._totalPages) {
                // Empty column
                content.innerHTML = '';
                viewport.classList.add('column-empty');
                continue;
            }

            viewport.classList.remove('column-empty');

            // Clone the master content and scroll to the right page
            const clone = this._textContent.cloneNode(true);
            clone.removeAttribute('id');
            clone.classList.remove('multi-column-hidden');
            clone.className = 'text-content column-page-content';
            clone.style.position = 'relative';
            clone.style.overflow = 'hidden';
            clone.style.height = `${this._pageHeight}px`;

            // Add bottom padding so the last page can scroll to the correct position.
            // Without this, the browser clamps scrollTop when content is shorter than
            // (pageNum + 1) * pageHeight, causing overlap with the previous page.
            const neededHeight = (pageNum + 1) * this._pageHeight;
            if (this._textContent.scrollHeight < neededHeight) {
                const spacer = document.createElement('div');
                spacer.style.height = `${neededHeight - this._textContent.scrollHeight}px`;
                spacer.style.flexShrink = '0';
                clone.appendChild(spacer);
            }

            content.innerHTML = '';
            content.appendChild(clone);

            // Set scroll position after appending to DOM
            clone.scrollTop = pageNum * this._pageHeight;
        }
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
     * Setup page navigation button handlers.
     * Buttons act as page nav normally, but switch to chapter nav at chapter boundaries.
     */
    _setupPageNavigation() {
        if (this._prevBtn) {
            this._prevBtn.addEventListener('click', () => {
                if (this._prevBtnMode === 'chapter') {
                    this._onPrevChapter?.();
                } else {
                    this.previousPage();
                }
            });
        }
        if (this._nextBtn) {
            this._nextBtn.addEventListener('click', () => {
                if (this._nextBtnMode === 'chapter') {
                    this._onNextChapter?.();
                } else {
                    this.nextPage();
                }
            });
        }
    }

    /**
     * Setup swipe gesture navigation for touch devices.
     * Swipe left = next page (or next chapter at end), swipe right = previous page (or prev chapter at start).
     */
    _setupSwipeNavigation() {
        const target = this._pageContainer || this._container;

        target.addEventListener('touchstart', (e) => {
            // Ignore multi-touch (pinch zoom etc.)
            if (e.touches.length !== 1) return;
            this._touchStartX = e.touches[0].clientX;
            this._touchStartY = e.touches[0].clientY;
            this._touchStartTime = Date.now();
            this._isSwiping = false;
        }, { passive: true });

        target.addEventListener('touchmove', (e) => {
            if (e.touches.length !== 1) return;
            const dx = e.touches[0].clientX - this._touchStartX;
            const dy = e.touches[0].clientY - this._touchStartY;
            // If horizontal movement dominates, mark as swiping
            if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.5) {
                this._isSwiping = true;
            }
        }, { passive: true });

        target.addEventListener('touchend', (e) => {
            if (!this._isSwiping) return;

            const touch = e.changedTouches[0];
            const dx = touch.clientX - this._touchStartX;
            const dy = touch.clientY - this._touchStartY;
            const elapsed = Date.now() - this._touchStartTime;

            // Require: minimum horizontal distance, dominantly horizontal, completed within 600ms
            const MIN_DISTANCE = 50;
            if (Math.abs(dx) < MIN_DISTANCE || Math.abs(dx) < Math.abs(dy) * 1.2 || elapsed > 600) {
                return;
            }

            if (dx < 0) {
                // Swipe left → next page or next chapter
                const moved = this.nextPage();
                if (!moved && !this._isLastChapter) {
                    this._onNextChapter?.();
                }
            } else {
                // Swipe right → previous page or previous chapter
                const moved = this.previousPage();
                if (!moved && !this._isFirstChapter) {
                    this._onPrevChapter?.();
                }
            }
        }, { passive: true });
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
     * Set chapter boundary info so page nav buttons can transform into chapter nav at edges
     * @param {boolean} isFirstChapter - Whether the current chapter is the first
     * @param {boolean} isLastChapter - Whether the current chapter is the last
     */
    setChapterBoundaries(isFirstChapter, isLastChapter) {
        this._isFirstChapter = isFirstChapter;
        this._isLastChapter = isLastChapter;
        this._updatePageButtons();
    }

    /**
     * Request that after the next render/page-calculation, the view jumps to the last page.
     * Must be called before renderSentences / setSentences.
     */
    goToLastPageAfterRender() {
        this._pendingGoToLastPage = true;
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

        // For pagination calculation, ensure master content is visible
        const needsMultiColumn = this._getEffectiveColumnCount() > 1;
        this._textContent.classList.remove('multi-column-hidden');
        if (this._multiColumnContainer) {
            this._multiColumnContainer.classList.add('multi-column-inactive');
        }

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
        const pendingLastPage = this._pendingGoToLastPage;
        this._pendingGoToLastPage = false;
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                this._calculatePages();
                // Navigate to the appropriate page after layout
                if (pendingLastPage) {
                    this._currentPage = Math.max(0, this._totalPages - 1);
                } else if (currentIndex > 0) {
                    const page = this._sentenceToPage.get(currentIndex);
                    if (page !== undefined) {
                        this._currentPage = page;
                    }
                }
                // Set up multi-column mode if needed
                if (needsMultiColumn) {
                    this._textContent.classList.add('multi-column-hidden');
                    this._multiColumnContainer?.classList.remove('multi-column-inactive');
                    this._buildColumnViewports(this._getEffectiveColumnCount());
                    this._updateMultiColumnDisplay();
                } else {
                    // Single column: scroll to the right page
                    if (this._currentPage > 0) {
                        const pageHeight = this._pageHeight || this._textContent.clientHeight;
                        this._textContent.scrollTop = this._currentPage * pageHeight;
                    }
                }
                this._updatePageIndicator();
                this._updatePageButtons();
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
        // For recalculation, temporarily show the master content so we can measure
        const wasHidden = this._textContent.classList.contains('multi-column-hidden');
        if (wasHidden) {
            this._textContent.classList.remove('multi-column-hidden');
            this._multiColumnContainer?.classList.add('multi-column-inactive');
        }

        const currentSentence = this._currentIndex;
        this._calculatePages();

        // Navigate to page containing current sentence
        if (currentSentence >= 0) {
            const page = this._sentenceToPage.get(currentSentence);
            if (page !== undefined) {
                this._currentPage = page;
            }
        }

        // Restore multi-column mode if needed
        if (wasHidden) {
            this._textContent.classList.add('multi-column-hidden');
            this._multiColumnContainer?.classList.remove('multi-column-inactive');
        }

        this._updateMultiColumnMode();
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

        const effectiveColumns = this._getEffectiveColumnCount();
        if (effectiveColumns > 1) {
            // Multi-column mode: update column display
            this._updateMultiColumnDisplay();
        } else {
            // Single column mode: scroll to the correct position
            const pageHeight = this._pageHeight || this._textContent.clientHeight;
            const scrollTop = targetPage * pageHeight;
            this._textContent.scrollTop = scrollTop;
        }

        this._updatePageIndicator();
        this._updatePageButtons();

        if (triggerCallback) {
            this._onPageChange?.();
        }
    }

    /**
     * Go to next page.
     * In non-centered multi-column mode, advances by N pages (one full window).
     * Otherwise advances by 1 page.
     * @returns {boolean} Whether navigation occurred
     */
    nextPage() {
        const effectiveColumns = this._getEffectiveColumnCount();
        if (effectiveColumns > 1 && !this._columnAutoCenter) {
            // Non-centered multi-column: jump to the next window of N pages
            const windowStart = Math.floor(this._currentPage / effectiveColumns) * effectiveColumns;
            const nextWindowStart = windowStart + effectiveColumns;
            if (nextWindowStart < this._totalPages) {
                this._goToPageInternal(nextWindowStart);
                return true;
            }
            return false;
        }
        if (this._currentPage < this._totalPages - 1) {
            this._goToPageInternal(this._currentPage + 1);
            return true;
        }
        return false;
    }

    /**
     * Go to previous page.
     * In non-centered multi-column mode, goes back by N pages (one full window).
     * Otherwise goes back by 1 page.
     * @returns {boolean} Whether navigation occurred
     */
    previousPage() {
        const effectiveColumns = this._getEffectiveColumnCount();
        if (effectiveColumns > 1 && !this._columnAutoCenter) {
            // Non-centered multi-column: jump to the previous window of N pages
            const windowStart = Math.floor(this._currentPage / effectiveColumns) * effectiveColumns;
            const prevWindowStart = windowStart - effectiveColumns;
            if (prevWindowStart >= 0) {
                this._goToPageInternal(prevWindowStart);
                return true;
            }
            return false;
        }
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
        const effectiveColumns = this._getEffectiveColumnCount();
        if (effectiveColumns > 1 && this._visiblePages.length > 0) {
            const validPages = this._visiblePages.filter(p => p >= 0);
            if (validPages.length > 0) {
                const first = Math.min(...validPages) + 1;
                const last = Math.max(...validPages) + 1;
                if (this._pageCurrentEl) {
                    this._pageCurrentEl.textContent = first === last ? `${first}` : `${first}-${last}`;
                }
            }
        } else {
            if (this._pageCurrentEl) {
                this._pageCurrentEl.textContent = (this._currentPage + 1).toString();
            }
        }
        if (this._pageTotalEl) {
            this._pageTotalEl.textContent = this._totalPages.toString();
        }
    }

    /**
     * Update page navigation button states.
     * When at the first/last page of a chapter, transform the button into
     * a chapter navigation button (with a different icon and style) instead
     * of disabling it.
     */
    _updatePageButtons() {
        const effectiveColumns = this._getEffectiveColumnCount();
        const isNonCenteredMultiColumn = effectiveColumns > 1 && !this._columnAutoCenter;

        let atStart, atEnd;
        if (isNonCenteredMultiColumn) {
            const windowStart = Math.floor(this._currentPage / effectiveColumns) * effectiveColumns;
            atStart = windowStart <= 0;
            atEnd = windowStart + effectiveColumns >= this._totalPages;
        } else {
            atStart = this._currentPage <= 0;
            atEnd = this._currentPage >= this._totalPages - 1;
        }

        if (this._prevBtn) {
            if (atStart && !this._isFirstChapter) {
                // At start of chapter but not first chapter: show "prev chapter" button
                this._prevBtnMode = 'chapter';
                this._prevBtn.disabled = false;
                this._prevBtn.innerHTML = this._CHAPTER_ARROW_SVG;
                this._prevBtn.setAttribute('aria-label', 'Previous chapter');
                this._prevBtn.setAttribute('title', 'Previous chapter');
                this._prevBtn.classList.add('page-nav-chapter');
            } else {
                // Normal page nav (or disabled at first chapter start)
                this._prevBtnMode = 'page';
                this._prevBtn.disabled = atStart;
                this._prevBtn.innerHTML = this._PAGE_ARROW_SVG;
                this._prevBtn.setAttribute('aria-label', 'Previous page');
                this._prevBtn.removeAttribute('title');
                this._prevBtn.classList.remove('page-nav-chapter');
            }
        }
        if (this._nextBtn) {
            if (atEnd && !this._isLastChapter) {
                // At end of chapter but not last chapter: show "next chapter" button
                this._nextBtnMode = 'chapter';
                this._nextBtn.disabled = false;
                this._nextBtn.innerHTML = this._CHAPTER_ARROW_SVG_NEXT;
                this._nextBtn.setAttribute('aria-label', 'Next chapter');
                this._nextBtn.setAttribute('title', 'Next chapter');
                this._nextBtn.classList.add('page-nav-chapter');
            } else {
                // Normal page nav (or disabled at last chapter end)
                this._nextBtnMode = 'page';
                this._nextBtn.disabled = atEnd;
                this._nextBtn.innerHTML = this._PAGE_ARROW_SVG_NEXT;
                this._nextBtn.setAttribute('aria-label', 'Next page');
                this._nextBtn.removeAttribute('title');
                this._nextBtn.classList.remove('page-nav-chapter');
            }
        }
    }

    /**
     * Navigate to page containing a specific sentence
     * @param {number} sentenceIndex
     * @returns {boolean} Whether page change occurred
     */
    _navigateToSentencePage(sentenceIndex) {
        const page = this._sentenceToPage.get(sentenceIndex);
        if (page === undefined) return false;

        const effectiveColumns = this._getEffectiveColumnCount();

        if (effectiveColumns > 1 && this._columnAutoCenter) {
            // In auto-center mode, always navigate to the sentence's page
            // so it stays centered
            if (page !== this._currentPage) {
                this._goToPageInternal(page, false);
                return true;
            }
            return false;
        } else if (effectiveColumns > 1 && !this._columnAutoCenter) {
            // In non-centering mode, only advance when sentence goes beyond visible pages
            const visiblePages = this._computeVisiblePages();
            if (!visiblePages.includes(page)) {
                this._goToPageInternal(page, false);
                return true;
            }
            return false;
        } else {
            // Single column mode
            if (page !== this._currentPage) {
                this._goToPageInternal(page, false);
                return true;
            }
            return false;
        }
    }

    /**
     * Highlight a specific sentence
     * @param {number} index
     * @param {boolean} [scroll=true] - Whether to navigate to page containing sentence
     */
    highlightSentence(index, scroll = true) {
        // Remove previous highlight on master content
        const prevElement = this._textContent.querySelector(`.sentence[data-index="${this._currentIndex}"]`);
        if (prevElement) {
            prevElement.classList.remove('current');
            prevElement.classList.add('played');
        }

        this._currentIndex = index;

        // Add new highlight on master content
        const element = this._textContent.querySelector(`.sentence[data-index="${index}"]`);
        if (element) {
            element.classList.remove('played');
            element.classList.add('current');
        }

        if (scroll) {
            // Navigate to page containing this sentence
            const pageChanged = this._navigateToSentencePage(index);
            // If page didn't change but we're in multi-column mode, still update display
            if (!pageChanged && this._getEffectiveColumnCount() > 1) {
                this._updateMultiColumnDisplay();
            }
        } else if (this._getEffectiveColumnCount() > 1) {
            // Even without scrolling, refresh the column display to show updated highlights
            this._updateMultiColumnDisplay();
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
        if (this._getEffectiveColumnCount() > 1) {
            this._updateMultiColumnDisplay();
        }
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
        if (this._getEffectiveColumnCount() > 1) {
            this._updateMultiColumnDisplay();
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
     * Get currently visible page numbers (for multi-column mode)
     * @returns {number[]}
     */
    getVisiblePages() {
        if (this._getEffectiveColumnCount() > 1) {
            return this._visiblePages.filter(p => p >= 0);
        }
        return [this._currentPage];
    }

    /**
     * Get the sentence-to-page mapping
     * @returns {Map<number, number>}
     */
    getSentenceToPageMap() {
        return this._sentenceToPage;
    }

    /**
     * Get the page-to-sentences mapping
     * @returns {Map<number, number[]>}
     */
    getPageToSentencesMap() {
        return this._pageToSentences;
    }

    /**
     * Get the computed page height
     * @returns {number}
     */
    getPageHeight() {
        return this._pageHeight;
    }

    /**
     * Get the master text content element (for thumbnail rendering)
     * @returns {HTMLElement}
     */
    getTextContentElement() {
        return this._textContent;
    }

    /**
     * Show loading state
     */
    showLoading() {
        // Show master content, hide multi-column
        this._textContent.classList.remove('multi-column-hidden');
        if (this._multiColumnContainer) {
            this._multiColumnContainer.classList.add('multi-column-inactive');
        }
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
        // Show master content, hide multi-column
        this._textContent.classList.remove('multi-column-hidden');
        if (this._multiColumnContainer) {
            this._multiColumnContainer.classList.add('multi-column-inactive');
        }
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
        if (!this._isWithinReaderContent(range.startContainer) || !this._isWithinReaderContent(range.endContainer)) {
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
            if (!this._highlightToolbar.contains(e.target) && !this._isWithinReaderContent(e.target)) {
                this._hideHighlightToolbar();
            }
        });
    }

    /**
     * Check if a node is within our reader content (master or multi-column clones)
     * @param {Node} node
     * @returns {boolean}
     */
    _isWithinReaderContent(node) {
        return this._textContent.contains(node) ||
            (this._multiColumnContainer && this._multiColumnContainer.contains(node));
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

        // Check if selection is within our text content (master or column clones)
        const range = selection.getRangeAt(0);
        if (!this._isWithinReaderContent(range.startContainer) || !this._isWithinReaderContent(range.endContainer)) {
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
        while (el && el !== this._textContent && el !== this._multiColumnContainer) {
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

        // Apply visual highlight to master content
        this._applyHighlightToSentences(startIndex, endIndex, color);

        // Clear selection and hide toolbar
        selection.removeAllRanges();
        this._hideHighlightToolbar();

        // Refresh multi-column display to show new highlight
        if (this._getEffectiveColumnCount() > 1) {
            this._updateMultiColumnDisplay();
        }

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

        // Refresh multi-column display
        if (this._getEffectiveColumnCount() > 1) {
            this._updateMultiColumnDisplay();
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
        if (this._multiColumnContainer) {
            this._multiColumnContainer.remove();
        }
    }
}
