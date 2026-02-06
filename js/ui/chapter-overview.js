/**
 * Chapter Overview UI Component
 * Full-screen overlay showing rendered miniature page thumbnails
 * Triggered by clicking the page number display
 */

export class ChapterOverview {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.container - Container element for the overlay
     * @param {Object} callbacks
     * @param {() => void} callbacks.onClose - Close overlay
     * @param {(pageNumber: number) => void} callbacks.onPageSelect - Navigate to page
     * @param {(chapterIndex: number) => void} callbacks.onChapterSelect - Switch chapter
     */
    constructor(options, callbacks) {
        this._container = options.container;
        this._callbacks = callbacks;

        // State
        this._chapters = [];
        this._currentChapterIndex = 0;
        this._currentPage = 0;
        this._totalPages = 0;
        this._pageHeight = 0;
        this._textContentEl = null;
        this._sentenceToPage = new Map();
        this._currentSentenceIndex = -1;
        this._readPages = new Set(); // Pages that have been read
        this._bookmarks = [];
        this._highlights = [];
        this._pageToSentences = new Map();

        this._buildUI();
        this._setupEventListeners();
    }

    /**
     * Build the overlay UI
     */
    _buildUI() {
        this._container.innerHTML = `
            <div class="chapter-overview-overlay">
                <div class="chapter-overview-header">
                    <div class="chapter-overview-title-row">
                        <h2>Chapter Overview</h2>
                        <button class="btn-icon chapter-overview-close-btn" aria-label="Close">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <line x1="18" y1="6" x2="6" y2="18"/>
                                <line x1="6" y1="6" x2="18" y2="18"/>
                            </svg>
                        </button>
                    </div>
                    <div class="chapter-overview-chapter-select">
                        <select class="chapter-overview-select" id="chapter-overview-select">
                        </select>
                    </div>
                </div>
                <div class="chapter-overview-grid" id="chapter-overview-grid">
                    <!-- Thumbnails will be rendered here -->
                </div>
            </div>
        `;

        this._elements = {
            overlay: this._container.querySelector('.chapter-overview-overlay'),
            closeBtn: this._container.querySelector('.chapter-overview-close-btn'),
            chapterSelect: this._container.querySelector('#chapter-overview-select'),
            grid: this._container.querySelector('#chapter-overview-grid')
        };
    }

    /**
     * Setup event listeners
     */
    _setupEventListeners() {
        // Close button
        this._elements.closeBtn.addEventListener('click', () => {
            this._callbacks.onClose?.();
        });

        // Click outside to close
        this._container.addEventListener('click', (e) => {
            if (e.target === this._container) {
                this._callbacks.onClose?.();
            }
        });

        // Escape key
        this._escapeHandler = (e) => {
            if (e.key === 'Escape' && this.isVisible()) {
                this._callbacks.onClose?.();
            }
        };
        document.addEventListener('keydown', this._escapeHandler);

        // Chapter select
        this._elements.chapterSelect.addEventListener('change', () => {
            const chapterIndex = parseInt(this._elements.chapterSelect.value, 10);
            this._callbacks.onChapterSelect?.(chapterIndex);
        });

        // Thumbnail click (event delegation)
        this._elements.grid.addEventListener('click', (e) => {
            const thumb = e.target.closest('.chapter-overview-thumbnail');
            if (thumb && thumb.dataset.page !== undefined) {
                const pageNum = parseInt(thumb.dataset.page, 10);
                this._callbacks.onPageSelect?.(pageNum);
            }
        });
    }

    /**
     * Set the list of chapters for the chapter selector
     * @param {Object[]} chapters - Array of chapter objects with title property
     * @param {number} currentChapterIndex
     */
    setChapters(chapters, currentChapterIndex) {
        this._chapters = chapters;
        this._currentChapterIndex = currentChapterIndex;

        // Populate chapter select
        this._elements.chapterSelect.innerHTML = chapters.map((ch, i) =>
            `<option value="${i}" ${i === currentChapterIndex ? 'selected' : ''}>${ch.title || `Chapter ${i + 1}`}</option>`
        ).join('');
    }

    /**
     * Update the current chapter index (e.g., after chapter switch)
     * @param {number} chapterIndex
     */
    setCurrentChapter(chapterIndex) {
        this._currentChapterIndex = chapterIndex;
        this._elements.chapterSelect.value = chapterIndex.toString();
    }

