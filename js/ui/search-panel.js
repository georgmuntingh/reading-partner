/**
 * Search Panel UI Component
 * Provides full-text search across all book chapters with results panel
 * and inline highlighting in the reader view.
 */

import { debounce } from '../utils/helpers.js';

export class SearchPanel {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.container - The search panel container element
     * @param {Object} callbacks
     * @param {() => void} callbacks.onClose - Called when the panel is closed
     * @param {(chapterIndex: number, sentenceIndex: number) => void} callbacks.onResultSelect - Called when a result is clicked
     * @param {(chapterIndex: number) => Promise<string[]>} callbacks.loadChapter - Loads a chapter's sentences
     * @param {() => Object} callbacks.getBook - Returns the current book object
     */
    constructor(options, callbacks) {
        this._container = options.container;
        this._callbacks = callbacks;

        this._isOpen = false;
        this._query = '';
        this._caseSensitive = false;
        this._wholeWord = false;

        // Results: array of { chapterIndex, sentenceIndex, sentence (text), matchStart, matchLength }
        this._results = [];
        this._currentResultIndex = -1; // Which result is currently focused (-1 = none)
        this._isSearching = false;
        this._searchAbortController = null;
        this._chaptersSearched = 0;
        this._totalChapters = 0;

        this._render();
        this._setupEventListeners();
    }

    // ========== Public API ==========

    /**
     * Open the search panel
     */
    open() {
        if (this._isOpen) return;
        this._isOpen = true;
        this._container.classList.add('active');
        // Focus the search input after animation
        setTimeout(() => this._input?.focus(), 100);
    }

    /**
     * Close the search panel and clear everything
     */
    close() {
        if (!this._isOpen) return;
        this._isOpen = false;
        this._container.classList.remove('active');
        this._clearSearch();
        this._callbacks.onClose?.();
    }

    /**
     * Toggle open/close
     */
    toggle() {
        if (this._isOpen) {
            this.close();
        } else {
            this.open();
        }
    }

    /**
     * Whether the panel is currently open
     * @returns {boolean}
     */
    isOpen() {
        return this._isOpen;
    }

    /**
     * Get the list of search results (for inline highlighting by the reader)
     * @returns {Array<{chapterIndex: number, sentenceIndex: number, matchStart: number, matchLength: number}>}
     */
    getResults() {
        return this._results;
    }

    /**
     * Get the currently focused result index
     * @returns {number}
     */
    getCurrentResultIndex() {
        return this._currentResultIndex;
    }

    /**
     * Get the current search query
     * @returns {string}
     */
    getQuery() {
        return this._query;
    }

    /**
     * Whether search is case sensitive
     * @returns {boolean}
     */
    isCaseSensitive() {
        return this._caseSensitive;
    }

    /**
     * Whether whole-word matching is enabled
     * @returns {boolean}
     */
    isWholeWord() {
        return this._wholeWord;
    }

    // ========== Rendering ==========

    /**
     * Render the panel HTML
     */
    _render() {
        this._container.innerHTML = `
            <div class="search-header">
                <div class="search-input-row">
                    <div class="search-input-wrapper">
                        <svg class="search-input-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="11" cy="11" r="8"/>
                            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                        </svg>
                        <input type="text" class="search-input" placeholder="Search in book..." aria-label="Search in book">
                    </div>
                    <button class="search-close-btn" aria-label="Close search">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="18" y1="6" x2="6" y2="18"/>
                            <line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </button>
                </div>
                <div class="search-options-row">
                    <label class="search-option">
                        <input type="checkbox" class="search-option-checkbox" data-option="caseSensitive">
                        <span>Aa</span>
                    </label>
                    <label class="search-option" title="Whole word">
                        <input type="checkbox" class="search-option-checkbox" data-option="wholeWord">
                        <span class="search-option-word">W</span>
                    </label>
                    <div class="search-nav-controls">
                        <button class="search-nav-btn" id="search-prev-btn" aria-label="Previous result" disabled>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="18 15 12 9 6 15"/>
                            </svg>
                        </button>
                        <span class="search-counter" id="search-counter"></span>
                        <button class="search-nav-btn" id="search-next-btn" aria-label="Next result" disabled>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="6 9 12 15 18 9"/>
                            </svg>
                        </button>
                    </div>
                </div>
            </div>
            <div class="search-progress hidden" id="search-progress">
                <div class="search-progress-bar">
                    <div class="search-progress-fill" id="search-progress-fill"></div>
                </div>
                <span class="search-progress-text" id="search-progress-text">Searching...</span>
            </div>
            <div class="search-results" id="search-results">
                <div class="search-empty">Type to search across the book</div>
            </div>
        `;

        // Cache elements
        this._input = this._container.querySelector('.search-input');
        this._closeBtn = this._container.querySelector('.search-close-btn');
        this._prevBtn = this._container.querySelector('#search-prev-btn');
        this._nextBtn = this._container.querySelector('#search-next-btn');
        this._counter = this._container.querySelector('#search-counter');
        this._resultsList = this._container.querySelector('#search-results');
        this._progressBar = this._container.querySelector('#search-progress');
        this._progressFill = this._container.querySelector('#search-progress-fill');
        this._progressText = this._container.querySelector('#search-progress-text');
    }

