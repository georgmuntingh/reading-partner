/**
 * Book Loader Modal UI Component
 * Modal for selecting ebooks from local filesystem or Project Gutenberg
 */

import { FORMAT_LABELS } from '../services/parser-factory.js';
import { detectPastedFormat, getFormatLabel } from '../utils/format-detector.js';
import { marked } from 'marked';
import { llmClient } from '../services/llm-client.js';

export class BookLoaderModal {
    /**
     * Maximum size for pasted content (2 MB)
     */
    static PASTE_MAX_BYTES = 2 * 1024 * 1024;

    /**
     * @param {Object} options
     * @param {HTMLElement} options.container - Container element for the modal
     * @param {Object} callbacks
     * @param {() => void} callbacks.onClose - Close modal
     * @param {(file: File, source: Object) => void} callbacks.onFileSelect - File selected from device
     * @param {(bookId: string) => void} callbacks.onGutenbergLoad - Load from Gutenberg
     * @param {(savedState: Object) => void} callbacks.onResumeBook - Resume a previously read book
     * @param {(text: string, format: string, title: string) => void} callbacks.onPasteText - Pasted text submitted
     * @param {(text: string, format: string, title: string, meta: Object) => void} callbacks.onGenerateText - LLM generated text submitted
     */
    constructor(options, callbacks) {
        this._container = options.container;
        this._callbacks = callbacks;
        this._readingHistory = [];
        this._pasteExpanded = false;
        this._generateExpanded = false;
        this._isGenerating = false;
        this._lastGenerateParams = null;
        this._lastGenerateResult = null;

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
                    <!-- Continue Reading Section (populated dynamically) -->
                    <div id="modal-continue-reading" class="modal-continue-reading hidden"></div>

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
                        <div class="paste-toggle-wrapper">
                            <button class="paste-toggle-btn" id="paste-toggle-btn">or paste text directly</button>
                        </div>
                        <div class="paste-text-section hidden" id="paste-text-section">
                            <div class="paste-title-row">
                                <input type="text" id="paste-title-input" class="form-input" placeholder="Title (optional - auto-generated from content)">
                            </div>
                            <textarea id="paste-text-input" class="paste-text-input" placeholder="Paste your Markdown, HTML, or plain text here..." rows="8"></textarea>
                            <div class="paste-meta-row">
                                <span class="paste-format-badge" id="paste-format-badge">Plain Text</span>
                                <span class="paste-char-count" id="paste-char-count">0 / 2,000,000 chars</span>
                            </div>
                            <div class="paste-preview-section hidden" id="paste-preview-section">
                                <div class="paste-preview-label">Preview</div>
                                <div class="paste-preview" id="paste-preview"></div>
                            </div>
                            <button class="btn btn-primary book-source-btn" id="paste-load-btn" disabled>
                                Load Pasted Text
                            </button>
                        </div>
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

                    <div class="book-source-divider">
                        <span>or</span>
                    </div>

                    <!-- Generate Text with LLM -->
                    <div class="book-source-option" id="generate-text-option">
                        <div class="book-source-header">
                            <div class="book-source-icon">
                                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                                    <path d="M2 17l10 5 10-5"/>
                                    <path d="M2 12l10 5 10-5"/>
                                </svg>
                            </div>
                            <div class="book-source-info">
                                <h3>Generate Text with AI</h3>
                                <p>Create reading content using LLM</p>
                            </div>
                        </div>
                        <div class="generate-text-body" id="generate-text-body">
                            <div class="generate-disabled-notice hidden" id="generate-disabled-notice">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <circle cx="12" cy="12" r="10"/>
                                    <line x1="12" y1="8" x2="12" y2="12"/>
                                    <line x1="12" y1="16" x2="12.01" y2="16"/>
                                </svg>
                                <span>Configure an API key in Settings to enable text generation.</span>
                            </div>
                            <div class="generate-form" id="generate-form">
                                <div class="generate-form-group">
                                    <label for="generate-description">Description</label>
                                    <textarea id="generate-description" class="form-input generate-description" placeholder="Describe what the text should be about..." rows="3"></textarea>
                                </div>
                                <div class="generate-form-row">
                                    <div class="generate-form-group generate-form-half">
                                        <label for="generate-language">Language</label>
                                        <select id="generate-language" class="form-select">
                                            <option value="English">English</option>
                                            <option value="Japanese">Japanese</option>
                                            <option value="Norwegian">Norwegian</option>
                                            <option value="Dutch">Dutch</option>
                                        </select>
                                    </div>
                                    <div class="generate-form-group generate-form-half">
                                        <label for="generate-length">Length</label>
                                        <select id="generate-length" class="form-select">
                                            <option value="short">Short (~300 words)</option>
                                            <option value="medium" selected>Medium (~1000 words)</option>
                                            <option value="long">Long (~3000 words)</option>
                                        </select>
                                    </div>
                                </div>
                                <div class="generate-form-row">
                                    <div class="generate-form-group generate-form-half">
                                        <label for="generate-format">Format</label>
                                        <select id="generate-format" class="form-select">
                                            <option value="markdown" selected>Markdown</option>
                                            <option value="html">HTML</option>
                                        </select>
                                    </div>
                                    <div class="generate-form-group generate-form-half">
                                        <label for="generate-genre">Genre</label>
                                        <select id="generate-genre" class="form-select">
                                            <option value="none" selected>None</option>
                                            <option value="short_story">Short Story</option>
                                            <option value="essay">Essay</option>
                                            <option value="news_article">News Article</option>
                                            <option value="childrens_story">Children's Story</option>
                                            <option value="technical">Technical</option>
                                            <option value="blog_post">Blog Post</option>
                                            <option value="letter">Letter</option>
                                            <option value="poem">Poem</option>
                                            <option value="dialogue">Dialogue</option>
                                        </select>
                                    </div>
                                </div>
                                <button class="btn btn-primary book-source-btn" id="generate-btn" disabled>
                                    Generate
                                </button>
                            </div>
                            <div class="generate-preview-section hidden" id="generate-preview-section">
                                <div class="generate-preview-header">
                                    <div class="generate-preview-label">Preview</div>
                                    <div class="generate-preview-title" id="generate-preview-title"></div>
                                </div>
                                <div class="generate-preview" id="generate-preview"></div>
                                <div class="generate-preview-actions">
                                    <button class="btn btn-secondary" id="generate-regenerate-btn">Regenerate</button>
                                    <button class="btn btn-primary" id="generate-load-btn">Load Text</button>
                                </div>
                            </div>
                        </div>
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
            continueReading: this._container.querySelector('#modal-continue-reading'),
            fileInput: this._container.querySelector('#book-loader-file-input'),
            browseLocalBtn: this._container.querySelector('#browse-local-btn'),
            // Paste text elements
            pasteToggleBtn: this._container.querySelector('#paste-toggle-btn'),
            pasteSection: this._container.querySelector('#paste-text-section'),
            pasteTitleInput: this._container.querySelector('#paste-title-input'),
            pasteTextInput: this._container.querySelector('#paste-text-input'),
            pasteFormatBadge: this._container.querySelector('#paste-format-badge'),
            pasteCharCount: this._container.querySelector('#paste-char-count'),
            pastePreviewSection: this._container.querySelector('#paste-preview-section'),
            pastePreview: this._container.querySelector('#paste-preview'),
            pasteLoadBtn: this._container.querySelector('#paste-load-btn'),
            // Generate text elements
            generateOption: this._container.querySelector('#generate-text-option'),
            generateDisabledNotice: this._container.querySelector('#generate-disabled-notice'),
            generateForm: this._container.querySelector('#generate-form'),
            generateDescription: this._container.querySelector('#generate-description'),
            generateLanguage: this._container.querySelector('#generate-language'),
            generateLength: this._container.querySelector('#generate-length'),
            generateFormat: this._container.querySelector('#generate-format'),
            generateGenre: this._container.querySelector('#generate-genre'),
            generateBtn: this._container.querySelector('#generate-btn'),
            generatePreviewSection: this._container.querySelector('#generate-preview-section'),
            generatePreviewTitle: this._container.querySelector('#generate-preview-title'),
            generatePreview: this._container.querySelector('#generate-preview'),
            generateRegenerateBtn: this._container.querySelector('#generate-regenerate-btn'),
            generateLoadBtn: this._container.querySelector('#generate-load-btn'),
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

        // Paste text toggle
        this._elements.pasteToggleBtn.addEventListener('click', () => {
            this._togglePasteSection();
        });

        // Paste text input - update preview, format badge, and char count
        this._pasteInputDebounce = null;
        this._elements.pasteTextInput.addEventListener('input', () => {
            this._updatePasteMeta();
            // Debounce preview rendering
            clearTimeout(this._pasteInputDebounce);
            this._pasteInputDebounce = setTimeout(() => {
                this._updatePastePreview();
            }, 300);
        });

        // Paste load button
        this._elements.pasteLoadBtn.addEventListener('click', () => {
            this._submitPastedText();
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

        // Generate text - enable button when description is non-empty
        this._elements.generateDescription.addEventListener('input', () => {
            this._updateGenerateBtn();
        });

        // Generate button
        this._elements.generateBtn.addEventListener('click', () => {
            this._generateText();
        });

        // Regenerate button
        this._elements.generateRegenerateBtn.addEventListener('click', () => {
            this._generateText();
        });

        // Load generated text button
        this._elements.generateLoadBtn.addEventListener('click', () => {
            this._submitGeneratedText();
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
     * Toggle the paste text section visibility
     */
    _togglePasteSection() {
        this._pasteExpanded = !this._pasteExpanded;
        if (this._pasteExpanded) {
            this._elements.pasteSection.classList.remove('hidden');
            this._elements.pasteToggleBtn.textContent = 'hide paste area';
            this._elements.pasteTextInput.focus();
        } else {
            this._elements.pasteSection.classList.add('hidden');
            this._elements.pasteToggleBtn.textContent = 'or paste text directly';
        }
    }

    /**
     * Update paste metadata (format badge, char count, load button state)
     */
    _updatePasteMeta() {
        const text = this._elements.pasteTextInput.value;
        const byteLength = new TextEncoder().encode(text).length;
        const maxBytes = BookLoaderModal.PASTE_MAX_BYTES;

        // Update char count
        const charDisplay = text.length.toLocaleString();
        const maxDisplay = maxBytes.toLocaleString();
        this._elements.pasteCharCount.textContent = `${charDisplay} / ${maxDisplay} chars`;

        // Color the count if over limit
        if (byteLength > maxBytes) {
            this._elements.pasteCharCount.classList.add('paste-char-over');
        } else {
            this._elements.pasteCharCount.classList.remove('paste-char-over');
        }

        // Update format badge
        if (text.trim()) {
            const format = detectPastedFormat(text);
            this._elements.pasteFormatBadge.textContent = getFormatLabel(format);
            this._elements.pasteFormatBadge.className = `paste-format-badge paste-format-${format}`;
        } else {
            this._elements.pasteFormatBadge.textContent = 'Plain Text';
            this._elements.pasteFormatBadge.className = 'paste-format-badge';
        }

        // Enable/disable load button
        this._elements.pasteLoadBtn.disabled = !text.trim() || byteLength > maxBytes;
    }

    /**
     * Update the live preview of pasted content
     */
    _updatePastePreview() {
        const text = this._elements.pasteTextInput.value.trim();

        if (!text) {
            this._elements.pastePreviewSection.classList.add('hidden');
            this._elements.pastePreview.innerHTML = '';
            return;
        }

        this._elements.pastePreviewSection.classList.remove('hidden');

        const format = detectPastedFormat(text);
        // Only preview first ~2000 characters for performance
        const previewText = text.substring(0, 2000);
        let previewHtml = '';

        try {
            switch (format) {
                case 'html':
                    previewHtml = this._sanitizePreviewHtml(previewText);
                    break;
                case 'markdown':
                    previewHtml = this._sanitizePreviewHtml(marked.parse(previewText));
                    break;
                case 'plaintext':
                default:
                    previewHtml = this._plainTextToPreviewHtml(previewText);
                    break;
            }
        } catch {
            previewHtml = this._plainTextToPreviewHtml(previewText);
        }

        this._elements.pastePreview.innerHTML = previewHtml;
    }

    /**
     * Sanitize HTML for safe preview rendering
     * @param {string} html
     * @returns {string}
     */
    _sanitizePreviewHtml(html) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const body = doc.body;

        // Remove dangerous elements
        body.querySelectorAll('script, style, iframe, object, embed, link').forEach(el => el.remove());

        // Remove event handler attributes
        body.querySelectorAll('*').forEach(el => {
            const attrs = [...el.attributes];
            for (const attr of attrs) {
                if (attr.name.startsWith('on') || attr.name === 'style') {
                    el.removeAttribute(attr.name);
                }
            }
        });

        return body.innerHTML;
    }

    /**
     * Convert plain text to HTML for preview
     * @param {string} text
     * @returns {string}
     */
    _plainTextToPreviewHtml(text) {
        const escaped = this._escapeHtml(text);
        const paragraphs = escaped.split(/\n{2,}/);
        return paragraphs
            .map(p => p.trim())
            .filter(p => p.length > 0)
            .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`)
            .join('');
    }

    /**
     * Submit pasted text content
     */
    _submitPastedText() {
        const text = this._elements.pasteTextInput.value;
        if (!text.trim()) {
            this._showError('Please paste some text content');
            return;
        }

        const byteLength = new TextEncoder().encode(text).length;
        if (byteLength > BookLoaderModal.PASTE_MAX_BYTES) {
            this._showError(`Content exceeds the ${(BookLoaderModal.PASTE_MAX_BYTES / 1024 / 1024).toFixed(0)} MB size limit`);
            return;
        }

        const format = detectPastedFormat(text);
        const userTitle = this._elements.pasteTitleInput.value.trim();
        const title = userTitle || this._autoGenerateTitle(text, format);

        this._hideError();
        this._callbacks.onPasteText?.(text, format, title);
    }

    /**
     * Auto-generate a title from the pasted content
     * @param {string} text
     * @param {string} format
     * @returns {string}
     */
    _autoGenerateTitle(text, format) {
        // Try to extract heading from content
        if (format === 'markdown') {
            const headingMatch = text.match(/^#\s+(.+)$/m);
            if (headingMatch) {
                return headingMatch[1].trim().substring(0, 100);
            }
        }

        if (format === 'html') {
            const parser = new DOMParser();
            const doc = parser.parseFromString(text, 'text/html');
            const title = doc.querySelector('title')?.textContent?.trim();
            if (title) return title.substring(0, 100);
            const h1 = doc.querySelector('h1')?.textContent?.trim();
            if (h1) return h1.substring(0, 100);
        }

        // Fall back to first line or first few words
        const firstLine = text.trim().split('\n')[0].replace(/^#+\s*/, '').trim();
        if (firstLine.length <= 60) {
            return firstLine || 'Pasted Text';
        }
        return firstLine.substring(0, 57) + '...';
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
     * Update the generate button enabled state
     */
    _updateGenerateBtn() {
        const hasDesc = this._elements.generateDescription.value.trim().length > 0;
        this._elements.generateBtn.disabled = !hasDesc || this._isGenerating;
    }

    /**
     * Update the generate section based on LLM availability
     */
    _updateGenerateAvailability() {
        const hasKey = llmClient.hasApiKey();
        if (hasKey) {
            this._elements.generateDisabledNotice.classList.add('hidden');
            this._elements.generateForm.classList.remove('generate-form-disabled');
            this._elements.generateDescription.disabled = false;
            this._elements.generateLanguage.disabled = false;
            this._elements.generateLength.disabled = false;
            this._elements.generateFormat.disabled = false;
            this._elements.generateGenre.disabled = false;
            this._updateGenerateBtn();
        } else {
            this._elements.generateDisabledNotice.classList.remove('hidden');
            this._elements.generateForm.classList.add('generate-form-disabled');
            this._elements.generateDescription.disabled = true;
            this._elements.generateLanguage.disabled = true;
            this._elements.generateLength.disabled = true;
            this._elements.generateFormat.disabled = true;
            this._elements.generateGenre.disabled = true;
            this._elements.generateBtn.disabled = true;
        }
    }

    /**
     * Generate text using the LLM
     */
    async _generateText() {
        const description = this._elements.generateDescription.value.trim();
        if (!description) return;

        this._isGenerating = true;
        this._elements.generateBtn.disabled = true;
        this._elements.generateBtn.textContent = 'Generating...';
        this._elements.generateRegenerateBtn.disabled = true;
        this._elements.generatePreviewSection.classList.add('hidden');
        this._hideError();

        const params = {
            description,
            language: this._elements.generateLanguage.value,
            length: this._elements.generateLength.value,
            format: this._elements.generateFormat.value,
            genre: this._elements.generateGenre.value
        };
        this._lastGenerateParams = params;

        try {
            const result = await llmClient.generateText(params);
            this._lastGenerateResult = result;

            // Show preview
            this._elements.generatePreviewTitle.textContent = result.title;

            let previewHtml = '';
            if (params.format === 'html') {
                previewHtml = this._sanitizePreviewHtml(result.content);
            } else {
                previewHtml = this._sanitizePreviewHtml(marked.parse(result.content));
            }
            this._elements.generatePreview.innerHTML = previewHtml;
            this._elements.generatePreviewSection.classList.remove('hidden');
        } catch (error) {
            if (error.message !== 'Request aborted') {
                this._showError(`Generation failed: ${error.message}`);
            }
        } finally {
            this._isGenerating = false;
            this._elements.generateBtn.textContent = 'Generate';
            this._elements.generateRegenerateBtn.disabled = false;
            this._updateGenerateBtn();
        }
    }

    /**
     * Submit the generated text to be loaded into the reader
     */
    _submitGeneratedText() {
        if (!this._lastGenerateResult || !this._lastGenerateParams) return;

        const { title, content } = this._lastGenerateResult;
        const format = this._lastGenerateParams.format;
        const meta = {
            source: 'llm-generated',
            model: llmClient.getModel(),
            language: this._lastGenerateParams.language,
            length: this._lastGenerateParams.length,
            genre: this._lastGenerateParams.genre,
            description: this._lastGenerateParams.description
        };

        this._hideError();
        this._callbacks.onGenerateText?.(content, format, title, meta);
    }

    /**
     * Set the reading history to display in the "Continue reading" section
     * @param {Object[]} history - Array of saved book states
     */
    setReadingHistory(history) {
        this._readingHistory = history || [];
    }

    /**
     * Render the "Continue reading" section based on current history
     */
    _renderContinueReading() {
        const container = this._elements.continueReading;
        if (!this._readingHistory.length) {
            container.classList.add('hidden');
            container.innerHTML = '';
            return;
        }

        container.classList.remove('hidden');

        let html = '<div class="modal-continue-reading-title">Continue reading</div>';
        html += '<div class="modal-continue-reading-list">';

        for (const savedState of this._readingHistory) {
            if (!savedState.bookId) continue;

            const timeAgo = this._formatTimeAgo(savedState.timestamp);
            const ft = savedState.fileType || 'epub';
            const ftLabel = FORMAT_LABELS[ft] || ft.toUpperCase();
            const formatBadge = `<span class="format-badge format-badge-sm format-${ft}">${ftLabel}</span>`;

            const pasteIcon = savedState.source?.type === 'pasted'
                ? '<svg class="resume-paste-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg> '
                : savedState.source?.type === 'llm-generated'
                ? '<svg class="resume-paste-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg> '
                : '';

            let sourceText = '';
            if (savedState.source?.type === 'gutenberg') {
                sourceText = ' <span class="resume-source">from Project Gutenberg</span>';
            } else if (savedState.source?.type === 'pasted') {
                sourceText = ' <span class="resume-source">pasted</span>';
            } else if (savedState.source?.type === 'llm-generated') {
                sourceText = ' <span class="resume-source">AI generated</span>';
            }

            const stats = [];
            if (savedState.bookmarkCount > 0) {
                stats.push(`${savedState.bookmarkCount} bookmark${savedState.bookmarkCount > 1 ? 's' : ''}`);
            }
            if (savedState.highlightCount > 0) {
                stats.push(`${savedState.highlightCount} highlight${savedState.highlightCount > 1 ? 's' : ''}`);
            }
            const statsText = stats.length > 0 ? ` (${stats.join(', ')})` : '';

            html += `
                <div class="modal-resume-item" data-book-id="${this._escapeHtml(savedState.bookId)}">
                    <div class="resume-info">
                        <div class="resume-detail">${formatBadge} ${pasteIcon}"${this._escapeHtml(savedState.bookTitle)}"${sourceText} - Chapter ${savedState.chapterIndex + 1}${statsText}</div>
                        <div class="resume-time">Last read ${timeAgo}</div>
                    </div>
                    <button class="btn btn-primary btn-sm resume-btn">Resume</button>
                </div>
            `;
        }

        html += '</div>';
        container.innerHTML = html;

        // Attach click handlers
        container.querySelectorAll('.modal-resume-item .resume-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const bookId = btn.closest('.modal-resume-item').dataset.bookId;
                const savedState = this._readingHistory.find(s => s.bookId === bookId);
                if (savedState) {
                    this._callbacks.onResumeBook?.(savedState);
                }
            });
        });
    }

    /**
     * Format a timestamp as a relative time string
     * @param {number} timestamp
     * @returns {string}
     */
    _formatTimeAgo(timestamp) {
        const seconds = Math.floor((Date.now() - timestamp) / 1000);
        if (seconds < 60) return 'just now';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
        const days = Math.floor(hours / 24);
        if (days < 30) return `${days} day${days > 1 ? 's' : ''} ago`;
        const months = Math.floor(days / 30);
        return `${months} month${months > 1 ? 's' : ''} ago`;
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

        // Reset paste section
        this._elements.pasteTextInput.value = '';
        this._elements.pasteTitleInput.value = '';
        this._elements.pasteSection.classList.add('hidden');
        this._elements.pastePreviewSection.classList.add('hidden');
        this._elements.pastePreview.innerHTML = '';
        this._elements.pasteLoadBtn.disabled = true;
        this._elements.pasteToggleBtn.textContent = 'or paste text directly';
        this._elements.pasteFormatBadge.textContent = 'Plain Text';
        this._elements.pasteFormatBadge.className = 'paste-format-badge';
        this._elements.pasteCharCount.textContent = `0 / ${BookLoaderModal.PASTE_MAX_BYTES.toLocaleString()} chars`;
        this._elements.pasteCharCount.classList.remove('paste-char-over');
        this._pasteExpanded = false;

        // Reset generate section
        this._elements.generateDescription.value = '';
        this._elements.generateLanguage.value = 'English';
        this._elements.generateLength.value = 'medium';
        this._elements.generateFormat.value = 'markdown';
        this._elements.generateGenre.value = 'none';
        this._elements.generatePreviewSection.classList.add('hidden');
        this._elements.generatePreview.innerHTML = '';
        this._elements.generatePreviewTitle.textContent = '';
        this._elements.generateBtn.textContent = 'Generate';
        this._elements.generateRegenerateBtn.disabled = false;
        this._isGenerating = false;
        this._lastGenerateParams = null;
        this._lastGenerateResult = null;
        this._updateGenerateAvailability();

        // Render the continue reading section
        this._renderContinueReading();

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
        this._elements.pasteLoadBtn.disabled = true;
        this._elements.generateBtn.disabled = true;
        this._elements.generateLoadBtn.disabled = true;
    }

    /**
     * Hide loading state
     */
    _hideLoading() {
        this._elements.loading.classList.add('hidden');
        this._elements.browseLocalBtn.disabled = false;
        this._elements.loadGutenbergBtn.disabled = false;
        // Re-enable paste button only if there's content
        const text = this._elements.pasteTextInput.value;
        const byteLength = new TextEncoder().encode(text).length;
        this._elements.pasteLoadBtn.disabled = !text.trim() || byteLength > BookLoaderModal.PASTE_MAX_BYTES;
        // Re-enable generate buttons
        this._updateGenerateBtn();
        this._elements.generateLoadBtn.disabled = false;
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
        clearTimeout(this._pasteInputDebounce);
    }
}
