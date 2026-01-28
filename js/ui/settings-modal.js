/**
 * Settings Modal UI Component
 * Displays settings for TTS backend, API key, model selection, and Q&A context
 */

import { OPENROUTER_MODELS, DEFAULT_MODEL } from '../services/llm-client.js';

export class SettingsModal {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.container - Container element for the modal
     * @param {Object} callbacks
     * @param {() => void} callbacks.onClose - Close modal
     * @param {(settings: Object) => void} callbacks.onSave - Save settings
     * @param {(backend: string) => void} [callbacks.onBackendChange] - Backend changed
     */
    constructor(options, callbacks) {
        this._container = options.container;
        this._callbacks = callbacks;
        this._fastApiAvailable = false;

        this._settings = {
            apiKey: '',
            model: DEFAULT_MODEL,
            contextBefore: 20,
            contextAfter: 5,
            ttsBackend: 'kokoro-js',
            fastApiUrl: 'http://localhost:8880'
        };

        this._buildUI();
        this._setupEventListeners();
    }

    /**
     * Build the modal UI
     */
    _buildUI() {
        this._container.innerHTML = `
            <div class="modal">
                <div class="modal-header">
                    <h2>Settings</h2>
                    <button class="btn-icon modal-close-btn" aria-label="Close">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="18" y1="6" x2="6" y2="18"/>
                            <line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </button>
                </div>

                <div class="modal-content">
                    <div class="settings-section">
                        <h3>TTS Backend</h3>

                        <div class="form-group">
                            <label for="settings-tts-backend">Text-to-Speech Engine</label>
                            <select id="settings-tts-backend" class="form-select">
                                <option value="kokoro-fastapi">Kokoro FastAPI (local server)</option>
                                <option value="kokoro-js">Kokoro.js (in-browser, WebGPU/WASM)</option>
                                <option value="web-speech">Browser TTS (Web Speech API)</option>
                            </select>
                            <p class="form-hint" id="settings-tts-backend-hint">
                                Kokoro FastAPI requires a local server running at the URL below.
                            </p>
                        </div>

                        <div class="form-group" id="settings-fastapi-url-group">
                            <label for="settings-fastapi-url">Kokoro FastAPI URL</label>
                            <input type="text" id="settings-fastapi-url" class="form-input" placeholder="http://localhost:8880" value="http://localhost:8880">
                            <p class="form-hint" id="settings-fastapi-status"></p>
                        </div>
                    </div>

                    <div class="settings-section">
                        <h3>Q&A Settings</h3>

                        <div class="form-group">
                            <label for="settings-api-key">OpenRouter API Key</label>
                            <input type="password" id="settings-api-key" class="form-input" placeholder="sk-or-...">
                            <p class="form-hint">
                                Get your free API key at <a href="https://openrouter.ai/keys" target="_blank" rel="noopener">openrouter.ai/keys</a>
                            </p>
                        </div>

                        <div class="form-group">
                            <label for="settings-model">AI Model</label>
                            <select id="settings-model" class="form-select">
                                <optgroup label="Free Models">
                                    ${OPENROUTER_MODELS.free.map(m => `
                                        <option value="${m.id}">${m.name}</option>
                                    `).join('')}
                                </optgroup>
                                <optgroup label="Paid Models">
                                    ${OPENROUTER_MODELS.paid.map(m => `
                                        <option value="${m.id}">${m.name}</option>
                                    `).join('')}
                                </optgroup>
                            </select>
                        </div>

                        <div class="form-group">
                            <label for="settings-context-before">Context Before (sentences)</label>
                            <input type="number" id="settings-context-before" class="form-input" min="0" max="100" value="20">
                            <p class="form-hint">Number of sentences before current position to include as context</p>
                        </div>

                        <div class="form-group">
                            <label for="settings-context-after">Context After (sentences)</label>
                            <input type="number" id="settings-context-after" class="form-input" min="0" max="100" value="5">
                            <p class="form-hint">Number of sentences after current position to include as context</p>
                        </div>
                    </div>

                    <div class="settings-section">
                        <h3>About</h3>
                        <div id="settings-about-content" class="about-content">
                            <p>Loading information...</p>
                        </div>
                    </div>
                </div>

                <div class="modal-footer">
                    <button class="btn btn-secondary" id="settings-cancel-btn">Cancel</button>
                    <button class="btn btn-primary" id="settings-save-btn">Save</button>
                </div>
            </div>
        `;

        // Cache elements
        this._elements = {
            modal: this._container.querySelector('.modal'),
            closeBtn: this._container.querySelector('.modal-close-btn'),
            ttsBackend: this._container.querySelector('#settings-tts-backend'),
            fastApiUrl: this._container.querySelector('#settings-fastapi-url'),
            fastApiUrlGroup: this._container.querySelector('#settings-fastapi-url-group'),
            fastApiStatus: this._container.querySelector('#settings-fastapi-status'),
            ttsBackendHint: this._container.querySelector('#settings-tts-backend-hint'),
            apiKey: this._container.querySelector('#settings-api-key'),
            model: this._container.querySelector('#settings-model'),
            contextBefore: this._container.querySelector('#settings-context-before'),
            contextAfter: this._container.querySelector('#settings-context-after'),
            cancelBtn: this._container.querySelector('#settings-cancel-btn'),
            saveBtn: this._container.querySelector('#settings-save-btn'),
            aboutContent: this._container.querySelector('#settings-about-content')
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

        // Cancel button
        this._elements.cancelBtn.addEventListener('click', () => {
            this._callbacks.onClose?.();
        });

        // Save button
        this._elements.saveBtn.addEventListener('click', () => {
            this._save();
        });

        // TTS backend change - toggle FastAPI URL visibility
        this._elements.ttsBackend.addEventListener('change', () => {
            this._updateBackendUI();
        });

        // Click outside to close
        this._container.addEventListener('click', (e) => {
            if (e.target === this._container) {
                this._callbacks.onClose?.();
            }
        });

        // Escape key to close
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isVisible()) {
                this._callbacks.onClose?.();
            }
        });
    }

    /**
     * Update backend-related UI visibility
     */
    _updateBackendUI() {
        const backend = this._elements.ttsBackend.value;
        const showFastApi = backend === 'kokoro-fastapi';
        this._elements.fastApiUrlGroup.style.display = showFastApi ? '' : 'none';

        // Update hint text
        const hints = {
            'kokoro-fastapi': 'Kokoro FastAPI requires a local server running at the URL below.',
            'kokoro-js': 'Runs the Kokoro TTS model directly in the browser using WebGPU or WASM.',
            'web-speech': 'Uses the browser\'s built-in speech synthesis. No setup required.'
        };
        this._elements.ttsBackendHint.textContent = hints[backend] || '';

        // Show status for FastAPI
        if (showFastApi) {
            this._elements.fastApiStatus.textContent = this._fastApiAvailable
                ? 'Server detected'
                : 'Server not detected';
            this._elements.fastApiStatus.style.color = this._fastApiAvailable
                ? '#059669'
                : '#dc2626';
        }
    }

    /**
     * Save settings
     */
    _save() {
        const settings = {
            apiKey: this._elements.apiKey.value.trim(),
            model: this._elements.model.value,
            contextBefore: parseInt(this._elements.contextBefore.value) || 20,
            contextAfter: parseInt(this._elements.contextAfter.value) || 5,
            ttsBackend: this._elements.ttsBackend.value,
            fastApiUrl: this._elements.fastApiUrl.value.trim() || 'http://localhost:8880'
        };

        // Validate
        if (settings.contextBefore < 0) settings.contextBefore = 0;
        if (settings.contextBefore > 100) settings.contextBefore = 100;
        if (settings.contextAfter < 0) settings.contextAfter = 0;
        if (settings.contextAfter > 100) settings.contextAfter = 100;

        // Detect backend change
        const backendChanged = settings.ttsBackend !== this._settings.ttsBackend ||
            settings.fastApiUrl !== this._settings.fastApiUrl;

        this._settings = settings;
        this._callbacks.onSave?.(settings);

        if (backendChanged) {
            this._callbacks.onBackendChange?.(settings.ttsBackend);
        }

        this._callbacks.onClose?.();
    }

    /**
     * Load and display build information
     */
    async _loadBuildInfo() {
        try {
            // Try both paths (dev uses /public/, production uses root)
            let response = await fetch('/public/build-info.json');
            if (!response.ok) {
                response = await fetch('/build-info.json');
            }
            const info = await response.json();

            const buildDate = new Date(info.buildTime);
            const formattedDate = buildDate.toLocaleString();

            let html = '<div class="about-info">';
            html += `<p><strong>Version:</strong> ${info.version}</p>`;
            html += `<p><strong>Last Updated:</strong> ${formattedDate}</p>`;
            html += `<p><strong>Commit:</strong> <code>${info.commitShort}</code></p>`;
            html += `<p><strong>Branch:</strong> ${info.branch}</p>`;
            html += '</div>';

            this._elements.aboutContent.innerHTML = html;
        } catch (error) {
            console.warn('Could not load build info:', error);
            this._elements.aboutContent.innerHTML = '<p class="form-hint">Build information not available</p>';
        }
    }

    /**
     * Show the modal
     */
    show() {
        // Remove hidden first, then add active after a frame to trigger transition
        this._container.classList.remove('hidden');
        // Force reflow
        this._container.offsetHeight;
        this._container.classList.add('active');
        this._loadCurrentSettings();
        this._loadBuildInfo();
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
     * Load current settings into form
     */
    _loadCurrentSettings() {
        this._elements.apiKey.value = this._settings.apiKey || '';
        this._elements.model.value = this._settings.model || DEFAULT_MODEL;
        this._elements.contextBefore.value = this._settings.contextBefore || 20;
        this._elements.contextAfter.value = this._settings.contextAfter || 5;
        this._elements.ttsBackend.value = this._settings.ttsBackend || 'kokoro-js';
        this._elements.fastApiUrl.value = this._settings.fastApiUrl || 'http://localhost:8880';
        this._updateBackendUI();
    }

    /**
     * Set settings (called when loading from storage)
     * @param {Object} settings
     */
    setSettings(settings) {
        this._settings = {
            ...this._settings,
            ...settings
        };
    }

    /**
     * Get current settings
     * @returns {Object}
     */
    getSettings() {
        return { ...this._settings };
    }

    /**
     * Check if API key is configured
     * @returns {boolean}
     */
    hasApiKey() {
        return Boolean(this._settings.apiKey && this._settings.apiKey.trim());
    }

    /**
     * Set FastAPI availability status (for UI display)
     * @param {boolean} available
     */
    setFastApiAvailable(available) {
        this._fastApiAvailable = available;
    }
}