    /**
     * Set the page data for rendering thumbnails
     * @param {Object} data
     * @param {HTMLElement} data.textContentEl - The master text content element
     * @param {number} data.totalPages
     * @param {number} data.pageHeight
     * @param {number} data.currentPage
     * @param {number} data.currentSentenceIndex
     * @param {Map<number, number>} data.sentenceToPage
     * @param {Map<number, number[]>} data.pageToSentences
     */
    setPageData(data) {
        this._textContentEl = data.textContentEl;
        this._totalPages = data.totalPages;
        this._pageHeight = data.pageHeight;
        this._currentPage = data.currentPage;
        this._currentSentenceIndex = data.currentSentenceIndex;
        this._sentenceToPage = data.sentenceToPage;
        this._pageToSentences = data.pageToSentences;

        // Compute which pages have been read (pages with sentence index < current)
        this._computeReadPages();
    }

    /**
     * Set bookmarks for the current chapter
     * @param {Object[]} bookmarks
     */
    setBookmarks(bookmarks) {
        this._bookmarks = bookmarks;
    }

    /**
     * Set highlights for the current chapter
     * @param {Object[]} highlights
     */
    setHighlights(highlights) {
        this._highlights = highlights;
    }

    /**
     * Compute which pages have been read based on current sentence index
     */
    _computeReadPages() {
        this._readPages = new Set();
        if (this._currentSentenceIndex < 0) return;

        const currentSentencePage = this._sentenceToPage.get(this._currentSentenceIndex);
        if (currentSentencePage === undefined) return;

        // All pages before the current sentence's page are considered read
        for (let p = 0; p < currentSentencePage; p++) {
            this._readPages.add(p);
        }
    }

    /**
     * Get pages that have bookmarks
     * @returns {Set<number>}
     */
    _getBookmarkedPages() {
        const pages = new Set();
        for (const bm of this._bookmarks) {
            const page = this._sentenceToPage.get(bm.sentenceIndex);
            if (page !== undefined) {
                pages.add(page);
            }
        }
        return pages;
    }

    /**
     * Get pages that have highlights
     * @returns {Set<number>}
     */
    _getHighlightedPages() {
        const pages = new Set();
        for (const hl of this._highlights) {
            const startPage = this._sentenceToPage.get(hl.startSentenceIndex);
            const endPage = this._sentenceToPage.get(hl.endSentenceIndex);
            if (startPage !== undefined) {
                const end = endPage !== undefined ? endPage : startPage;
                for (let p = startPage; p <= end; p++) {
                    pages.add(p);
                }
            }
        }
        return pages;
    }

