/**
 * Settings Modal UI Component
 * Displays settings for TTS backend, API key, model selection, and Q&A context
 */

import { OPENROUTER_MODELS, DEFAULT_MODEL, LOCAL_LLM_MODELS, DEFAULT_LOCAL_MODEL } from '../services/llm-client.js';
import { WHISPER_MODELS, DEFAULT_WHISPER_MODEL } from '../services/whisper-stt-service.js';
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
        this._hasWebGPU = null; // cached WebGPU availability (null = not checked)

        this._settings = {
            apiKey: '',
            model: DEFAULT_MODEL,
            fullChapterContext: false,
            contextBefore: 20,
            contextAfter: 5,
            ttsBackend: 'kokoro-js',
            kokoroDtype: 'auto',
            fastApiUrl: 'http://localhost:8880',
            voice: 'af_bella',
            speed: 1.0,
            font: 'default',
            fontSize: 16,
            marginSize: 'medium',
            verticalMargin: 2,
            lineSpacing: 1.8,
            normalizeText: true,
            normalizeNumbers: true,
            normalizeAbbreviations: true,
            // Quiz settings
            quizMode: 'multiple-choice',
            quizGuided: true,
            quizReadOptionsAloud: true,
            quizChapterScope: 'full',
            quizQuestionTypes: {
                factual: true,
                deeper_understanding: true,
                vocabulary: false,
                inference: false,
                themes: false
            },
            quizSystemPrompt: '',
            // STT settings
            sttBackend: 'web-speech',
            whisperModel: DEFAULT_WHISPER_MODEL,
            whisperDevice: 'auto',
            whisperSilenceTimeout: 3,
            whisperMaxDuration: 30,
            // LLM backend
            llmBackend: 'openrouter',
            localLlmModel: DEFAULT_LOCAL_MODEL,
            localLlmDevice: 'auto',
            // Lookup settings
            lookupLanguage: 'auto',
            // Reading history
            readingHistorySize: 3,
            // Multi-column layout
            columnCount: 1,
            columnAutoCenter: true,
            // Media session audio
            mediaSessionVolume: 0.01,
            mediaSessionDuration: 300
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
                        <h3>General</h3>

                        <div class="form-group">
                            <label for="settings-history-size">Reading History Size: <span id="settings-history-size-value">3</span></label>
                            <input type="range" id="settings-history-size" class="form-input" min="1" max="10" step="1" value="3">
                            <p class="form-hint">Number of recent books shown in "Continue reading" on the start screen</p>
                        </div>
                    </div>

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
                            <label for="settings-margin">Horizontal Margins</label>
                            <select id="settings-margin" class="form-select">
                                <option value="narrow">Narrow</option>
                                <option value="medium">Medium</option>
                                <option value="wide">Wide</option>
                            </select>
                        </div>

                        <div class="form-group">
                            <label for="settings-vertical-margin">Vertical Margins: <span id="settings-vertical-margin-value">2px</span></label>
                            <input type="range" id="settings-vertical-margin" class="form-input" min="0" max="50" step="1" value="2">
                        </div>

                        <div class="form-group">
                            <label for="settings-line-spacing">Line Spacing: <span id="settings-line-spacing-value">1.8</span></label>
                            <input type="range" id="settings-line-spacing" class="form-input" min="1.0" max="2.5" step="0.1" value="1.8">
                        </div>
                    </div>

                    <div class="settings-section">
                        <h3>Layout</h3>

                        <div class="form-group">
                            <label>Columns: <span id="settings-column-count-value">1</span></label>
                            <div class="column-count-buttons" id="settings-column-count-buttons">
                                <button class="column-count-btn active" data-columns="1">1</button>
                                <button class="column-count-btn" data-columns="2">2</button>
                                <button class="column-count-btn" data-columns="3">3</button>
                                <button class="column-count-btn" data-columns="4">4</button>
                                <button class="column-count-btn" data-columns="5">5</button>
                            </div>
                            <p class="form-hint">Number of pages displayed side by side. Useful on wide screens.</p>
                        </div>

                        <div class="form-group">
                            <label style="display: flex; align-items: center; gap: var(--spacing-sm); cursor: pointer;">
                                <input type="checkbox" id="settings-column-auto-center" checked>
                                Keep active page centered
                            </label>
                            <p class="form-hint">When enabled, the page with the current sentence stays in the center column. When disabled, the view advances only when the last visible page is reached.</p>
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

                        <div class="form-group" id="settings-kokoro-dtype-group" style="display: none;">
                            <label for="settings-kokoro-dtype">Model Precision</label>
                            <select id="settings-kokoro-dtype" class="form-select">
                                <option value="auto">Auto (recommended)</option>
                            </select>
                            <p class="form-hint" id="settings-kokoro-dtype-hint"></p>
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
                        <h3>Word Lookup</h3>

                        <div class="form-group">
                            <label for="settings-lookup-language">Translation Target Language</label>
                            <select id="settings-lookup-language" class="form-select">
                                <option value="auto">Auto (LLM decides)</option>
                                <option value="English">English</option>
                                <option value="Norwegian">Norwegian</option>
                                <option value="Dutch">Dutch</option>
                                <option value="Japanese">Japanese</option>
                                <option value="German">German</option>
                                <option value="French">French</option>
                                <option value="Spanish">Spanish</option>
                                <option value="Portuguese">Portuguese</option>
                                <option value="Italian">Italian</option>
                                <option value="Chinese">Chinese</option>
                                <option value="Korean">Korean</option>
                                <option value="Hindi">Hindi</option>
                                <option value="Russian">Russian</option>
                                <option value="Arabic">Arabic</option>
                                <option value="Swedish">Swedish</option>
                                <option value="Danish">Danish</option>
                            </select>
                            <p class="form-hint">Select text and tap "Look up" in the toolbar to look up words and phrases. When set to Auto, the LLM determines the best language for definitions/translations based on context.</p>
                        </div>
                    </div>

                    <div class="settings-section">
                        <h3>Speech Recognition</h3>

                        <div class="form-group">
                            <label for="settings-stt-backend">STT Backend</label>
                            <select id="settings-stt-backend" class="form-select">
                                <option value="web-speech">Web Speech API (Online)</option>
                                <option value="whisper">Whisper (Local, On-Device)</option>
                            </select>
                            <p class="form-hint" id="settings-stt-backend-hint">
                                Uses the browser's built-in speech recognition. Requires an internet connection.
                            </p>
                        </div>

                        <div id="settings-whisper-options" style="display: none;">
                            <div class="form-group">
                                <label for="settings-whisper-model">Whisper Model</label>
                                <select id="settings-whisper-model" class="form-select">
                                    ${WHISPER_MODELS.map(m => `
                                        <option value="${m.id}">${m.name} (${m.size})</option>
                                    `).join('')}
                                </select>
                            </div>

                            <div class="form-group">
                                <label for="settings-whisper-device">Inference Device</label>
                                <select id="settings-whisper-device" class="form-select">
                                    <option value="auto">Auto (WebGPU if available)</option>
                                    <option value="webgpu">WebGPU</option>
                                    <option value="wasm">WASM (CPU)</option>
                                </select>
                            </div>

                            <div class="form-group">
                                <label for="settings-whisper-silence-timeout">Silence Timeout: <span id="settings-whisper-silence-timeout-value">3s</span></label>
                                <input type="range" id="settings-whisper-silence-timeout" class="form-input" min="1" max="10" step="1" value="3">
                                <p class="form-hint">How long to wait after speech stops before transcribing</p>
                            </div>

                            <div class="form-group">
                                <label for="settings-whisper-max-duration">Max Recording Duration: <span id="settings-whisper-max-duration-value">30s</span></label>
                                <input type="range" id="settings-whisper-max-duration" class="form-input" min="5" max="60" step="5" value="30">
                                <p class="form-hint">Hard limit on recording length — prevents indefinite listening in noisy environments. Set to 60s to effectively disable.</p>
                            </div>

                            <div class="form-group">
                                <div class="model-status" id="settings-whisper-status">
                                    <span class="model-status-text">Model not loaded</span>
                                    <button class="btn btn-secondary btn-sm" id="settings-whisper-download-btn">Download Model</button>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div class="settings-section">
                        <h3>Q&A Settings</h3>

                        <div class="form-group">
                            <label for="settings-llm-backend">LLM Backend</label>
                            <select id="settings-llm-backend" class="form-select">
                                <option value="openrouter">OpenRouter (Cloud)</option>
                                <option value="local">Local (On-Device)</option>
                            </select>
                            <p class="form-hint" id="settings-llm-backend-hint">
                                Uses cloud AI models via OpenRouter. Requires an API key and internet connection.
                            </p>
                        </div>

                        <div id="settings-openrouter-options">
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
                        </div>

                        <div id="settings-local-llm-options" style="display: none;">
                            <div class="form-group">
                                <label for="settings-local-llm-model">Local Model</label>
                                <select id="settings-local-llm-model" class="form-select">
                                </select>
                            </div>

                            <div class="form-group">
                                <label for="settings-local-llm-device">Inference Device</label>
                                <select id="settings-local-llm-device" class="form-select">
                                    <option value="auto">Auto (WebGPU if available)</option>
                                    <option value="webgpu">WebGPU</option>
                                    <option value="wasm">WASM (CPU)</option>
                                </select>
                            </div>

                            <div class="form-group">
                                <div class="model-status" id="settings-local-llm-status">
                                    <span class="model-status-text">Model not loaded</span>
                                    <button class="btn btn-secondary btn-sm" id="settings-local-llm-download-btn">Download Model</button>
                                </div>
                            </div>
                        </div>

                        <p class="form-hint" style="margin-top: 0; margin-bottom: var(--spacing-md);">
                            Context from the book is sent to the LLM along with your question.
                            You can either send the entire current chapter, or a configurable number
                            of sentences around your reading position.
                        </p>

                        <div class="form-group">
                            <label style="display: flex; align-items: center; gap: var(--spacing-sm); cursor: pointer;">
                                <input type="checkbox" id="settings-full-chapter-context">
                                Send entire chapter as context
                            </label>
                            <p class="form-hint">When enabled, all sentences in the current chapter are sent to the LLM instead of the counts below</p>
                        </div>

                        <div class="form-group">
                            <label for="settings-context-before">Context Before (sentences)</label>
                            <input type="number" id="settings-context-before" class="form-input" min="0" max="500" value="20">
                            <p class="form-hint">Number of sentences before current position to include as context</p>
                        </div>

                        <div class="form-group">
                            <label for="settings-context-after">Context After (sentences)</label>
                            <input type="number" id="settings-context-after" class="form-input" min="0" max="500" value="5">
                            <p class="form-hint">Number of sentences after current position to include as context</p>
                        </div>
                    </div>

                    <div class="settings-section">
                        <h3>Quiz Settings</h3>

                        <div class="form-group">
                            <label for="settings-quiz-mode">Quiz Mode</label>
                            <select id="settings-quiz-mode" class="form-select">
                                <option value="multiple-choice">Multiple Choice</option>
                                <option value="free-form">Free Form</option>
                            </select>
                        </div>

                        <div class="form-group">
                            <label style="display: flex; align-items: center; gap: var(--spacing-sm); cursor: pointer;">
                                <input type="checkbox" id="settings-quiz-guided" checked>
                                Guided Mode
                            </label>
                            <p class="form-hint">When enabled, the LLM provides hints after wrong answers instead of revealing the correct answer immediately</p>
                        </div>

                        <div class="form-group">
                            <label style="display: flex; align-items: center; gap: var(--spacing-sm); cursor: pointer;">
                                <input type="checkbox" id="settings-quiz-read-options" checked>
                                Read Options Aloud
                            </label>
                            <p class="form-hint">When enabled, the TTS reads out the multiple choice answer options after the question</p>
                        </div>

                        <div class="form-group">
                            <label for="settings-quiz-scope">Chapter Scope</label>
                            <select id="settings-quiz-scope" class="form-select">
                                <option value="full">Entire chapter</option>
                                <option value="up-to-current">Up to current sentence</option>
                            </select>
                            <p class="form-hint">Determines whether questions cover the full chapter or only content up to your reading position</p>
                        </div>

                        <div class="form-group">
                            <label>Question Types</label>
                            <div style="display: flex; flex-direction: column; gap: var(--spacing-xs); margin-top: var(--spacing-xs);">
                                <label style="display: flex; align-items: center; gap: var(--spacing-sm); cursor: pointer; font-weight: normal;">
                                    <input type="checkbox" id="settings-quiz-type-factual" checked>
                                    Factual
                                </label>
                                <label style="display: flex; align-items: center; gap: var(--spacing-sm); cursor: pointer; font-weight: normal;">
                                    <input type="checkbox" id="settings-quiz-type-deeper">
                                    Deeper Understanding
                                </label>
                                <label style="display: flex; align-items: center; gap: var(--spacing-sm); cursor: pointer; font-weight: normal;">
                                    <input type="checkbox" id="settings-quiz-type-vocabulary">
                                    Vocabulary
                                </label>
                                <label style="display: flex; align-items: center; gap: var(--spacing-sm); cursor: pointer; font-weight: normal;">
                                    <input type="checkbox" id="settings-quiz-type-inference">
                                    Inference
                                </label>
                                <label style="display: flex; align-items: center; gap: var(--spacing-sm); cursor: pointer; font-weight: normal;">
                                    <input type="checkbox" id="settings-quiz-type-themes">
                                    Themes
                                </label>
                            </div>
                        </div>

                        <div class="form-group">
                            <label for="settings-quiz-system-prompt">Custom System Prompt (optional)</label>
                            <textarea id="settings-quiz-system-prompt" class="form-input" rows="3" placeholder="Override the default system prompt for quiz generation..."></textarea>
                            <p class="form-hint">Leave empty to use the default quiz generation prompt</p>
                        </div>
                    </div>

                    <div class="settings-section">
                        <h3>Headset Controls</h3>

                        <div class="form-group">
                            <label for="settings-media-volume">Media Session Volume: <span id="settings-media-volume-value">0.01</span></label>
                            <input type="range" id="settings-media-volume" class="form-input" min="0.001" max="0.1" step="0.001" value="0.01">
                            <p class="form-hint">Volume of the background audio used to keep the media session active. Lower values are less audible but may not trigger the notification on some devices.</p>
                        </div>

                        <div class="form-group">
                            <label for="settings-media-duration">Media Session Duration: <span id="settings-media-duration-value">300s</span></label>
                            <input type="range" id="settings-media-duration" class="form-input" min="10" max="600" step="10" value="300">
                            <p class="form-hint">Duration of the background audio loop in seconds. Longer durations reduce loop restarts that could interrupt the media session.</p>
                        </div>

                        <h4 style="margin-top: var(--spacing-lg);">Diagnostics</h4>
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
            historySize: this._container.querySelector('#settings-history-size'),
            historySizeValue: this._container.querySelector('#settings-history-size-value'),
            voice: this._container.querySelector('#settings-voice'),
            speed: this._container.querySelector('#settings-speed'),
            speedValue: this._container.querySelector('#settings-speed-value'),
            font: this._container.querySelector('#settings-font'),
            fontSize: this._container.querySelector('#settings-font-size'),
            fontSizeValue: this._container.querySelector('#settings-font-size-value'),
            margin: this._container.querySelector('#settings-margin'),
            verticalMargin: this._container.querySelector('#settings-vertical-margin'),
            verticalMarginValue: this._container.querySelector('#settings-vertical-margin-value'),
            lineSpacing: this._container.querySelector('#settings-line-spacing'),
            lineSpacingValue: this._container.querySelector('#settings-line-spacing-value'),
            columnCountButtons: this._container.querySelector('#settings-column-count-buttons'),
            columnCountValue: this._container.querySelector('#settings-column-count-value'),
            columnAutoCenter: this._container.querySelector('#settings-column-auto-center'),
            ttsBackend: this._container.querySelector('#settings-tts-backend'),
            fastApiUrl: this._container.querySelector('#settings-fastapi-url'),
            fastApiUrlGroup: this._container.querySelector('#settings-fastapi-url-group'),
            fastApiStatus: this._container.querySelector('#settings-fastapi-status'),
            ttsBackendHint: this._container.querySelector('#settings-tts-backend-hint'),
            kokoroDtypeGroup: this._container.querySelector('#settings-kokoro-dtype-group'),
            kokoroDtype: this._container.querySelector('#settings-kokoro-dtype'),
            kokoroDtypeHint: this._container.querySelector('#settings-kokoro-dtype-hint'),
            lookupLanguage: this._container.querySelector('#settings-lookup-language'),
            normalizeText: this._container.querySelector('#settings-normalize-text'),
            normalizeNumbers: this._container.querySelector('#settings-normalize-numbers'),
            normalizeAbbreviations: this._container.querySelector('#settings-normalize-abbreviations'),
            mediaVolume: this._container.querySelector('#settings-media-volume'),
            mediaVolumeValue: this._container.querySelector('#settings-media-volume-value'),
            mediaDuration: this._container.querySelector('#settings-media-duration'),
            mediaDurationValue: this._container.querySelector('#settings-media-duration-value'),
            diagnosticStatus: this._container.querySelector('#diagnostic-status'),
            runDiagnosticsBtn: this._container.querySelector('#run-diagnostics-btn'),
            forceStartMediaBtn: this._container.querySelector('#force-start-media-btn'),
            // STT backend
            sttBackend: this._container.querySelector('#settings-stt-backend'),
            sttBackendHint: this._container.querySelector('#settings-stt-backend-hint'),
            whisperOptions: this._container.querySelector('#settings-whisper-options'),
            whisperModel: this._container.querySelector('#settings-whisper-model'),
            whisperDevice: this._container.querySelector('#settings-whisper-device'),
            whisperSilenceTimeout: this._container.querySelector('#settings-whisper-silence-timeout'),
            whisperSilenceTimeoutValue: this._container.querySelector('#settings-whisper-silence-timeout-value'),
            whisperMaxDuration: this._container.querySelector('#settings-whisper-max-duration'),
            whisperMaxDurationValue: this._container.querySelector('#settings-whisper-max-duration-value'),
            whisperStatus: this._container.querySelector('#settings-whisper-status'),
            whisperStatusText: this._container.querySelector('#settings-whisper-status .model-status-text'),
            whisperDownloadBtn: this._container.querySelector('#settings-whisper-download-btn'),
            // LLM backend
            llmBackend: this._container.querySelector('#settings-llm-backend'),
            llmBackendHint: this._container.querySelector('#settings-llm-backend-hint'),
            openrouterOptions: this._container.querySelector('#settings-openrouter-options'),
            localLlmOptions: this._container.querySelector('#settings-local-llm-options'),
            localLlmModel: this._container.querySelector('#settings-local-llm-model'),
            localLlmDevice: this._container.querySelector('#settings-local-llm-device'),
            localLlmStatus: this._container.querySelector('#settings-local-llm-status'),
            localLlmStatusText: this._container.querySelector('#settings-local-llm-status .model-status-text'),
            localLlmDownloadBtn: this._container.querySelector('#settings-local-llm-download-btn'),
            apiKey: this._container.querySelector('#settings-api-key'),
            model: this._container.querySelector('#settings-model'),
            fullChapterContext: this._container.querySelector('#settings-full-chapter-context'),
            contextBefore: this._container.querySelector('#settings-context-before'),
            contextAfter: this._container.querySelector('#settings-context-after'),
            quizMode: this._container.querySelector('#settings-quiz-mode'),
            quizGuided: this._container.querySelector('#settings-quiz-guided'),
            quizReadOptions: this._container.querySelector('#settings-quiz-read-options'),
            quizScope: this._container.querySelector('#settings-quiz-scope'),
            quizTypeFactual: this._container.querySelector('#settings-quiz-type-factual'),
            quizTypeDeeper: this._container.querySelector('#settings-quiz-type-deeper'),
            quizTypeVocabulary: this._container.querySelector('#settings-quiz-type-vocabulary'),
            quizTypeInference: this._container.querySelector('#settings-quiz-type-inference'),
            quizTypeThemes: this._container.querySelector('#settings-quiz-type-themes'),
            quizSystemPrompt: this._container.querySelector('#settings-quiz-system-prompt'),
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

        // STT backend change
        this._elements.sttBackend.addEventListener('change', () => {
            this._updateSTTBackendUI();
        });

        // LLM backend change
        this._elements.llmBackend.addEventListener('change', () => {
            this._updateLLMBackendUI();
        });

        // Whisper download button
        this._elements.whisperDownloadBtn.addEventListener('click', () => {
            this._callbacks.onWhisperDownload?.({
                model: this._elements.whisperModel.value,
                device: this._elements.whisperDevice.value
            });
        });

        // Whisper model dropdown — show download button whenever model selection changes
        this._elements.whisperModel.addEventListener('change', () => {
            this.setWhisperStatus({ loaded: false });
        });

        // Local LLM download button
        this._elements.localLlmDownloadBtn.addEventListener('click', () => {
            this._callbacks.onLocalLlmDownload?.({
                model: this._elements.localLlmModel.value,
                device: this._elements.localLlmDevice.value
            });
        });

        // Local LLM model dropdown — show download button whenever model selection changes
        this._elements.localLlmModel.addEventListener('change', () => {
            this.setLocalLlmStatus({ loaded: false });
        });

        // Whisper silence timeout slider
        this._elements.whisperSilenceTimeout.addEventListener('input', () => {
            const val = parseInt(this._elements.whisperSilenceTimeout.value);
            this._elements.whisperSilenceTimeoutValue.textContent = `${val}s`;
        });

        // Whisper max duration slider
        this._elements.whisperMaxDuration.addEventListener('input', () => {
            const val = parseInt(this._elements.whisperMaxDuration.value);
            this._elements.whisperMaxDurationValue.textContent = `${val}s`;
        });

        // History size slider
        this._elements.historySize.addEventListener('input', () => {
            const size = parseInt(this._elements.historySize.value);
            this._elements.historySizeValue.textContent = size;
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

        // Vertical margin slider
        this._elements.verticalMargin.addEventListener('input', () => {
            const margin = parseInt(this._elements.verticalMargin.value);
            this._elements.verticalMarginValue.textContent = `${margin}px`;
        });

        // Line spacing slider
        this._elements.lineSpacing.addEventListener('input', () => {
            const spacing = parseFloat(this._elements.lineSpacing.value);
            this._elements.lineSpacingValue.textContent = spacing.toFixed(1);
        });

        // Column count buttons
        this._elements.columnCountButtons.addEventListener('click', (e) => {
            const btn = e.target.closest('.column-count-btn');
            if (!btn) return;
            const count = parseInt(btn.dataset.columns, 10);
            this._elements.columnCountButtons.querySelectorAll('.column-count-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            this._elements.columnCountValue.textContent = count;
        });

        // Media session volume slider
        this._elements.mediaVolume.addEventListener('input', () => {
            const volume = parseFloat(this._elements.mediaVolume.value);
            this._elements.mediaVolumeValue.textContent = volume.toFixed(3);
        });

        // Media session duration slider
        this._elements.mediaDuration.addEventListener('input', () => {
            const duration = parseInt(this._elements.mediaDuration.value);
            this._elements.mediaDurationValue.textContent = `${duration}s`;
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
        const showKokoroJs = backend === 'kokoro-js';
        this._elements.fastApiUrlGroup.style.display = showFastApi ? '' : 'none';
        this._elements.kokoroDtypeGroup.style.display = showKokoroJs ? '' : 'none';

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

        // Populate dtype dropdown with device-aware options
        if (showKokoroJs) {
            this._populateDtypeOptions();
        }
    }

    /**
     * Detect WebGPU availability (cached after first check)
     * @returns {Promise<boolean>}
     */
    async _detectWebGPU() {
        if (this._hasWebGPU !== null) return this._hasWebGPU;
        try {
            if (!navigator.gpu) { this._hasWebGPU = false; return false; }
            const adapter = await navigator.gpu.requestAdapter();
            this._hasWebGPU = adapter !== null;
        } catch {
            this._hasWebGPU = false;
        }
        return this._hasWebGPU;
    }

    /**
     * Populate the Kokoro dtype dropdown with device-aware labels and warnings.
     *
     * Known compatibility (ONNX Runtime Web + WebGPU, as of Feb 2026):
     * - WebGPU: only fp32 produces correct audio. fp16/q8/q4/q4f16 all produce
     *   garbled or metallic output due to an unresolved numerical overflow bug
     *   in ONNX Runtime's WebGPU execution provider.
     * - WASM: fp32 and q8 both work correctly. q8 is recommended (92 MB vs 326 MB).
     */
    async _populateDtypeOptions() {
        const hasWebGPU = await this._detectWebGPU();
        const currentValue = this._elements.kokoroDtype.value;
        const select = this._elements.kokoroDtype;

        // Define all dtype options with device-specific metadata
        const allOptions = [
            {
                value: 'auto',
                label: hasWebGPU
                    ? 'Auto — fp32 on WebGPU, q8 on WASM (recommended)'
                    : 'Auto — q8 on WASM (recommended)',
                broken: false
            },
            { value: 'fp32', label: 'fp32 — Full precision (326 MB)', broken: false },
            {
                value: 'fp16',
                label: hasWebGPU
                    ? 'fp16 — Half precision (163 MB) — broken on WebGPU'
                    : 'fp16 — Half precision (163 MB)',
                broken: hasWebGPU
            },
            {
                value: 'q8',
                label: hasWebGPU
                    ? 'q8 — 8-bit quantized (92 MB) — broken on WebGPU'
                    : 'q8 — 8-bit quantized (92 MB)',
                broken: hasWebGPU
            },
            {
                value: 'q4',
                label: hasWebGPU
                    ? 'q4 — 4-bit quantized (305 MB) — broken on WebGPU'
                    : 'q4 — 4-bit quantized (305 MB)',
                broken: hasWebGPU
            },
            {
                value: 'q4f16',
                label: hasWebGPU
                    ? 'q4f16 — 4-bit + fp16 (154 MB) — broken on WebGPU'
                    : 'q4f16 — 4-bit + fp16 (154 MB)',
                broken: hasWebGPU
            }
        ];

        select.innerHTML = '';
        for (const opt of allOptions) {
            const el = document.createElement('option');
            el.value = opt.value;
            el.textContent = opt.label;
            select.appendChild(el);
        }

        // Restore previous selection
        if (allOptions.some(o => o.value === currentValue)) {
            select.value = currentValue;
        }

        // Update hint text
        if (hasWebGPU) {
            this._elements.kokoroDtypeHint.textContent =
                'Your browser supports WebGPU. Only fp32 produces correct audio on WebGPU — ' +
                'all quantized formats (q8, q4, fp16, q4f16) produce garbled or metallic output ' +
                'due to a known ONNX Runtime overflow bug. Use Auto or fp32 for WebGPU.';
        } else {
            this._elements.kokoroDtypeHint.textContent =
                'WebGPU not available — using WASM (CPU). q8 is recommended (92 MB). ' +
                'fp32 offers slightly higher fidelity but is larger (326 MB) and slower on CPU.';
        }
    }

    /**
     * Update STT backend UI visibility
     */
    _updateSTTBackendUI() {
        const backend = this._elements.sttBackend.value;
        const showWhisper = backend === 'whisper';
        this._elements.whisperOptions.style.display = showWhisper ? '' : 'none';

        const hints = {
            'web-speech': "Uses the browser's built-in speech recognition. Requires an internet connection.",
            'whisper': 'Runs the Whisper speech recognition model locally on your device. Works offline.'
        };
        this._elements.sttBackendHint.textContent = hints[backend] || '';
    }

    /**
     * Update LLM backend UI visibility
     */
    _updateLLMBackendUI() {
        const backend = this._elements.llmBackend.value;
        const showOpenRouter = backend === 'openrouter';
        const showLocal = backend === 'local';

        this._elements.openrouterOptions.style.display = showOpenRouter ? '' : 'none';
        this._elements.localLlmOptions.style.display = showLocal ? '' : 'none';

        const hints = {
            'openrouter': 'Uses cloud AI models via OpenRouter. Requires an API key and internet connection.',
            'local': 'Runs a small language model locally on your device. Works offline but produces simpler responses.'
        };
        this._elements.llmBackendHint.textContent = hints[backend] || '';
    }

    /**
     * Update Whisper model status display
     * @param {{ loaded: boolean, loading: boolean, statusText?: string }} status
     */
    setWhisperStatus(status) {
        if (status.loading) {
            this._elements.whisperStatusText.textContent = status.statusText || 'Loading...';
            this._elements.whisperDownloadBtn.style.display = 'none';
        } else if (status.loaded) {
            this._elements.whisperStatusText.textContent = status.statusText || 'Model ready';
            this._elements.whisperStatusText.style.color = '#059669';
            this._elements.whisperDownloadBtn.style.display = 'none';
        } else {
            this._elements.whisperStatusText.textContent = status.statusText || 'Model not loaded';
            this._elements.whisperStatusText.style.color = '';
            this._elements.whisperDownloadBtn.style.display = '';
        }
    }

    /**
     * Update Local LLM model status display
     * @param {{ loaded: boolean, loading: boolean, statusText?: string }} status
     */
    setLocalLlmStatus(status) {
        if (status.loading) {
            this._elements.localLlmStatusText.textContent = status.statusText || 'Loading...';
            this._elements.localLlmDownloadBtn.style.display = 'none';
        } else if (status.loaded) {
            this._elements.localLlmStatusText.textContent = status.statusText || 'Model ready';
            this._elements.localLlmStatusText.style.color = '#059669';
            this._elements.localLlmDownloadBtn.style.display = 'none';
        } else {
            this._elements.localLlmStatusText.textContent = status.statusText || 'Model not loaded';
            this._elements.localLlmStatusText.style.color = '';
            this._elements.localLlmDownloadBtn.style.display = '';
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
            html += `Volume: ${info.audioElement.volume}<br><br>`;
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
            readingHistorySize: parseInt(this._elements.historySize.value) || 3,
            apiKey: this._elements.apiKey.value.trim(),
            model: this._elements.model.value,
            fullChapterContext: this._elements.fullChapterContext.checked,
            contextBefore: parseInt(this._elements.contextBefore.value) || 20,
            contextAfter: parseInt(this._elements.contextAfter.value) || 5,
            ttsBackend: this._elements.ttsBackend.value,
            kokoroDtype: this._elements.kokoroDtype.value,
            fastApiUrl: this._elements.fastApiUrl.value.trim() || 'http://localhost:8880',
            voice: this._elements.voice.value,
            speed: parseFloat(this._elements.speed.value),
            font: this._elements.font.value,
            fontSize: parseInt(this._elements.fontSize.value),
            marginSize: this._elements.margin.value,
            verticalMargin: parseInt(this._elements.verticalMargin.value),
            lineSpacing: parseFloat(this._elements.lineSpacing.value),
            columnCount: parseInt(this._elements.columnCountButtons.querySelector('.column-count-btn.active')?.dataset.columns || '1', 10),
            columnAutoCenter: this._elements.columnAutoCenter.checked,
            normalizeText: this._elements.normalizeText.checked,
            normalizeNumbers: this._elements.normalizeNumbers.checked,
            normalizeAbbreviations: this._elements.normalizeAbbreviations.checked,
            // STT settings
            sttBackend: this._elements.sttBackend.value,
            whisperModel: this._elements.whisperModel.value,
            whisperDevice: this._elements.whisperDevice.value,
            whisperSilenceTimeout: parseInt(this._elements.whisperSilenceTimeout.value) || 3,
            whisperMaxDuration: parseInt(this._elements.whisperMaxDuration.value) || 30,
            // LLM backend settings
            llmBackend: this._elements.llmBackend.value,
            localLlmModel: this._elements.localLlmModel.value,
            localLlmDevice: this._elements.localLlmDevice.value,
            // Lookup settings
            lookupLanguage: this._elements.lookupLanguage.value,
            // Quiz settings
            quizMode: this._elements.quizMode.value,
            quizGuided: this._elements.quizGuided.checked,
            quizReadOptionsAloud: this._elements.quizReadOptions.checked,
            quizChapterScope: this._elements.quizScope.value,
            quizQuestionTypes: {
                factual: this._elements.quizTypeFactual.checked,
                deeper_understanding: this._elements.quizTypeDeeper.checked,
                vocabulary: this._elements.quizTypeVocabulary.checked,
                inference: this._elements.quizTypeInference.checked,
                themes: this._elements.quizTypeThemes.checked
            },
            quizSystemPrompt: this._elements.quizSystemPrompt.value.trim(),
            // Media session settings
            mediaSessionVolume: parseFloat(this._elements.mediaVolume.value) || 0.01,
            mediaSessionDuration: parseInt(this._elements.mediaDuration.value) || 300
        };

        // Validate
        if (settings.contextBefore < 0) settings.contextBefore = 0;
        if (settings.contextBefore > 500) settings.contextBefore = 500;
        if (settings.contextAfter < 0) settings.contextAfter = 0;
        if (settings.contextAfter > 500) settings.contextAfter = 500;

        // Detect backend change (includes dtype change since it requires reinit)
        const backendChanged = settings.ttsBackend !== this._settings.ttsBackend ||
            settings.fastApiUrl !== this._settings.fastApiUrl ||
            settings.kokoroDtype !== this._settings.kokoroDtype;

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
        // General settings
        this._elements.historySize.value = this._settings.readingHistorySize || 3;
        this._elements.historySizeValue.textContent = this._settings.readingHistorySize || 3;

        this._elements.apiKey.value = this._settings.apiKey || '';
        this._elements.model.value = this._settings.model || DEFAULT_MODEL;
        this._elements.fullChapterContext.checked = !!this._settings.fullChapterContext;
        this._elements.contextBefore.value = this._settings.contextBefore || 20;
        this._elements.contextAfter.value = this._settings.contextAfter || 5;
        this._elements.ttsBackend.value = this._settings.ttsBackend || 'kokoro-js';
        this._elements.kokoroDtype.value = this._settings.kokoroDtype || 'auto';
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
        this._elements.verticalMargin.value = this._settings.verticalMargin !== undefined ? this._settings.verticalMargin : 2;
        this._elements.verticalMarginValue.textContent = `${this._elements.verticalMargin.value}px`;
        this._elements.lineSpacing.value = this._settings.lineSpacing || 1.8;
        this._elements.lineSpacingValue.textContent = (this._settings.lineSpacing || 1.8).toFixed(1);

        // Load column settings
        const columnCount = this._settings.columnCount || 1;
        this._elements.columnCountValue.textContent = columnCount;
        this._elements.columnCountButtons.querySelectorAll('.column-count-btn').forEach(btn => {
            btn.classList.toggle('active', parseInt(btn.dataset.columns, 10) === columnCount);
        });
        this._elements.columnAutoCenter.checked = this._settings.columnAutoCenter !== false;

        // Load normalization settings
        this._elements.normalizeText.checked = this._settings.normalizeText !== false;
        this._elements.normalizeNumbers.checked = this._settings.normalizeNumbers !== false;
        this._elements.normalizeAbbreviations.checked = this._settings.normalizeAbbreviations !== false;

        // Load STT settings
        this._elements.sttBackend.value = this._settings.sttBackend || 'web-speech';
        this._elements.whisperModel.value = this._settings.whisperModel || DEFAULT_WHISPER_MODEL;
        this._elements.whisperDevice.value = this._settings.whisperDevice || 'auto';
        const silenceTimeout = this._settings.whisperSilenceTimeout || 3;
        this._elements.whisperSilenceTimeout.value = silenceTimeout;
        this._elements.whisperSilenceTimeoutValue.textContent = `${silenceTimeout}s`;
        const maxDuration = this._settings.whisperMaxDuration || 30;
        this._elements.whisperMaxDuration.value = maxDuration;
        this._elements.whisperMaxDurationValue.textContent = `${maxDuration}s`;
        this._updateSTTBackendUI();

        // Load LLM backend settings — rebuild options each time so new models are always visible
        this._elements.llmBackend.value = this._settings.llmBackend || 'openrouter';
        this._elements.localLlmModel.innerHTML = LOCAL_LLM_MODELS.map(m =>
            `<option value="${m.id}">${m.name} (${m.size})</option>`
        ).join('');
        this._elements.localLlmModel.value = this._settings.localLlmModel || DEFAULT_LOCAL_MODEL;
        this._elements.localLlmDevice.value = this._settings.localLlmDevice || 'auto';
        this._updateLLMBackendUI();

        // Load lookup settings
        this._elements.lookupLanguage.value = this._settings.lookupLanguage || 'auto';

        // Load quiz settings
        this._elements.quizMode.value = this._settings.quizMode || 'multiple-choice';
        this._elements.quizGuided.checked = this._settings.quizGuided !== false;
        this._elements.quizReadOptions.checked = this._settings.quizReadOptionsAloud !== false;
        this._elements.quizScope.value = this._settings.quizChapterScope || 'full';
        const qt = this._settings.quizQuestionTypes || {};
        this._elements.quizTypeFactual.checked = qt.factual !== false;
        this._elements.quizTypeDeeper.checked = !!qt.deeper_understanding;
        this._elements.quizTypeVocabulary.checked = !!qt.vocabulary;
        this._elements.quizTypeInference.checked = !!qt.inference;
        this._elements.quizTypeThemes.checked = !!qt.themes;
        this._elements.quizSystemPrompt.value = this._settings.quizSystemPrompt || '';

        // Load media session settings
        this._elements.mediaVolume.value = this._settings.mediaSessionVolume || 0.01;
        this._elements.mediaVolumeValue.textContent = (this._settings.mediaSessionVolume || 0.01).toFixed(3);
        this._elements.mediaDuration.value = this._settings.mediaSessionDuration || 300;
        this._elements.mediaDurationValue.textContent = `${this._settings.mediaSessionDuration || 300}s`;

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
            option.textContent = voice.disabled
                ? `${voice.name} (FastAPI only)`
                : voice.name;
            option.disabled = !!voice.disabled;
            this._elements.voice.appendChild(option);
        });

        // Restore previous selection if it exists and is not disabled
        if (voices.some(v => v.id === currentValue && !v.disabled)) {
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
