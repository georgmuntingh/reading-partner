/**
 * Lookup History Overlay UI Component
 * Full-screen overlay showing lookup history grouped by book, with flashcard-style reveal
 */

export class LookupHistoryOverlay {
    /**
     * @param {Object} callbacks
     * @param {(phrase: string, langCode: string) => void} callbacks.onPronounce - TTS pronunciation
     * @param {(id: string) => void} callbacks.onDelete - Delete a lookup entry
     */
    constructor(callbacks) {
        this._callbacks = callbacks;
        this._lookups = [];
        this._books = {};
        this._searchQuery = '';
        this._container = null;
        this._buildUI();
    }

    /**
     * Build the overlay DOM
     */
    _buildUI() {
        this._container = document.createElement('div');
        this._container.className = 'lookup-history-overlay';
        this._container.innerHTML = `
            <div class="lookup-history-dialog">
                <div class="lookup-history-header">
                    <h2>Lookup History</h2>
                    <button class="lookup-history-close-btn" aria-label="Close">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="18" y1="6" x2="6" y2="18"/>
                            <line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </button>
                </div>
                <div class="lookup-history-search">
                    <input type="text" class="lookup-history-search-input" placeholder="Search lookups..." />
                </div>
                <div class="lookup-history-list"></div>
            </div>
        `;
        document.body.appendChild(this._container);

        this._setupEventListeners();
    }