    /**
     * Render all page thumbnails using lazy rendering via IntersectionObserver
     */
    _renderThumbnails() {
        this._elements.grid.innerHTML = '';

        // Clean up previous observer
        if (this._intersectionObserver) {
            this._intersectionObserver.disconnect();
        }

        if (!this._textContentEl || this._totalPages <= 0 || this._pageHeight <= 0) {
            this._elements.grid.innerHTML = '<p class="chapter-overview-empty">No pages to display</p>';
            return;
        }

        const bookmarkedPages = this._getBookmarkedPages();
        const highlightedPages = this._getHighlightedPages();

        // Compute thumbnail dimensions
        const contentWidth = this._textContentEl.scrollWidth || this._textContentEl.clientWidth;
        const THUMB_WIDTH = 180;
        const scale = contentWidth > 0 ? THUMB_WIDTH / contentWidth : 0.2;
        const thumbHeight = Math.round(this._pageHeight * scale);

        // Store dimensions for lazy rendering
        this._thumbScale = scale;
        this._thumbWidth = THUMB_WIDTH;
        this._thumbHeight = thumbHeight;
        this._contentWidth = contentWidth;

        const fragment = document.createDocumentFragment();

        for (let p = 0; p < this._totalPages; p++) {
            const thumb = document.createElement('div');
            thumb.className = 'chapter-overview-thumbnail';
            thumb.dataset.page = p.toString();

            if (p === this._currentPage) {
                thumb.classList.add('current-page');
            }
            if (this._readPages.has(p)) {
                thumb.classList.add('read-page');
            }

            // Preview placeholder (will be filled by IntersectionObserver)
            const preview = document.createElement('div');
            preview.className = 'chapter-overview-preview';
            preview.style.width = `${THUMB_WIDTH}px`;
            preview.style.height = `${thumbHeight}px`;

            // Page label
            const pageLabel = document.createElement('div');
            pageLabel.className = 'chapter-overview-page-label';
            pageLabel.textContent = (p + 1).toString();

            // Badges
            const badges = document.createElement('div');
            badges.className = 'chapter-overview-badges';

            if (bookmarkedPages.has(p)) {
                const badge = document.createElement('span');
                badge.className = 'chapter-overview-badge bookmark-badge';
                badge.title = 'Bookmark';
                badge.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M5 2h14v20l-7-4-7 4V2z"/></svg>';
                badges.appendChild(badge);
            }
            if (highlightedPages.has(p)) {
                const badge = document.createElement('span');
                badge.className = 'chapter-overview-badge highlight-badge';
                badge.title = 'Highlight';
                badge.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M15.243 3.515l5.242 5.242-12.02 12.02H3.222v-5.243l12.02-12.02z"/></svg>';
                badges.appendChild(badge);
            }

            thumb.appendChild(preview);
            thumb.appendChild(pageLabel);
            if (badges.hasChildNodes()) {
                thumb.appendChild(badges);
            }

            fragment.appendChild(thumb);
        }

        this._elements.grid.appendChild(fragment);

        // Setup IntersectionObserver for lazy rendering
        this._intersectionObserver = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting) {
                    const thumb = entry.target;
                    const preview = thumb.querySelector('.chapter-overview-preview');
                    if (preview && !preview.dataset.rendered) {
                        this._renderThumbnailContent(preview, parseInt(thumb.dataset.page, 10));
                        preview.dataset.rendered = 'true';
                    }
                    this._intersectionObserver.unobserve(thumb);
                }
            }
        }, { root: this._elements.grid, rootMargin: '200px' });

        // Observe all thumbnails
        const thumbs = this._elements.grid.querySelectorAll('.chapter-overview-thumbnail');
        thumbs.forEach(t => this._intersectionObserver.observe(t));

        // Scroll to current page thumbnail
        requestAnimationFrame(() => {
            const currentThumb = this._elements.grid.querySelector('.current-page');
            if (currentThumb) {
                currentThumb.scrollIntoView({ behavior: 'instant', block: 'center' });
            }
        });
    }

    /**
     * Render the content of a single thumbnail (called lazily)
     * @param {HTMLElement} preview - The preview container element
     * @param {number} pageNum - The page number to render
     */
    _renderThumbnailContent(preview, pageNum) {
        // Clone the full content - it will be constrained to one page height
        // and scrolled to show the correct page
        const clone = this._textContentEl.cloneNode(true);
        clone.removeAttribute('id');
        clone.classList.remove('multi-column-hidden');
        clone.className = 'text-content chapter-overview-clone';
        clone.style.cssText = `
            width: ${this._contentWidth}px;
            height: ${this._pageHeight}px;
            overflow: hidden;
            position: relative;
            pointer-events: none;
            max-width: none;
            margin: 0;
            flex: none;
        `;

        // Scale wrapper: scales the clone from content size to thumbnail size
        const scaleWrapper = document.createElement('div');
        scaleWrapper.style.cssText = `
            transform: scale(${this._thumbScale});
            transform-origin: top left;
            width: ${this._contentWidth}px;
            height: ${this._pageHeight}px;
            position: absolute;
            top: 0;
            left: 0;
        `;
        scaleWrapper.appendChild(clone);

        // Clip wrapper: clips the scaled output to thumbnail dimensions
        const clipWrapper = document.createElement('div');
        clipWrapper.style.cssText = `
            position: relative;
            width: ${this._thumbWidth}px;
            height: ${this._thumbHeight}px;
            overflow: hidden;
        `;
        clipWrapper.appendChild(scaleWrapper);

        preview.appendChild(clipWrapper);

        // After DOM insertion, scroll to show the correct page
        requestAnimationFrame(() => {
            clone.scrollTop = pageNum * this._pageHeight;
        });
    }

    /**
     * Show the overlay
     */
    show() {
        this._container.classList.remove('hidden');
        // Force reflow
        this._container.offsetHeight;
        this._container.classList.add('active');
        this._renderThumbnails();
    }

    /**
     * Hide the overlay
     */
    hide() {
        this._container.classList.remove('active');
        setTimeout(() => {
            if (!this._container.classList.contains('active')) {
                this._container.classList.add('hidden');
                // Clear thumbnails to free memory
                this._elements.grid.innerHTML = '';
            }
        }, 300);
    }

    /**
     * Check if overlay is visible
     * @returns {boolean}
     */
    isVisible() {
        return this._container.classList.contains('active');
    }

    /**
     * Cleanup
     */
    destroy() {
        document.removeEventListener('keydown', this._escapeHandler);
    }
}
