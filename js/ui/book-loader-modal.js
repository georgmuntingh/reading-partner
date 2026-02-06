/**
 * Book Loader Modal UI Component
 * Modal for selecting ebooks from local filesystem or Project Gutenberg
 */

export class BookLoaderModal {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.container - Container element for the modal
     * @param {Object} callbacks
     * @param {() => void} callbacks.onClose - Close modal
     * @param {(file: File, source: Object) => void} callbacks.onFileSelect - File selected from device
     * @param {(bookId: string) => void} callbacks.onGutenbergLoad - Load from Gutenberg
     */
    constructor(options, callbacks) {
        this._container = options.container;
        this._callbacks = callbacks;

        this._buildUI();
        this._setupEventListeners();
    }

    /**
     * Build the modal UI
     */
    _buildUI() {
        this._container.innerHTML = `
            <div class="modal book-loader-modal">
                <div class="modal-header">
                    <h2>Select eBook</h2>
                    <button class="btn-icon modal-close-btn" aria-label="Close">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="18" y1="6" x2="6" y2="18"/>
                            <line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </button>
                </div>

                <div class="modal-content">
                    <!-- Local File Option -->
                    <div class="book-source-option" id="local-file-option">
                        <div class="book-source-header">
                            <div class="book-source-icon">
                                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                                </svg>
                            </div>
                            <div class="book-source-info">
                                <h3>Load from Device</h3>
                                <p>EPUB, Markdown, or HTML file</p>
                            </div>
                        </div>
                        <input type="file" id="book-loader-file-input" accept=".epub,.md,.markdown,.html,.htm" hidden>
                        <button class="btn btn-primary book-source-btn" id="browse-local-btn">
                            Browse Files
                        </button>
                    </div>

                    <div class="book-source-divider">
                        <span>or</span>
                    </div>

                    <!-- Project Gutenberg Option -->
                    <div class="book-source-option" id="gutenberg-option">
                        <div class="book-source-header">
                            <div class="book-source-icon">
                                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <circle cx="12" cy="12" r="10"/>
                                    <line x1="2" y1="12" x2="22" y2="12"/>
                                    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
                                </svg>
                            </div>
                            <div class="book-source-info">
                                <h3>Load from Project Gutenberg</h3>
                                <p>Free public domain books</p>
                            </div>
                        </div>

                        <!-- Search Section -->
                        <div class="gutenberg-search-section">
                            <div class="gutenberg-input-row">
                                <input type="text" id="gutenberg-search-input" class="form-input" placeholder="Search books (e.g., Frankenstein)">
                                <button class="btn btn-primary" id="gutenberg-search-btn">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <circle cx="11" cy="11" r="8"/>
                                        <path d="m21 21-4.35-4.35"/>
                                    </svg>
                                </button>
                            </div>
                            <div id="gutenberg-search-results" class="gutenberg-search-results hidden"></div>
                        </div>

                        <div class="gutenberg-or-divider">
                            <span>or enter book ID directly</span>
                        </div>

                        <!-- Direct ID Input -->
                        <div class="gutenberg-input-row">
                            <input type="text" id="book-loader-gutenberg-input" class="form-input" placeholder="Book ID or URL (e.g., 1342)">
                            <button class="btn btn-primary" id="load-gutenberg-btn">Load</button>
                        </div>
                        <p class="form-hint gutenberg-hint">
                            Enter a book ID (e.g., 1342 for Pride and Prejudice) or paste a Gutenberg URL.
                            <a href="https://www.gutenberg.org/" target="_blank" rel="noopener">Browse Gutenberg</a>
                        </p>
                    </div>

                    <!-- Loading State -->
                    <div id="book-loader-loading" class="book-loader-loading hidden">
                        <div class="spinner"></div>
                        <p id="book-loader-loading-text">Loading...</p>
                    </div>

                    <!-- Error State -->
                    <div id="book-loader-error" class="book-loader-error hidden">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="12" r="10"/>
                            <line x1="12" y1="8" x2="12" y2="12"/>
                            <line x1="12" y1="16" x2="12.01" y2="16"/>
                        </svg>
                        <span id="book-loader-error-text"></span>
                    </div>
                </div>
            </div>
        `;

        // Cache elements
        this._elements = {
            modal: this._container.querySelector('.modal'),
            closeBtn: this._container.querySelector('.modal-close-btn'),
            fileInput: this._container.querySelector('#book-loader-file-input'),
            browseLocalBtn: this._container.querySelector('#browse-local-btn'),
            // Search elements
            searchInput: this._container.querySelector('#gutenberg-search-input'),
            searchBtn: this._container.querySelector('#gutenberg-search-btn'),
            searchResults: this._container.querySelector('#gutenberg-search-results'),
            // Direct ID input elements
            gutenbergInput: this._container.querySelector('#book-loader-gutenberg-input'),
            loadGutenbergBtn: this._container.querySelector('#load-gutenberg-btn'),
            loading: this._container.querySelector('#book-loader-loading'),
            loadingText: this._container.querySelector('#book-loader-loading-text'),
            error: this._container.querySelector('#book-loader-error'),
            errorText: this._container.querySelector('#book-loader-error-text')
        };

        // Track search state
        this._isSearching = false;
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

        // Escape key to close
        this._escapeHandler = (e) => {
            if (e.key === 'Escape' && this.isVisible()) {
                this._callbacks.onClose?.();
            }
        };
        document.addEventListener('keydown', this._escapeHandler);

        // Browse local files button
        this._elements.browseLocalBtn.addEventListener('click', () => {
            this._elements.fileInput.click();
        });

        // File input change
        this._elements.fileInput.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (file) {
                this._hideError();
                // Create source info for local file
                const source = {
                    type: 'local',
                    filename: file.name
                };
                this._callbacks.onFileSelect?.(file, source);
            }
            // Reset file input so same file can be selected again
            e.target.value = '';
        });

        // Load from Gutenberg button
        this._elements.loadGutenbergBtn.addEventListener('click', () => {
            this._loadFromGutenberg();
        });

        // Enter key in Gutenberg input
        this._elements.gutenbergInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this._loadFromGutenberg();
            }
        });

        // Search button
        this._elements.searchBtn.addEventListener('click', () => {
            this._searchGutenberg();
        });

        // Enter key in search input
        this._elements.searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this._searchGutenberg();
            }
        });

        // Click on search results
        this._elements.searchResults.addEventListener('click', (e) => {
            const resultItem = e.target.closest('.gutenberg-search-result');
            if (resultItem) {
                const bookId = resultItem.dataset.bookId;
                if (bookId) {
                    this._hideError();
                    this._clearSearchResults();
                    this._callbacks.onGutenbergLoad?.(bookId);
                }
            }
        });
    }

    /**
     * Load book from Project Gutenberg
     */
    _loadFromGutenberg() {
        const input = this._elements.gutenbergInput.value.trim();
        if (!input) {
            this._showError('Please enter a book ID or URL');
            return;
        }

        // Extract book ID from input
        let bookId;
        if (input.includes('gutenberg.org')) {
            // Extract ID from URL
            const match = input.match(/\/(?:ebooks|files|cache\/epub)\/(\d+)/);
            if (match) {
                bookId = match[1];
            } else {
                this._showError('Invalid Project Gutenberg URL');
                return;
            }
        } else {
            // Assume it's a book ID
            bookId = input;
        }

        // Validate book ID is a number
        if (!/^\d+$/.test(bookId)) {
            this._showError('Please enter a valid book ID (numbers only) or URL');
            return;
        }

        this._hideError();
        this._callbacks.onGutenbergLoad?.(bookId);
    }

    /**
     * Search Project Gutenberg using CORS proxy
     */
    async _searchGutenberg() {
        const query = this._elements.searchInput.value.trim();
        if (!query) {
            this._showError('Please enter a search term');
            return;
        }

        if (this._isSearching) {
            return;
        }

        this._isSearching = true;
        this._hideError();
        this._showSearchLoading();

        try {
            // Step 1: Construct the target URL
            const gutenbergUrl = `https://www.gutenberg.org/ebooks/search/?query=${encodeURIComponent(query)}`;

            // Step 2: Bypass CORS with AllOrigins proxy
            const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(gutenbergUrl)}`;

            const response = await fetch(proxyUrl);
            if (!response.ok) {
                throw new Error('Failed to fetch search results');
            }

            const data = await response.json();
            if (!data.contents) {
                throw new Error('No content received from proxy');
            }

            // Step 3: Parse the HTML with DOMParser
            const parser = new DOMParser();
            const doc = parser.parseFromString(data.contents, 'text/html');

            // Step 4: Extract data using query selection
            const bookLinks = doc.querySelectorAll('.booklink');
            const results = [];

            bookLinks.forEach((bookLink) => {
                const titleEl = bookLink.querySelector('.title');
                const subtitleEl = bookLink.querySelector('.subtitle');
                const linkEl = bookLink.querySelector('a.link');

                if (titleEl && linkEl) {
                    const href = linkEl.getAttribute('href') || '';
                    // Extract book ID from href (e.g., /ebooks/84 -> 84)
                    const idMatch = href.match(/\/ebooks\/(\d+)/);
                    const bookId = idMatch ? idMatch[1] : null;

                    if (bookId) {
                        results.push({
                            id: bookId,
                            title: titleEl.textContent?.trim() || 'Unknown Title',
                            author: subtitleEl?.textContent?.trim() || 'Unknown Author'
                        });
                    }
                }
            });

            this._displaySearchResults(results, query);

        } catch (error) {
            console.error('Gutenberg search error:', error);
            this._showError(`Search failed: ${error.message}`);
            this._clearSearchResults();
        } finally {
            this._isSearching = false;
        }
    }

    /**
     * Show loading state in search results
     */
    _showSearchLoading() {
        this._elements.searchResults.classList.remove('hidden');
        this._elements.searchResults.innerHTML = `
            <div class="gutenberg-search-loading">
                <div class="spinner"></div>
                <span>Searching Project Gutenberg...</span>
            </div>
        `;
    }

    /**
     * Display search results
     * @param {Array} results - Array of book results
     * @param {string} query - Original search query
     */
    _displaySearchResults(results, query) {
        this._elements.searchResults.classList.remove('hidden');

        if (results.length === 0) {
            this._elements.searchResults.innerHTML = `
                <div class="gutenberg-search-empty">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="11" cy="11" r="8"/>
                        <path d="m21 21-4.35-4.35"/>
                    </svg>
                    <p>No books found for "${this._escapeHtml(query)}"</p>
                </div>
            `;
            return;
        }

        const resultsHtml = results.map(book => `
            <div class="gutenberg-search-result" data-book-id="${book.id}">
                <div class="result-icon">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
                        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
                    </svg>
                </div>
                <div class="result-info">
                    <div class="result-title">${this._escapeHtml(book.title)}</div>
                    <div class="result-author">${this._escapeHtml(book.author)}</div>
                </div>
                <div class="result-id">#${book.id}</div>
            </div>
        `).join('');

        this._elements.searchResults.innerHTML = `
            <div class="gutenberg-search-header">
                <span>${results.length} result${results.length !== 1 ? 's' : ''} for "${this._escapeHtml(query)}"</span>
            </div>
            <div class="gutenberg-search-list">
                ${resultsHtml}
            </div>
        `;
    }

    /**
     * Clear search results
     */
    _clearSearchResults() {
        this._elements.searchResults.classList.add('hidden');
        this._elements.searchResults.innerHTML = '';
    }

    /**
     * Escape HTML to prevent XSS
     * @param {string} str
     * @returns {string}
     */
    _escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    /**
     * Show the modal
     */
    show() {
        // Reset state
        this._elements.gutenbergInput.value = '';
        this._elements.searchInput.value = '';
        this._clearSearchResults();
        this._hideLoading();
        this._hideError();

        // Remove hidden first, then add active after a frame to trigger transition
        this._container.classList.remove('hidden');
        // Force reflow
        this._container.offsetHeight;
        this._container.classList.add('active');

        // Focus the gutenberg input for quick typing
        setTimeout(() => {
            this._elements.gutenbergInput.focus();
        }, 100);
    }

    /**
     * Hide the modal
     */
    hide() {
        this._container.classList.remove('active');
        // Add hidden after transition completes
        setTimeout(() => {
            if (!this._container.classList.contains('active')) {
                this._container.classList.add('hidden');
            }
        }, 300);
    }

    /**
     * Check if modal is visible
     * @returns {boolean}
     */
    isVisible() {
        return this._container.classList.contains('active');
    }

    /**
     * Show loading state
     * @param {string} message
     */
    showLoading(message = 'Loading...') {
        this._elements.loadingText.textContent = message;
        this._elements.loading.classList.remove('hidden');
        this._elements.browseLocalBtn.disabled = true;
        this._elements.loadGutenbergBtn.disabled = true;
    }

    /**
     * Hide loading state
     */
    _hideLoading() {
        this._elements.loading.classList.add('hidden');
        this._elements.browseLocalBtn.disabled = false;
        this._elements.loadGutenbergBtn.disabled = false;
    }

    /**
     * Hide loading state (public method)
     */
    hideLoading() {
        this._hideLoading();
    }

    /**
     * Show error message
     * @param {string} message
     */
    _showError(message) {
        this._elements.errorText.textContent = message;
        this._elements.error.classList.remove('hidden');
    }

    /**
     * Show error message (public method)
     * @param {string} message
     */
    showError(message) {
        this._hideLoading();
        this._showError(message);
    }

    /**
     * Hide error message
     */
    _hideError() {
        this._elements.error.classList.add('hidden');
    }

    /**
     * Cleanup
     */
    destroy() {
        document.removeEventListener('keydown', this._escapeHandler);
    }
}
