/**
 * Lookup Drawer UI Component
 * Bottom sheet/drawer that shows word/phrase lookup results
 */

export class LookupDrawer {
    /**
     * @param {Object} callbacks
     * @param {(phrase: string, langCode: string) => void} callbacks.onPronounce - TTS pronunciation
     * @param {() => void} callbacks.onShowHistory - Open history overlay
     */
    constructor(callbacks) {
        this._callbacks = callbacks;
        this._container = null;
        this._currentEntry = null;
        this._buildUI();
    }

    /**
     * Build the drawer DOM structure
     */
    _buildUI() {
        this._container = document.createElement('div');
        this._container.className = 'lookup-drawer';
        this._container.innerHTML = `
            <div class="lookup-drawer-handle" aria-label="Drag to resize">
                <div class="lookup-drawer-handle-bar"></div>
            </div>
            <div class="lookup-drawer-content">
                <div class="lookup-drawer-header">
                    <div class="lookup-drawer-phrase-row">
                        <span class="lookup-drawer-phrase"></span>
                        <button class="lookup-drawer-pronounce-btn" title="Pronounce" aria-label="Pronounce">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                                <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
                                <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
                            </svg>
                        </button>
                    </div>
                    <div class="lookup-drawer-meta">
                        <span class="lookup-drawer-lang"></span>
                        <span class="lookup-drawer-pos"></span>
                        <span class="lookup-drawer-domain"></span>
                    </div>
                </div>
                <div class="lookup-drawer-body">
                    <div class="lookup-drawer-pronunciation"></div>
                    <div class="lookup-drawer-definition"></div>
                    <div class="lookup-drawer-translation"></div>
                    <div class="lookup-drawer-example"></div>
                    <div class="lookup-drawer-notes"></div>
                </div>
                <div class="lookup-drawer-actions">
                    <button class="lookup-drawer-history-btn" title="View lookup history">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="12" r="10"/>
                            <polyline points="12 6 12 12 16 14"/>
                        </svg>
                        History
                    </button>
                    <button class="lookup-drawer-close-btn" title="Close">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="18" y1="6" x2="6" y2="18"/>
                            <line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </button>
                </div>
                <div class="lookup-drawer-loading hidden">
                    <div class="lookup-drawer-spinner"></div>
                    <span>Looking up...</span>
                </div>
                <div class="lookup-drawer-error hidden"></div>
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
        this._container.querySelector('.lookup-drawer-close-btn').addEventListener('click', () => {
            this.hide();
        });

        // Pronounce button
        this._container.querySelector('.lookup-drawer-pronounce-btn').addEventListener('click', () => {
            if (this._currentEntry?.result) {
                const r = this._currentEntry.result;
                this._callbacks.onPronounce?.(r.phrase || this._currentEntry.phrase, r.sourceLanguageCode || 'en');
            }
        });

        // History button
        this._container.querySelector('.lookup-drawer-history-btn').addEventListener('click', () => {
            this._callbacks.onShowHistory?.();
        });

        // Swipe down to dismiss
        let startY = 0;
        const handle = this._container.querySelector('.lookup-drawer-handle');
        handle.addEventListener('touchstart', (e) => {
            startY = e.touches[0].clientY;
        }, { passive: true });
        handle.addEventListener('touchmove', (e) => {
            const dy = e.touches[0].clientY - startY;
            if (dy > 60) {
                this.hide();
            }
        }, { passive: true });

        // Click outside to dismiss
        document.addEventListener('mousedown', (e) => {
            if (this._container.classList.contains('active') && !this._container.contains(e.target)) {
                this.hide();
            }
        });
    }

    /**
     * Show loading state
     * @param {string} phrase - The phrase being looked up
     */
    showLoading(phrase) {
        this._container.classList.add('active');
        this._container.querySelector('.lookup-drawer-phrase').textContent = phrase;
        this._container.querySelector('.lookup-drawer-loading').classList.remove('hidden');
        this._container.querySelector('.lookup-drawer-error').classList.add('hidden');
        this._container.querySelector('.lookup-drawer-body').classList.add('hidden');
        this._container.querySelector('.lookup-drawer-meta').classList.add('hidden');
        this._container.querySelector('.lookup-drawer-pronounce-btn').classList.add('hidden');
    }

    /**
     * Show a lookup result
     * @param {Object} entry - The lookup entry from LookupService
     */
    showResult(entry) {
        this._currentEntry = entry;
        const r = entry.result;

        this._container.classList.add('active');
        this._container.querySelector('.lookup-drawer-loading').classList.add('hidden');
        this._container.querySelector('.lookup-drawer-error').classList.add('hidden');
        this._container.querySelector('.lookup-drawer-body').classList.remove('hidden');
        this._container.querySelector('.lookup-drawer-meta').classList.remove('hidden');
        this._container.querySelector('.lookup-drawer-pronounce-btn').classList.remove('hidden');

        // Header
        this._container.querySelector('.lookup-drawer-phrase').textContent = r.phrase || entry.phrase;

        // Meta tags
        const langEl = this._container.querySelector('.lookup-drawer-lang');
        langEl.textContent = r.sourceLanguage || '';
        langEl.classList.toggle('hidden', !r.sourceLanguage);

        const posEl = this._container.querySelector('.lookup-drawer-pos');
        posEl.textContent = r.partOfSpeech || '';
        posEl.classList.toggle('hidden', !r.partOfSpeech);

        const domainEl = this._container.querySelector('.lookup-drawer-domain');
        domainEl.textContent = r.domain || '';
        domainEl.classList.toggle('hidden', !r.domain);

        // Body
        const pronEl = this._container.querySelector('.lookup-drawer-pronunciation');
        pronEl.textContent = r.pronunciation || '';
        pronEl.classList.toggle('hidden', !r.pronunciation);

        const defEl = this._container.querySelector('.lookup-drawer-definition');
        defEl.textContent = r.definition || '';
        defEl.classList.toggle('hidden', !r.definition);

        const transEl = this._container.querySelector('.lookup-drawer-translation');
        if (r.translation) {
            transEl.innerHTML = `<strong>Translation:</strong> ${this._escapeHtml(r.translation)}`;
            transEl.classList.remove('hidden');
        } else {
            transEl.classList.add('hidden');
        }

        const exEl = this._container.querySelector('.lookup-drawer-example');
        if (r.exampleSentence) {
            exEl.innerHTML = `<em>${this._escapeHtml(r.exampleSentence)}</em>`;
            exEl.classList.remove('hidden');
        } else {
            exEl.classList.add('hidden');
        }

        const notesEl = this._container.querySelector('.lookup-drawer-notes');
        if (r.notes) {
            notesEl.textContent = r.notes;
            notesEl.classList.remove('hidden');
        } else {
            notesEl.classList.add('hidden');
        }
    }

    /**
     * Show an error
     * @param {string} message
     */
    showError(message) {
        this._container.querySelector('.lookup-drawer-loading').classList.add('hidden');
        this._container.querySelector('.lookup-drawer-body').classList.add('hidden');
        const errorEl = this._container.querySelector('.lookup-drawer-error');
        errorEl.textContent = message;
        errorEl.classList.remove('hidden');
    }

    /**
     * Hide the drawer
     */
    hide() {
        this._container.classList.remove('active');
    }

    /**
     * Check if drawer is visible
     * @returns {boolean}
     */
    isVisible() {
        return this._container.classList.contains('active');
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
