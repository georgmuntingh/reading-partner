/**
 * Settings Modal UI Component
 * Displays settings for TTS backend, API key, model selection, and Q&A context
 */

import { OPENROUTER_MODELS, DEFAULT_MODEL } from '../services/llm-client.js';
import { mediaSessionManager } from '../services/media-session-manager.js';

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
            fastApiUrl: 'http://localhost:8880',
            voice: 'af_bella',
            speed: 1.0,
            font: 'default',
            fontSize: 16,
            marginSize: 'medium',
            lineSpacing: 1.8,
            normalizeText: true,
            normalizeNumbers: true,
            normalizeAbbreviations: true
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
                        <h3>Voice & Speed</h3>

                        <div class="form-group">
                            <label for="settings-voice">Voice</label>
                            <select id="settings-voice" class="form-select">
                                <option value="af_bella">Bella (American Female)</option>
                            </select>
                        </div>

                        <div class="form-group">
                            <label for="settings-speed">Speed: <span id="settings-speed-value">1.0x</span></label>
                            <input type="range" id="settings-speed" class="form-input" min="0.5" max="2" step="0.1" value="1">
                        </div>
                    </div>

                    <div class="settings-section">
                        <h3>Typography</h3>

                        <div class="form-group">
                            <label for="settings-font">Font</label>
                            <select id="settings-font" class="form-select">
                                <option value="default">Default (System)</option>
                                <option value="serif">Serif</option>
                                <option value="sans-serif">Sans Serif</option>
                                <option value="georgia">Georgia</option>
                                <option value="times">Times New Roman</option>
                                <option value="palatino">Palatino</option>
                                <option value="bookerly">Bookerly</option>
                            </select>
                        </div>

                        <div class="form-group">
                            <label for="settings-font-size">Font Size: <span id="settings-font-size-value">16px</span></label>
                            <input type="range" id="settings-font-size" class="form-input" min="12" max="24" step="1" value="16">
                        </div>

                        <div class="form-group">
                            <label for="settings-margin">Page Margins</label>
                            <select id="settings-margin" class="form-select">
                                <option value="narrow">Narrow</option>
                                <option value="medium">Medium</option>
                                <option value="wide">Wide</option>
                            </select>
                        </div>

                        <div class="form-group">
                            <label for="settings-line-spacing">Line Spacing: <span id="settings-line-spacing-value">1.8</span></label>
                            <input type="range" id="settings-line-spacing" class="form-input" min="1.0" max="2.5" step="0.1" value="1.8">
                        </div>
                    </div>

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
                        <h3>Text Normalization (Kokoro)</h3>
                        <p class="form-hint" style="margin-top: 0; margin-bottom: var(--spacing-md);">
                            Control how text is processed before being sent to Kokoro TTS.
                        </p>

                        <div class="form-group">
                            <label>
                                <input type="checkbox" id="settings-normalize-text" checked>
                                Normalize Text
                            </label>
                            <p class="form-hint">Convert text to standard format (lowercase, remove extra spaces)</p>
                        </div>

                        <div class="form-group">
                            <label>
                                <input type="checkbox" id="settings-normalize-numbers" checked>
                                Normalize Numbers
                            </label>
                            <p class="form-hint">Convert numbers to words (e.g., "123" → "one hundred twenty-three")</p>
                        </div>

                        <div class="form-group">
                            <label>
                                <input type="checkbox" id="settings-normalize-abbreviations" checked>
                                Expand Abbreviations
                            </label>
                            <p class="form-hint">Expand common abbreviations (e.g., "Dr." → "Doctor", "St." → "Street")</p>
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
                        <h3>Headset Controls Diagnostics</h3>
                        <p class="form-hint" style="margin-top: 0; margin-bottom: var(--spacing-md);">
                            If headphone controls aren't working (especially on Android), use these tools to diagnose the issue.
                        </p>

                        <div id="diagnostic-status" class="form-hint" style="margin-bottom: var(--spacing-md); padding: var(--spacing-sm); background-color: var(--bg-color); border-radius: var(--radius-md);">
                            Click "Run Diagnostics" to check your system.
                        </div>

                        <div style="display: flex; gap: var(--spacing-sm); flex-wrap: wrap;">
                            <button class="btn btn-secondary btn-sm" id="run-diagnostics-btn">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 4px;">
                                    <path d="M9 12l2 2 4-4"/>
                                    <circle cx="12" cy="12" r="10"/>
                                </svg>
                                Run Diagnostics
                            </button>
                            <button class="btn btn-secondary btn-sm" id="force-start-media-btn">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 4px;">
                                    <circle cx="12" cy="12" r="10"/>
                                    <polygon points="10 8 16 12 10 16 10 8"/>
                                </svg>
                                Force Start Media Session
                            </button>
                        </div>

                        <details style="margin-top: var(--spacing-md);">
                            <summary style="cursor: pointer; font-weight: 500; margin-bottom: var(--spacing-sm);">Android Troubleshooting Guide</summary>
                            <div class="form-hint" style="line-height: 1.6;">
                                <p><strong>Common issues on Android:</strong></p>
                                <ol style="margin-left: 20px; margin-top: var(--spacing-xs);">
                                    <li><strong>No notification:</strong> Make sure you've pressed play at least once in the app</li>
                                    <li><strong>Controls not responding:</strong> Try locking and unlocking your phone</li>
                                    <li><strong>Another app controlling media:</strong> Close Spotify, YouTube, etc.</li>
                                    <li><strong>HTTPS required:</strong> Some Android versions require HTTPS for Media Session API</li>
                                    <li><strong>Chrome flags:</strong> Visit chrome://flags and ensure "Hardware Media Key Handling" is enabled</li>
                                    <li><strong>Reset:</strong> Click "Force Start Media Session" above, then try headphone controls</li>
                                </ol>
                                <p style="margin-top: var(--spacing-sm);"><strong>Testing:</strong> After pressing play in the app, check your notification shade. You should see "Reading Partner" media controls there.</p>
                            </div>
                        </details>
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
            voice: this._container.querySelector('#settings-voice'),
            speed: this._container.querySelector('#settings-speed'),
            speedValue: this._container.querySelector('#settings-speed-value'),
            font: this._container.querySelector('#settings-font'),
            fontSize: this._container.querySelector('#settings-font-size'),
            fontSizeValue: this._container.querySelector('#settings-font-size-value'),
            margin: this._container.querySelector('#settings-margin'),
            lineSpacing: this._container.querySelector('#settings-line-spacing'),
            lineSpacingValue: this._container.querySelector('#settings-line-spacing-value'),
            ttsBackend: this._container.querySelector('#settings-tts-backend'),
            fastApiUrl: this._container.querySelector('#settings-fastapi-url'),
            fastApiUrlGroup: this._container.querySelector('#settings-fastapi-url-group'),
            fastApiStatus: this._container.querySelector('#settings-fastapi-status'),
            ttsBackendHint: this._container.querySelector('#settings-tts-backend-hint'),
            normalizeText: this._container.querySelector('#settings-normalize-text'),
            normalizeNumbers: this._container.querySelector('#settings-normalize-numbers'),
            normalizeAbbreviations: this._container.querySelector('#settings-normalize-abbreviations'),
            diagnosticStatus: this._container.querySelector('#diagnostic-status'),
            runDiagnosticsBtn: this._container.querySelector('#run-diagnostics-btn'),
            forceStartMediaBtn: this._container.querySelector('#force-start-media-btn'),
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

        // Speed slider
        this._elements.speed.addEventListener('input', () => {
            const speed = parseFloat(this._elements.speed.value);
            this._elements.speedValue.textContent = `${speed.toFixed(1)}x`;
        });

        // Font size slider
        this._elements.fontSize.addEventListener('input', () => {
            const size = parseInt(this._elements.fontSize.value);
            this._elements.fontSizeValue.textContent = `${size}px`;
        });

        // Line spacing slider
        this._elements.lineSpacing.addEventListener('input', () => {
            const spacing = parseFloat(this._elements.lineSpacing.value);
            this._elements.lineSpacingValue.textContent = spacing.toFixed(1);
        });

        // Diagnostic buttons
        this._elements.runDiagnosticsBtn.addEventListener('click', () => {
            this._runDiagnostics();
        });

        this._elements.forceStartMediaBtn.addEventListener('click', async () => {
            const btn = this._elements.forceStartMediaBtn;
            btn.disabled = true;
            btn.textContent = 'Starting...';

            const success = await mediaSessionManager.forceStart();

            if (success) {
                btn.textContent = '✓ Started Successfully';
                btn.style.color = '#059669';
                setTimeout(() => {
                    btn.textContent = 'Force Start Media Session';
                    btn.style.color = '';
                    btn.disabled = false;
                }, 3000);
            } else {
                btn.textContent = '✗ Failed to Start';
                btn.style.color = '#dc2626';
                setTimeout(() => {
                    btn.textContent = 'Force Start Media Session';
                    btn.style.color = '';
                    btn.disabled = false;
                }, 3000);
            }
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
     * Run Media Session diagnostics
     */
    _runDiagnostics() {
        const statusEl = this._elements.diagnosticStatus;
        statusEl.innerHTML = '<strong>Running diagnostics...</strong>';

        // Get diagnostic info
        const info = mediaSessionManager.diagnose();

        // Format the results in a user-friendly way
        let html = '<div style="font-family: monospace; font-size: 13px;">';
        html += '<strong>📊 Diagnostic Results:</strong><br><br>';

        // Media Session Support
        html += `✓ Media Session API: ${info.supported ? '<span style="color: #059669;">Supported</span>' : '<span style="color: #dc2626;">Not Supported</span>'}<br>`;
        html += `${info.initialized ? '✓' : '✗'} Initialized: ${info.initialized}<br>`;
        html += `${info.hasUserInteraction ? '✓' : '✗'} User Interaction: ${info.hasUserInteraction}<br><br>`;

        // Audio Element
        if (info.audioElement !== 'not created') {
            html += '<strong>🔊 Audio Element:</strong><br>';
            const audioPlaying = !info.audioElement.paused;
            html += `${audioPlaying ? '✓' : '✗'} State: ${info.audioElement.paused ? 'Paused' : 'Playing'}`;

            // Explain Android behavior
            if (info.isAndroid && audioPlaying) {
                html += ' <span style="color: #059669;">(Good! Android needs this)</span>';
            } else if (info.isAndroid && !audioPlaying) {
                html += ' <span style="color: #dc2626;">(Issue! Should be playing on Android)</span>';
            }
            html += '<br>';

            html += `${info.audioElement.readyState >= 2 ? '✓' : '✗'} Ready State: ${info.audioElement.readyState}/4<br>`;
            html += `Volume: ${(info.audioElement.volume * 1000).toFixed(1)}/1000 (silent)<br><br>`;
        } else {
            html += '<strong>🔊 Audio Element:</strong> Not created<br><br>';
        }

        // Media Session State
        html += '<strong>📱 Media Session:</strong><br>';
        html += `State: ${info.mediaSession.playbackState || 'none'}<br>`;
        if (info.mediaSession.metadata) {
            html += `Title: ${info.mediaSession.metadata.title}<br>`;
        }
        html += `Q&A Mode: ${info.qaMode ? 'Active' : 'Inactive'}<br><br>`;

        // Platform detection
        const isAndroid = /Android/i.test(navigator.userAgent);
        const isHTTPS = location.protocol === 'https:';
        html += '<strong>🌐 Environment:</strong><br>';
        html += `Platform: ${isAndroid ? '<span style="color: #f59e0b;">Android</span>' : 'Other'}<br>`;
        html += `Protocol: ${isHTTPS ? '<span style="color: #059669;">HTTPS</span>' : '<span style="color: #f59e0b;">HTTP</span>'}<br><br>`;

        // Recommendations
        html += '<strong>💡 Recommendations:</strong><br>';
        const issues = [];

        if (!info.supported) {
            issues.push('⚠️ Media Session API not supported in this browser');
        }
        if (!info.hasUserInteraction) {
            issues.push('⚠️ Click "Force Start Media Session" or press play in the app');
        }
        if (info.audioElement === 'not created') {
            issues.push('⚠️ Audio element not created - try loading a book');
        }

        // Android-specific check: audio must be playing to show notification
        if (isAndroid && info.audioElement !== 'not created' && info.audioElement.paused) {
            issues.push('🚨 <strong>CRITICAL:</strong> Silent audio is paused on Android! This is why you don\'t see the notification. Click "Force Start Media Session" button above to fix this.');
        }

        if (info.audioElement !== 'not created' && info.audioElement.paused && info.mediaSession.playbackState === 'playing') {
            issues.push('⚠️ State mismatch: Media Session says playing but audio is paused');
        }
        if (isAndroid && !isHTTPS) {
            issues.push('⚠️ Android + HTTP: Some devices require HTTPS for media controls');
        }

        if (issues.length === 0) {
            html += '<span style="color: #059669;">✓ Everything looks good!<br><br>';
            html += '<strong>On Android:</strong> Check notification shade - you should see "Reading Partner" media controls.<br><br>';
            html += '<strong>If controls still don\'t work:</strong><br>';
            html += '  1. Check if notification is visible in notification shade<br>';
            html += '  2. Lock and unlock your phone<br>';
            html += '  3. Close other media apps (Spotify, YouTube)<br>';
            html += '  4. Try pressing play in the app, then use headphone controls</span>';
        } else {
            html += issues.join('<br>');
        }

        html += '</div>';

        statusEl.innerHTML = html;

        // Also log to console for detailed debugging
        console.log('=== Full Diagnostic Output ===');
        console.log(JSON.stringify(info, null, 2));
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
            fastApiUrl: this._elements.fastApiUrl.value.trim() || 'http://localhost:8880',
            voice: this._elements.voice.value,
            speed: parseFloat(this._elements.speed.value),
            font: this._elements.font.value,
            fontSize: parseInt(this._elements.fontSize.value),
            marginSize: this._elements.margin.value,
            lineSpacing: parseFloat(this._elements.lineSpacing.value),
            normalizeText: this._elements.normalizeText.checked,
            normalizeNumbers: this._elements.normalizeNumbers.checked,
            normalizeAbbreviations: this._elements.normalizeAbbreviations.checked
        };

        // Validate
        if (settings.contextBefore < 0) settings.contextBefore = 0;
        if (settings.contextBefore > 100) settings.contextBefore = 100;
        if (settings.contextAfter < 0) settings.contextAfter = 0;
        if (settings.contextAfter > 100) settings.contextAfter = 100;

        // Detect backend change
        const backendChanged = settings.ttsBackend !== this._settings.ttsBackend ||
            settings.fastApiUrl !== this._settings.fastApiUrl;

        // Detect voice/speed change
        const voiceChanged = settings.voice !== this._settings.voice;
        const speedChanged = settings.speed !== this._settings.speed;

        this._settings = settings;
        this._callbacks.onSave?.(settings);

        if (backendChanged) {
            this._callbacks.onBackendChange?.(settings.ttsBackend);
        }

        if (voiceChanged) {
            this._callbacks.onVoiceChange?.(settings.voice);
        }

        if (speedChanged) {
            this._callbacks.onSpeedChange?.(settings.speed);
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

        // Load voice & speed settings
        this._elements.voice.value = this._settings.voice || 'af_bella';
        this._elements.speed.value = this._settings.speed || 1.0;
        this._elements.speedValue.textContent = `${(this._settings.speed || 1.0).toFixed(1)}x`;

        // Load typography settings
        this._elements.font.value = this._settings.font || 'default';
        this._elements.fontSize.value = this._settings.fontSize || 16;
        this._elements.fontSizeValue.textContent = `${this._settings.fontSize || 16}px`;
        this._elements.margin.value = this._settings.marginSize || 'medium';
        this._elements.lineSpacing.value = this._settings.lineSpacing || 1.8;
        this._elements.lineSpacingValue.textContent = (this._settings.lineSpacing || 1.8).toFixed(1);

        // Load normalization settings
        this._elements.normalizeText.checked = this._settings.normalizeText !== false;
        this._elements.normalizeNumbers.checked = this._settings.normalizeNumbers !== false;
        this._elements.normalizeAbbreviations.checked = this._settings.normalizeAbbreviations !== false;

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

    /**
     * Set available voices for the voice dropdown
     * @param {{ id: string, name: string }[]} voices
     */
    setVoices(voices) {
        if (!this._elements.voice) return;

        const currentValue = this._elements.voice.value;

        // Clear existing options
        this._elements.voice.innerHTML = '';

        // Add new options
        voices.forEach(voice => {
            const option = document.createElement('option');
            option.value = voice.id;
            option.textContent = voice.name;
            this._elements.voice.appendChild(option);
        });

        // Restore previous selection if it exists
        if (voices.some(v => v.id === currentValue)) {
            this._elements.voice.value = currentValue;
        }
    }

    /**
     * Get current voice ID
     * @returns {string}
     */
    getVoice() {
        return this._settings.voice || 'af_bella';
    }

    /**
     * Get current speed
     * @returns {number}
     */
    getSpeed() {
        return this._settings.speed || 1.0;
    }
}
