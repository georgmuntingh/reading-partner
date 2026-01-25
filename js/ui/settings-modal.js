/**
 * Settings Modal UI Component
 * Displays settings for API key, model selection, and Q&A context
 */

import { OPENROUTER_MODELS, DEFAULT_MODEL } from '../services/llm-client.js';

export class SettingsModal {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.container - Container element for the modal
     * @param {Object} callbacks
     * @param {() => void} callbacks.onClose - Close modal
     * @param {(settings: Object) => void} callbacks.onSave - Save settings
     */
    constructor(options, callbacks) {
        this._container = options.container;
        this._callbacks = callbacks;

        this._settings = {
            apiKey: '',
            model: DEFAULT_MODEL,
            contextBefore: 20,
            contextAfter: 5
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
            apiKey: this._container.querySelector('#settings-api-key'),
            model: this._container.querySelector('#settings-model'),
            contextBefore: this._container.querySelector('#settings-context-before'),
            contextAfter: this._container.querySelector('#settings-context-after'),
            cancelBtn: this._container.querySelector('#settings-cancel-btn'),
            saveBtn: this._container.querySelector('#settings-save-btn')
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
     * Save settings
     */
    _save() {
        const settings = {
            apiKey: this._elements.apiKey.value.trim(),
            model: this._elements.model.value,
            contextBefore: parseInt(this._elements.contextBefore.value) || 20,
            contextAfter: parseInt(this._elements.contextAfter.value) || 5
        };

        // Validate
        if (settings.contextBefore < 0) settings.contextBefore = 0;
        if (settings.contextBefore > 100) settings.contextBefore = 100;
        if (settings.contextAfter < 0) settings.contextAfter = 0;
        if (settings.contextAfter > 100) settings.contextAfter = 100;

        this._settings = settings;
        this._callbacks.onSave?.(settings);
        this._callbacks.onClose?.();
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
}