    // ========== Event Listeners ==========

    _setupEventListeners() {
        // Close button
        this._closeBtn.addEventListener('click', () => this.close());

        // Search input with debounce
        const debouncedSearch = debounce(() => this._performSearch(), 300);
        this._input.addEventListener('input', () => {
            this._query = this._input.value;
            debouncedSearch();
        });

        // Enter key in input: go to next result
        this._input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (e.shiftKey) {
                    this._goToPrevResult();
                } else {
                    this._goToNextResult();
                }
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                this.close();
            }
        });

        // Option checkboxes
        this._container.querySelectorAll('.search-option-checkbox').forEach(cb => {
            cb.addEventListener('change', () => {
                if (cb.dataset.option === 'caseSensitive') {
                    this._caseSensitive = cb.checked;
                } else if (cb.dataset.option === 'wholeWord') {
                    this._wholeWord = cb.checked;
                }
                // Re-run search with new options
                if (this._query.length >= 2) {
                    this._performSearch();
                }
            });
        });

        // Prev/Next buttons
        this._prevBtn.addEventListener('click', () => this._goToPrevResult());
        this._nextBtn.addEventListener('click', () => this._goToNextResult());
    }

    // ========== Search Logic ==========

    /**
     * Clear search state
     */
    _clearSearch() {
        // Abort any ongoing search
        if (this._searchAbortController) {
            this._searchAbortController.abort();
            this._searchAbortController = null;
        }

        this._query = '';
        this._results = [];
        this._currentResultIndex = -1;
        this._isSearching = false;

        if (this._input) {
            this._input.value = '';
        }

        this._updateCounter();
        this._updateNavButtons();
        this._hideProgress();

        if (this._resultsList) {
            this._resultsList.innerHTML = '<div class="search-empty">Type to search across the book</div>';
        }
    }

    /**
     * Build a matching function based on current search options
     * @param {string} query
     * @returns {{ match: (text: string) => Array<{index: number, length: number}>, queryLength: number }}
     */
    _buildMatcher(query) {
        let flags = 'g';
        if (!this._caseSensitive) flags += 'i';

        let pattern = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (this._wholeWord) {
            pattern = `\\b${pattern}\\b`;
        }

        const regex = new RegExp(pattern, flags);

        return {
            match(text) {
                const matches = [];
                let m;
                regex.lastIndex = 0;
                while ((m = regex.exec(text)) !== null) {
                    matches.push({ index: m.index, length: m[0].length });
                }
                return matches;
            },
            queryLength: query.length
        };
    }

    /**
     * Strip HTML tags from a string to get plain text
     * @param {string} html
     * @returns {string}
     */
    _stripHtml(html) {
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        return tmp.textContent || tmp.innerText || '';
    }

    /**
     * Perform the search across all chapters (progressive)
     */
    async _performSearch() {
        // Abort previous search
        if (this._searchAbortController) {
            this._searchAbortController.abort();
        }

        const query = this._query.trim();

        if (query.length < 2) {
            this._results = [];
            this._currentResultIndex = -1;
            this._updateCounter();
            this._updateNavButtons();
            this._hideProgress();
            this._resultsList.innerHTML = query.length > 0
                ? '<div class="search-empty">Type at least 2 characters</div>'
                : '<div class="search-empty">Type to search across the book</div>';
            return;
        }

        const book = this._callbacks.getBook?.();
        if (!book || !book.chapters) return;

        // Setup abort controller for this search
        this._searchAbortController = new AbortController();
        const signal = this._searchAbortController.signal;

        this._isSearching = true;
        this._results = [];
        this._currentResultIndex = -1;
        this._totalChapters = book.chapters.length;
        this._chaptersSearched = 0;
        this._resultsList.innerHTML = '';
        this._showProgress();

        const matcher = this._buildMatcher(query);
        const MAX_RESULTS = 200;
        let totalFound = 0;

        for (let ci = 0; ci < book.chapters.length; ci++) {
            if (signal.aborted) return;

            const chapter = book.chapters[ci];

            // Ensure chapter is loaded
            let sentences = chapter.sentences;
            if (!sentences || !chapter.loaded) {
                try {
                    sentences = await this._callbacks.loadChapter(ci);
                } catch (err) {
                    console.warn(`Failed to load chapter ${ci} for search:`, err);
                    this._chaptersSearched++;
                    this._updateProgress();
                    continue;
                }
                if (signal.aborted) return;
            }

            // Search each sentence
            const chapterResults = [];
            for (let si = 0; si < sentences.length; si++) {
                const plainText = this._stripHtml(sentences[si]);
                const matches = matcher.match(plainText);
                if (matches.length > 0) {
                    // Take the first match in this sentence for the result entry
                    chapterResults.push({
                        chapterIndex: ci,
                        sentenceIndex: si,
                        sentence: plainText,
                        matchStart: matches[0].index,
                        matchLength: matches[0].length
                    });
                    totalFound++;
                }

                if (totalFound >= MAX_RESULTS) break;
            }

            // Render chapter results incrementally
            if (chapterResults.length > 0) {
                this._results.push(...chapterResults);
                this._renderChapterGroup(chapter.title, ci, chapterResults);
            }

            this._chaptersSearched++;
            this._updateProgress();
            this._updateCounter();
            this._updateNavButtons();

            if (totalFound >= MAX_RESULTS) {
                this._showMaxReached();
                break;
            }

            // Yield to UI thread between chapters
            await new Promise(r => setTimeout(r, 0));
        }

        if (signal.aborted) return;

        this._isSearching = false;
        this._hideProgress();
        this._updateCounter();
        this._updateNavButtons();

        if (this._results.length === 0) {
            this._resultsList.innerHTML = '<div class="search-empty">No results found</div>';
        }
    }

    // ========== Results Rendering ==========

    /**
     * Render a group of results for a chapter
     * @param {string} chapterTitle
     * @param {number} chapterIndex
     * @param {Array} results
     */
    _renderChapterGroup(chapterTitle, chapterIndex, results) {
        const group = document.createElement('div');
        group.className = 'search-chapter-group';

        const header = document.createElement('div');
        header.className = 'search-chapter-header';
        header.innerHTML = `
            <span class="search-chapter-title">Ch. ${chapterIndex + 1}: ${this._escapeHtml(chapterTitle)}</span>
            <span class="search-chapter-count">${results.length}</span>
        `;
        group.appendChild(header);

        results.forEach(result => {
            const item = document.createElement('div');
            item.className = 'search-result-item';
            item.dataset.resultIndex = this._getResultGlobalIndex(result);

            // Build snippet with ~80 char window around match
            const snippet = this._buildSnippet(result.sentence, result.matchStart, result.matchLength);
            item.innerHTML = `<div class="search-result-snippet">${snippet}</div>`;

            item.addEventListener('click', () => {
                const globalIndex = parseInt(item.dataset.resultIndex, 10);
                this._selectResult(globalIndex);
            });

            group.appendChild(item);
        });

        this._resultsList.appendChild(group);
    }

    /**
     * Get the global index of a result in the _results array
     * @param {Object} result
     * @returns {number}
     */
    _getResultGlobalIndex(result) {
        return this._results.findIndex(
            r => r.chapterIndex === result.chapterIndex && r.sentenceIndex === result.sentenceIndex
        );
    }

    /**
     * Build a snippet with ~80 char window around the match, bolding the match
     * @param {string} text
     * @param {number} matchStart
     * @param {number} matchLength
     * @returns {string} HTML snippet
     */
    _buildSnippet(text, matchStart, matchLength) {
        const WINDOW = 80;
        const halfWindow = Math.floor((WINDOW - matchLength) / 2);

        let start = Math.max(0, matchStart - halfWindow);
        let end = Math.min(text.length, matchStart + matchLength + halfWindow);

        // Adjust to not cut words
        if (start > 0) {
            const spaceIndex = text.indexOf(' ', start);
            if (spaceIndex !== -1 && spaceIndex < matchStart) {
                start = spaceIndex + 1;
            }
        }
        if (end < text.length) {
            const spaceIndex = text.lastIndexOf(' ', end);
            if (spaceIndex !== -1 && spaceIndex > matchStart + matchLength) {
                end = spaceIndex;
            }
        }

        const prefix = start > 0 ? '...' : '';
        const suffix = end < text.length ? '...' : '';

        const before = this._escapeHtml(text.substring(start, matchStart));
        const matched = this._escapeHtml(text.substring(matchStart, matchStart + matchLength));
        const after = this._escapeHtml(text.substring(matchStart + matchLength, end));

        return `${prefix}${before}<mark class="search-match-highlight">${matched}</mark>${after}${suffix}`;
    }

    /**
     * Show the "max results reached" message
     */
    _showMaxReached() {
        const notice = document.createElement('div');
        notice.className = 'search-max-notice';
        notice.textContent = 'Showing first 200 results. Refine your search for more specific results.';
        this._resultsList.appendChild(notice);
    }

    // ========== Navigation ==========

    /**
     * Select a result by global index
     * @param {number} index
     */
    _selectResult(index) {
        if (index < 0 || index >= this._results.length) return;

        this._currentResultIndex = index;
        const result = this._results[index];

        // Update visual selection
        this._updateResultSelection();
        this._updateCounter();
        this._updateNavButtons();

        // Scroll the result item into view in the panel
        const items = this._resultsList.querySelectorAll('.search-result-item');
        items.forEach(item => {
            if (parseInt(item.dataset.resultIndex, 10) === index) {
                item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
        });

        // Navigate to this result in the reader
        this._callbacks.onResultSelect?.(result.chapterIndex, result.sentenceIndex);
    }

    /**
     * Update the visual selection highlight in the results list
     */
    _updateResultSelection() {
        const items = this._resultsList.querySelectorAll('.search-result-item');
        items.forEach(item => {
            const idx = parseInt(item.dataset.resultIndex, 10);
            item.classList.toggle('active', idx === this._currentResultIndex);
        });
    }

    /**
     * Go to the next result
     */
    _goToNextResult() {
        if (this._results.length === 0) return;
        const next = this._currentResultIndex < this._results.length - 1
            ? this._currentResultIndex + 1
            : 0; // Wrap around
        this._selectResult(next);
    }

    /**
     * Go to the previous result
     */
    _goToPrevResult() {
        if (this._results.length === 0) return;
        const prev = this._currentResultIndex > 0
            ? this._currentResultIndex - 1
            : this._results.length - 1; // Wrap around
        this._selectResult(prev);
    }

    // ========== UI Updates ==========

    /**
     * Update the results counter display
     */
    _updateCounter() {
        if (!this._counter) return;

        if (this._results.length === 0) {
            this._counter.textContent = '';
        } else if (this._currentResultIndex >= 0) {
            const suffix = this._isSearching ? '+' : '';
            this._counter.textContent = `${this._currentResultIndex + 1} of ${this._results.length}${suffix}`;
        } else {
            const suffix = this._isSearching ? '+' : '';
            this._counter.textContent = `${this._results.length}${suffix} results`;
        }
    }

    /**
     * Update prev/next button states
     */
    _updateNavButtons() {
        const hasResults = this._results.length > 0;
        if (this._prevBtn) this._prevBtn.disabled = !hasResults;
        if (this._nextBtn) this._nextBtn.disabled = !hasResults;
    }

    /**
     * Show the progress bar
     */
    _showProgress() {
        this._progressBar?.classList.remove('hidden');
        this._updateProgress();
    }

    /**
     * Hide the progress bar
     */
    _hideProgress() {
        this._progressBar?.classList.add('hidden');
    }

    /**
     * Update the progress bar fill and text
     */
    _updateProgress() {
        if (!this._progressFill || !this._progressText) return;
        const pct = this._totalChapters > 0
            ? Math.round((this._chaptersSearched / this._totalChapters) * 100)
            : 0;
        this._progressFill.style.width = `${pct}%`;
        this._progressText.textContent = `Searching... ${this._chaptersSearched}/${this._totalChapters} chapters`;
    }

    // ========== Helpers ==========

    /**
     * Escape HTML entities
     * @param {string} str
     * @returns {string}
     */
    _escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
}