    /**
     * Setup event listeners
     */
    _setupEventListeners() {
        // Close button
        this._container.querySelector('.lookup-history-close-btn').addEventListener('click', () => {
            this.hide();
        });

        // Click overlay background to close
        this._container.addEventListener('click', (e) => {
            if (e.target === this._container) {
                this.hide();
            }
        });

        // Search input
        const searchInput = this._container.querySelector('.lookup-history-search-input');
        searchInput.addEventListener('input', (e) => {
            this._searchQuery = e.target.value.trim().toLowerCase();
            this._renderList();
        });

        // ESC to close
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isVisible()) {
                this.hide();
            }
        });
    }

    /**
     * Show the overlay with lookup data
     * @param {Object[]} lookups - All lookup entries (sorted by timestamp desc)
     * @param {Object} books - Map of bookId -> { title, author } for grouping
     */
    show(lookups, books = {}) {
        this._lookups = lookups;
        this._books = books;
        this._searchQuery = '';
        this._container.querySelector('.lookup-history-search-input').value = '';
        this._renderList();
        this._container.classList.add('active');
    }

    /**
     * Hide the overlay
     */
    hide() {
        this._container.classList.remove('active');
    }

    /**
     * Check if visible
     * @returns {boolean}
     */
    isVisible() {
        return this._container.classList.contains('active');
    }

    /**
     * Render the grouped lookup list
     */
    _renderList() {
        const listEl = this._container.querySelector('.lookup-history-list');
        listEl.innerHTML = '';

        // Filter by search query
        let filtered = this._lookups;
        if (this._searchQuery) {
            filtered = this._lookups.filter(l => {
                const phrase = (l.phrase || '').toLowerCase();
                const def = (l.result?.definition || '').toLowerCase();
                const trans = (l.result?.translation || '').toLowerCase();
                return phrase.includes(this._searchQuery) ||
                    def.includes(this._searchQuery) ||
                    trans.includes(this._searchQuery);
            });
        }

        if (filtered.length === 0) {
            listEl.innerHTML = '<div class="lookup-history-empty">No lookups found</div>';
            return;
        }

        // Group by bookId
        const groups = new Map();
        for (const lookup of filtered) {
            const key = lookup.bookId || 'unknown';
            if (!groups.has(key)) {
                groups.set(key, []);
            }
            groups.get(key).push(lookup);
        }

        // Render each group
        for (const [bookId, lookups] of groups) {
            const bookInfo = this._books[bookId];
            const bookTitle = bookInfo?.title || 'Unknown Book';

            const groupEl = document.createElement('div');
            groupEl.className = 'lookup-history-group';

            const headerEl = document.createElement('div');
            headerEl.className = 'lookup-history-group-header';
            headerEl.textContent = bookTitle;
            groupEl.appendChild(headerEl);

            for (const lookup of lookups) {
                groupEl.appendChild(this._renderCard(lookup));
            }

            listEl.appendChild(groupEl);
        }
    }

    /**
     * Render a single flashcard-style lookup card
     * @param {Object} lookup
     * @returns {HTMLElement}
     */
    _renderCard(lookup) {
        const card = document.createElement('div');
        card.className = 'lookup-history-card';

        const r = lookup.result || {};

        // Front: phrase + meta
        const front = document.createElement('div');
        front.className = 'lookup-history-card-front';

        let metaHtml = '';
        if (r.sourceLanguage) metaHtml += `<span class="lookup-history-tag">${this._escapeHtml(r.sourceLanguage)}</span>`;
        if (r.partOfSpeech) metaHtml += `<span class="lookup-history-tag">${this._escapeHtml(r.partOfSpeech)}</span>`;
        if (r.domain) metaHtml += `<span class="lookup-history-tag lookup-history-tag-domain">${this._escapeHtml(r.domain)}</span>`;

        front.innerHTML = `
            <div class="lookup-history-card-phrase">${this._escapeHtml(r.phrase || lookup.phrase)}</div>
            ${metaHtml ? `<div class="lookup-history-card-meta">${metaHtml}</div>` : ''}
            <div class="lookup-history-card-hint">Tap to reveal</div>
        `;

        // Back: full definition (hidden by default)
        const back = document.createElement('div');
        back.className = 'lookup-history-card-back hidden';

        let backHtml = '';
        if (r.pronunciation) {
            backHtml += `<div class="lookup-history-card-pron">${this._escapeHtml(r.pronunciation)}</div>`;
        }
        if (r.definition) {
            backHtml += `<div class="lookup-history-card-def">${this._escapeHtml(r.definition)}</div>`;
        }
        if (r.translation) {
            backHtml += `<div class="lookup-history-card-trans"><strong>Translation:</strong> ${this._escapeHtml(r.translation)}</div>`;
        }
        if (r.exampleSentence) {
            backHtml += `<div class="lookup-history-card-example"><em>${this._escapeHtml(r.exampleSentence)}</em></div>`;
        }
        if (r.notes) {
            backHtml += `<div class="lookup-history-card-notes">${this._escapeHtml(r.notes)}</div>`;
        }

        back.innerHTML = backHtml;

        // Actions row (on the back)
        const actions = document.createElement('div');
        actions.className = 'lookup-history-card-actions';
        actions.innerHTML = `
            <button class="lookup-history-card-pronounce" title="Pronounce" aria-label="Pronounce">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
                </svg>
            </button>
            <button class="lookup-history-card-delete" title="Delete" aria-label="Delete">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6l-1 14H6L5 6"/>
                    <path d="M10 11v6"/>
                    <path d="M14 11v6"/>
                </svg>
            </button>
        `;

        card.appendChild(front);
        card.appendChild(back);
        card.appendChild(actions);

        // Flashcard toggle
        let revealed = false;
        card.addEventListener('click', (e) => {
            // Don't toggle if clicking action buttons
            if (e.target.closest('.lookup-history-card-actions')) return;

            revealed = !revealed;
            front.querySelector('.lookup-history-card-hint').textContent = revealed ? 'Tap to hide' : 'Tap to reveal';
            back.classList.toggle('hidden', !revealed);
            actions.classList.toggle('hidden', !revealed);
            card.classList.toggle('revealed', revealed);
        });

        // Hide actions initially
        actions.classList.add('hidden');

        // Pronounce
        actions.querySelector('.lookup-history-card-pronounce').addEventListener('click', (e) => {
            e.stopPropagation();
            this._callbacks.onPronounce?.(r.phrase || lookup.phrase, r.sourceLanguageCode || 'en');
        });

        // Delete
        actions.querySelector('.lookup-history-card-delete').addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm('Delete this lookup?')) {
                this._callbacks.onDelete?.(lookup.id);
                card.remove();
                // Remove from internal state
                this._lookups = this._lookups.filter(l => l.id !== lookup.id);
            }
        });

        return card;
    }

    /**
     * Escape HTML
     * @param {string} text
     * @returns {string}
     */
    _escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}
