/**
 * Settings Modal UI Component
 * Displays settings organized into sections: General, Appearance, TTS, STT, LLM, Quiz, and About
 */

import { OPENROUTER_MODELS, DEFAULT_MODEL, LOCAL_LLM_MODELS, DEFAULT_LOCAL_MODEL, MEDIAPIPE_LLM_MODEL, DEFAULT_LMSTUDIO_ENDPOINT, DEFAULT_LMSTUDIO_CHAT_MODEL } from '../services/llm-client.js';
import { DEFAULT_LMSTUDIO_EMBEDDING_MODEL } from '../services/embedding-provider.js';
import { WHISPER_MODELS, DEFAULT_WHISPER_MODEL } from '../services/whisper-stt-service.js';
import { mediaSessionManager } from '../services/media-session-manager.js';
import { appLogger } from '../services/app-logger.js';

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
        // LM Studio discovery cache. Populated by setLmstudioAvailability().
        this._lmstudioAvailable = false;
        this._lmstudioChatModels = [];
        this._lmstudioEmbeddingModels = [];

        this._settings = {
            apiKey: '',
            model: DEFAULT_MODEL,
            fullChapterContext: false,
            contextBefore: 20,
            contextAfter: 5,
            ttsBackend: 'kokoro-js',
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
            quizChapterScope: 'full',
            // Quiz TTS toggles (all off by default)
            quizTtsQuestion: false,
            quizTtsOptions: false,
            quizTtsCorrectness: false,
            quizTtsExplanation: false,
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
            localLlmDeferTts: false,
            localLlmJitLoading: true,
            mediapipeLlmHfToken: '',
            // LM Studio (local OpenAI-compatible server). Shared between the
            // top-level LLM section and the Knowledge Graph subsections so the
            // user only has to point at their server once.
            lmstudioEndpoint: DEFAULT_LMSTUDIO_ENDPOINT,
            lmstudioChatModel: DEFAULT_LMSTUDIO_CHAT_MODEL,
            lmstudioEmbeddingModel: DEFAULT_LMSTUDIO_EMBEDDING_MODEL,
            // Lookup settings
            lookupLanguage: 'auto',
            // Reading history
            readingHistorySize: 3,
            // Multi-column layout
            columnCount: 1,
            columnAutoCenter: true,
            // Media session audio
            mediaSessionVolume: 0.01,
            mediaSessionDuration: 300,
            // Transformers.js version
            transformersVersion: '3',
            // Diagnostics
            verboseLogging: false,
            kokoroReinitThreshold: 25,
            // Knowledge Graph
            kgExtractionBackend: 'openrouter',
            kgChunkSize: 6,
            kgChunkOverlap: 2,
            kgChunksPerRequest: 4,
            kgSimilarityThreshold: 0.88,
            // Permissive extraction-time floor. Tier-2 anchor relevance below
            // this is dropped at write time; the UI slider in graph explorer
            // defaults to a stricter 0.25 but can drag down to reveal the
            // 0.15–0.24 band that is preserved on disk.
            kgRelevanceThreshold: 0.15,
            // Mouse-wheel zoom speed in the graph explorer. Cytoscape's
            // documented default is 1.0; we expose this so users with
            // high-resolution wheels can dial it down and trackpad users
            // can dial it up.
            kgWheelSensitivity: 1.0,
            // Force-directed layout (fcose) tuning. Higher repulsion / edge
            // length / separation spread dense graphs further apart so nodes
            // stop overlapping; more iterations let the layout settle better
            // at the cost of a slower Re-layout pass. Gravity pulls every
            // node toward the centre — lower values let clusters drift out.
            kgFcoseNodeRepulsion: 8000,
            kgFcoseIdealEdgeLength: 80,
            kgFcoseNodeSeparation: 100,
            kgFcoseGravity: 0.25,
            kgFcoseNumIter: 2500,
            // Whether each layout pass zooms/pans to bring the whole graph
            // into view. Off lets the user keep their manual viewport across
            // Re-layouts — handy with high idealEdgeLength when the graph
            // extends past the viewport on purpose.
            kgFcoseFit: true,
            // How strongly node size grows with degree. 0 = uniform,
            // 1 = default (30–70 px), higher exaggerates hubs.
            kgNodeSizeScale: 1.0,
            // How many hops of neighbours stay in focus when a node is
            // clicked. 0 = highlight only the clicked node; 1 = direct
            // neighbours; etc. Background tap clears the focus.
            kgNeighborhoodHops: 1,
            // Search mode used by the explorer's search box. 'text' is a
            // plain case-insensitive substring match against canonicalName
            // and aliases; 'semantic' embeds the query and ranks every
            // node's stored embedding by cosine, keeping those above
            // kgSemanticSearchThreshold.
            kgSearchMode: 'text',
            kgSemanticSearchThreshold: 0.5,
            // Embedding backend — defaults to cloud (uses the OpenRouter API key
            // configured for Q&A) so first-time users don't have to wait on a
            // local model download.
            kgEmbeddingSource: 'openrouter',
            kgCloudEmbeddingModel: 'openai/text-embedding-3-small',
            kgLocalEmbeddingModel: 'Xenova/all-MiniLM-L6-v2',
            // Spaced Review (Grounded SRS) — decoupled flashcards. See
            // docs in js/services/srs-*.js. Defaults are tuned for SM-2.
            srsEnabled: true,
            // 'padding' = fetch ±N sentences around each context hit;
            // 'whole-chapter' = pass the full chapter (more tokens, more
            // narrative context). 'padding' keeps prompts small.
            srsPaddingMode: 'padding',
            srsPaddingSentences: 3,
            // Generation triggers (both can be on; whichever fires first wins).
            srsTriggerOnChapterFinish: true,
            srsTriggerLazyOnOpen: true,
            // SM-2 scheduling knobs. `srsFailIntervalMinutes` is the
            // re-test delay after an incorrect answer — the only "interval"
            // a user normally needs to tune. The rest are SM-2 internals
            // exposed for power users.
            srsFailIntervalMinutes: 10,
            srsEaseDefault: 2.5,
            srsEaseMin: 1.3,
            srsEaseStepFail: 0.2,
            // Session limits keep a review session from being overwhelming
            // when a chapter dump produces dozens of new cards.
            srsMaxNewPerSession: 10,
            srsMaxReviewsPerSession: 30,
            // Generation knobs.
            srsDistractorCount: 3,
            srsLLMTemperature: 0.4
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
                    <!-- ===== General ===== -->
                    <details class="settings-section">
                        <summary class="settings-section-header">
                            <span>General</span>
                            <svg class="settings-section-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                        </summary>

                        <div class="form-group">
                            <label for="settings-history-size">Reading History Size: <span id="settings-history-size-value">3</span></label>
                            <input type="range" id="settings-history-size" class="form-input" min="1" max="10" step="1" value="3">
                            <p class="form-hint">Number of recent books shown in "Continue reading" on the start screen</p>
                        </div>

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

                        <div class="settings-subsection-header">Headset Controls</div>

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

                        <div class="settings-subsection-header">Diagnostics</div>

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

                        <div class="settings-subsection-header">Advanced</div>

                        <div class="form-group">
                            <label for="settings-transformers-version">Transformers.js Version</label>
                            <select id="settings-transformers-version" class="form-select">
                                <option value="3">v3 (stable)</option>
                                <option value="4">v4 (preview)</option>
                            </select>
                            <p class="form-hint">Version of the @huggingface/transformers library used for local STT and LLM inference. Changing this requires a page reload to take effect.</p>
                        </div>

                        <div class="form-group">
                            <label class="checkbox-label">
                                <input type="checkbox" id="settings-verbose-logging">
                                <span>Verbose logging</span>
                            </label>
                            <p class="form-hint">Log detailed per-sentence TTS and playback info. Useful for crash diagnosis but adds minor overhead. Critical events (errors, app lifecycle) are always logged.</p>
                        </div>

                        <div class="form-group">
                            <label for="settings-reinit-threshold">Kokoro reinit interval</label>
                            <input type="number" id="settings-reinit-threshold" class="form-input" min="5" max="200" step="1" style="width: 80px;">
                            <p class="form-hint">Recreate the Kokoro TTS engine after this many inferences to reclaim WASM memory. Lower values use less memory but cause brief pauses. Default: 25.</p>
                        </div>

                        <div class="settings-subsection-header">Application Log</div>

                        <p class="form-hint" style="margin-top: 0; margin-bottom: var(--spacing-md);">
                            View the recent activity log. Useful for diagnosing issues or inspecting what happened before a crash.
                        </p>

                        <div style="display: flex; gap: var(--spacing-sm); flex-wrap: wrap; margin-bottom: var(--spacing-sm);">
                            <button class="btn btn-secondary btn-sm" id="settings-view-log-btn">View Log</button>
                            <button class="btn btn-secondary btn-sm" id="settings-clear-log-btn">Clear Log</button>
                        </div>

                        <div id="settings-log-viewer" style="display: none; max-height: 300px; overflow-y: auto; background: var(--bg-color); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: var(--spacing-sm); font-family: monospace; font-size: 12px; white-space: pre-wrap; word-break: break-all;">
                        </div>
                    </details>

                    <!-- ===== Appearance ===== -->
                    <details class="settings-section">
                        <summary class="settings-section-header">
                            <span>Appearance</span>
                            <svg class="settings-section-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                        </summary>

                        <div class="settings-subsection-header">Typography</div>

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
                            <label for="settings-line-spacing">Line Spacing: <span id="settings-line-spacing-value">1.8</span></label>
                            <input type="range" id="settings-line-spacing" class="form-input" min="1.0" max="2.5" step="0.1" value="1.8">
                        </div>

                        <div class="settings-subsection-header">Layout</div>

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
                    </details>

                    <!-- ===== Text-to-Speech (TTS) ===== -->
                    <details class="settings-section">
                        <summary class="settings-section-header">
                            <span>Text-to-Speech (TTS)</span>
                            <svg class="settings-section-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                        </summary>

                        <div class="form-group">
                            <label for="settings-tts-backend">TTS Engine</label>
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

                        <div class="settings-subsection-header">Voice &amp; Speed</div>

                        <div class="form-group">
                            <label for="settings-voice">Voice</label>
                            <select id="settings-voice" class="form-select">
                                <option value="af_bella">Bella (American Female)</option>
                            </select>
                        </div>

                        <div class="form-group" id="settings-custom-voice-group">
                            <label for="settings-custom-voice">Custom Voice Combination (FastAPI only)</label>
                            <input type="text" id="settings-custom-voice" class="form-input" placeholder="e.g. af_alloy(1.0)+af_sarah(1.0)">
                            <p class="form-hint">Enter a Kokoro voice blend. When non-empty, overrides the voice selection above.</p>
                        </div>

                        <div class="form-group">
                            <label for="settings-speed">Speed: <span id="settings-speed-value">1.0x</span></label>
                            <input type="range" id="settings-speed" class="form-input" min="0.5" max="2" step="0.1" value="1">
                        </div>

                        <div class="form-group">
                            <label for="settings-prefetch-count">Precache Sentences: <span id="settings-prefetch-count-value">2</span></label>
                            <input type="range" id="settings-prefetch-count" class="form-input" min="1" max="10" step="1" value="2">
                            <p class="form-hint">Number of sentences to buffer ahead during playback. Lower values use less memory; higher values reduce buffering pauses.</p>
                        </div>

                        <div class="settings-subsection-header">Sentence Splitting</div>

                        <div class="form-group">
                            <label for="settings-max-sentence-length">Max Sentence Length: <span id="settings-max-sentence-length-value">Off</span></label>
                            <input type="range" id="settings-max-sentence-length" class="form-input" min="0" max="1000" step="50" value="0">
                            <p class="form-hint">Maximum number of characters per sentence. Long sentences are split at natural punctuation (commas, semicolons, dashes) or, if necessary, at spaces. Set to 0 (Off) for no limit. Changing this reloads the current chapter.</p>
                        </div>

                        <div class="settings-subsection-header">Text Normalization (Kokoro)</div>

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
                    </details>

                    <!-- ===== Speech Recognition (STT) ===== -->
                    <details class="settings-section">
                        <summary class="settings-section-header">
                            <span>Speech Recognition (STT)</span>
                            <svg class="settings-section-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                        </summary>

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
                            <div class="settings-subsection-header">Whisper</div>

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
                    </details>

                    <!-- ===== Language Model (LLM) ===== -->
                    <details class="settings-section">
                        <summary class="settings-section-header">
                            <span>Language Model (LLM)</span>
                            <svg class="settings-section-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                        </summary>

                        <div class="form-group">
                            <label for="settings-llm-backend">LLM Backend</label>
                            <select id="settings-llm-backend" class="form-select">
                                <option value="openrouter">OpenRouter (Cloud)</option>
                                <option value="local">Local/transformers.js (On-Device)</option>
                                <option value="mediapipe">MediaPipe/Gemma3 (On-Device, WebGPU)</option>
                                <option value="lmstudio">LM Studio (Local Server)</option>
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

                        <div id="settings-mediapipe-llm-options" style="display: none;">
                            <div class="form-group">
                                <label>Model</label>
                                <p class="form-hint" style="margin-top: 0;">
                                    ${MEDIAPIPE_LLM_MODEL.name} (${MEDIAPIPE_LLM_MODEL.size}) &mdash;
                                    ${MEDIAPIPE_LLM_MODEL.description}
                                </p>
                            </div>

                            <div class="form-group">
                                <label for="settings-mediapipe-hf-token">HuggingFace Access Token</label>
                                <input type="password" id="settings-mediapipe-hf-token" class="form-input"
                                    placeholder="hf_...">
                                <p class="form-hint">
                                    Required for the first download. Accept the Gemma licence at
                                    <a href="https://huggingface.co/litert-community/Gemma3-1B-IT" target="_blank" rel="noopener">huggingface.co/litert-community/Gemma3-1B-IT</a>
                                    then create a token at
                                    <a href="https://huggingface.co/settings/tokens" target="_blank" rel="noopener">huggingface.co/settings/tokens</a>.
                                    The token is only used for the download and stored locally.
                                </p>
                            </div>

                            <div class="form-group">
                                <div class="model-status" id="settings-mediapipe-llm-status">
                                    <span class="model-status-text">Model not loaded</span>
                                    <button class="btn btn-secondary btn-sm" id="settings-mediapipe-llm-download-btn">Download &amp; Load Model</button>
                                </div>
                            </div>
                        </div>

                        <div id="settings-lmstudio-llm-options" style="display: none;">
                            <div class="form-group">
                                <label for="settings-lmstudio-llm-endpoint">LM Studio Server URL</label>
                                <input type="text" id="settings-lmstudio-llm-endpoint" class="form-input"
                                    placeholder="http://127.0.0.1:1234">
                                <p class="form-hint">
                                    The base URL of your LM Studio server. On desktop the default
                                    <code>http://127.0.0.1:1234</code> works. On mobile, enter the LAN
                                    address of the machine running LM Studio (enable
                                    "Serve on local network" in LM Studio's developer tab).
                                </p>
                            </div>

                            <div class="form-group">
                                <label for="settings-lmstudio-llm-model">Chat Model (API identifier)</label>
                                <select id="settings-lmstudio-llm-model" class="form-select"></select>
                                <p class="form-hint">Pick from the models currently visible to LM Studio. Use "Refresh" if you just loaded one.</p>
                            </div>

                            <div class="form-group">
                                <div class="model-status" id="settings-lmstudio-llm-status">
                                    <span class="model-status-text">Connection not tested</span>
                                    <button class="btn btn-secondary btn-sm" id="settings-lmstudio-llm-test-btn">Test Connection</button>
                                </div>
                            </div>
                        </div>

                        <div id="settings-local-backends-shared" style="display: none;">
                            <div class="form-group">
                                <label style="display: flex; align-items: center; gap: var(--spacing-sm); cursor: pointer;">
                                    <input type="checkbox" id="settings-local-llm-defer-tts">
                                    Defer TTS until response is complete
                                </label>
                                <p class="form-hint">When enabled, text-to-speech starts only after the LLM finishes generating the full response. Prevents stuttering on devices with limited memory.</p>
                            </div>

                            <div class="form-group">
                                <label style="display: flex; align-items: center; gap: var(--spacing-sm); cursor: pointer;">
                                    <input type="checkbox" id="settings-local-llm-jit-loading" checked>
                                    Just-in-time model loading
                                </label>
                                <p class="form-hint">When enabled, the LLM is unloaded from memory as soon as it finishes generating a response, before TTS synthesis begins. It reloads automatically for the next question. Reduces peak memory usage at the cost of a reload delay between questions.</p>
                            </div>
                        </div>

                    </details>

                    <!-- ===== Q&A ===== -->
                    <details class="settings-section">
                        <summary class="settings-section-header">
                            <span>Q&amp;A</span>
                            <svg class="settings-section-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                        </summary>

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
                    </details>

                    <!-- ===== Quiz ===== -->
                    <details class="settings-section">
                        <summary class="settings-section-header">
                            <span>Quiz</span>
                            <svg class="settings-section-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                        </summary>

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
                            <label for="settings-quiz-scope">Chapter Scope</label>
                            <select id="settings-quiz-scope" class="form-select">
                                <option value="full">Entire chapter</option>
                                <option value="up-to-current">Up to current sentence</option>
                            </select>
                            <p class="form-hint">Determines whether questions cover the full chapter or only content up to your reading position</p>
                        </div>

                        <div class="settings-subsection-header">TTS During Quiz</div>

                        <p class="form-hint" style="margin-top: 0; margin-bottom: var(--spacing-xs);">Select which parts of the quiz are read aloud. All options are off by default.</p>
                        <div style="display: flex; flex-direction: column; gap: var(--spacing-xs); margin-top: var(--spacing-xs); margin-bottom: var(--spacing-md);">
                            <label style="display: flex; align-items: center; gap: var(--spacing-sm); cursor: pointer; font-weight: normal;">
                                <input type="checkbox" id="settings-quiz-tts-question">
                                Read question aloud
                            </label>
                            <label style="display: flex; align-items: center; gap: var(--spacing-sm); cursor: pointer; font-weight: normal;">
                                <input type="checkbox" id="settings-quiz-tts-options">
                                Read multiple choice options aloud
                            </label>
                            <label style="display: flex; align-items: center; gap: var(--spacing-sm); cursor: pointer; font-weight: normal;">
                                <input type="checkbox" id="settings-quiz-tts-correctness">
                                Read "Correct" / "Incorrect" aloud
                            </label>
                            <label style="display: flex; align-items: center; gap: var(--spacing-sm); cursor: pointer; font-weight: normal;">
                                <input type="checkbox" id="settings-quiz-tts-explanation">
                                Read explanation / feedback aloud
                            </label>
                        </div>

                        <div class="settings-subsection-header">Question Types</div>

                        <div style="display: flex; flex-direction: column; gap: var(--spacing-xs); margin-top: var(--spacing-xs); margin-bottom: var(--spacing-md);">
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

                        <div class="form-group">
                            <label for="settings-quiz-system-prompt">Custom System Prompt (optional)</label>
                            <textarea id="settings-quiz-system-prompt" class="form-input" rows="3" placeholder="Override the default system prompt for quiz generation..."></textarea>
                            <p class="form-hint">Leave empty to use the default quiz generation prompt</p>
                        </div>
                    </details>

                    <!-- ===== Spaced Review (Grounded SRS) ===== -->
                    <details class="settings-section">
                        <summary class="settings-section-header">
                            <span>Spaced Review</span>
                            <svg class="settings-section-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                        </summary>

                        <p class="form-hint" style="margin-top: 0; margin-bottom: var(--spacing-md);">
                            Decoupled spaced-repetition flashcards generated from the knowledge graph. Questions and distractors are grounded in the author's actual phrasing. SM-2 schedules reviews; failed cards reset to the fail interval below.
                        </p>

                        <div class="form-group">
                            <label style="display: flex; align-items: center; gap: var(--spacing-sm); cursor: pointer;">
                                <input type="checkbox" id="settings-srs-enabled" checked>
                                Enable Spaced Review
                            </label>
                            <p class="form-hint">When off, no flashcards are generated and the SRS deck is hidden from the reader.</p>
                        </div>

                        <div class="settings-subsection-header">Grounding</div>

                        <div class="form-group">
                            <label for="settings-srs-padding-mode">Context source</label>
                            <select id="settings-srs-padding-mode" class="form-select">
                                <option value="padding">Padding window around each mention</option>
                                <option value="whole-chapter">Whole chapter</option>
                            </select>
                            <p class="form-hint">Padding mode fetches a small window of sentences around each node's mention — cheap and focused. Whole-chapter mode sends the entire chapter to the LLM — richer narrative context but many more tokens.</p>
                        </div>

                        <div class="form-group" id="settings-srs-padding-row">
                            <label for="settings-srs-padding-n">Padding size: <span id="settings-srs-padding-n-value">3</span> sentences</label>
                            <input type="range" id="settings-srs-padding-n" class="form-input" min="0" max="10" step="1" value="3">
                            <p class="form-hint">Number of sentences before and after each mention. 0 = just the matching sentence.</p>
                        </div>

                        <div class="form-group">
                            <label for="settings-srs-distractor-count">Distractor count: <span id="settings-srs-distractor-count-value">3</span></label>
                            <input type="range" id="settings-srs-distractor-count" class="form-input" min="2" max="5" step="1" value="3">
                            <p class="form-hint">How many wrong options accompany the correct answer. In padding mode these are drawn from related KG nodes so the question requires real discrimination.</p>
                        </div>

                        <div class="form-group">
                            <label for="settings-srs-temperature">LLM temperature: <span id="settings-srs-temperature-value">0.40</span></label>
                            <input type="range" id="settings-srs-temperature" class="form-input" min="0" max="1" step="0.05" value="0.4">
                            <p class="form-hint">Lower values produce more deterministic questions that stick close to the source text; higher values produce more creative phrasing but risk drift.</p>
                        </div>

                        <div class="settings-subsection-header">Generation Triggers</div>

                        <div class="form-group">
                            <label style="display: flex; align-items: center; gap: var(--spacing-sm); cursor: pointer; font-weight: normal;">
                                <input type="checkbox" id="settings-srs-trigger-chapter-finish" checked>
                                Generate when a chapter is finished
                            </label>
                            <p class="form-hint">Fire-and-forget background generation when the reader reaches the end of a chapter that has a knowledge graph.</p>
                        </div>

                        <div class="form-group">
                            <label style="display: flex; align-items: center; gap: var(--spacing-sm); cursor: pointer; font-weight: normal;">
                                <input type="checkbox" id="settings-srs-trigger-lazy" checked>
                                Top up the deck when opened
                            </label>
                            <p class="form-hint">If the active deck is empty when you open Spaced Review, generate just enough cards to fill it.</p>
                        </div>

                        <div class="settings-subsection-header">Scheduling</div>

                        <div class="form-group">
                            <label for="settings-srs-fail-interval">Fail interval: <span id="settings-srs-fail-interval-value">10</span> minutes</label>
                            <input type="range" id="settings-srs-fail-interval" class="form-input" min="1" max="240" step="1" value="10">
                            <p class="form-hint">How long to wait before a failed card reappears. Short values (5–15 min) drill foundational concepts hard; longer values feel less punishing.</p>
                        </div>

                        <div class="form-group">
                            <label for="settings-srs-ease-default">Starting ease: <span id="settings-srs-ease-default-value">2.50</span></label>
                            <input type="range" id="settings-srs-ease-default" class="form-input" min="1.3" max="3.0" step="0.05" value="2.5">
                            <p class="form-hint">SM-2 ease factor for brand-new cards. 2.5 is the classic Anki default.</p>
                        </div>

                        <div class="form-group">
                            <label for="settings-srs-ease-min">Minimum ease: <span id="settings-srs-ease-min-value">1.30</span></label>
                            <input type="range" id="settings-srs-ease-min" class="form-input" min="1.0" max="2.0" step="0.05" value="1.3">
                            <p class="form-hint">Floor below which ease cannot drop, no matter how many failures.</p>
                        </div>

                        <div class="form-group">
                            <label for="settings-srs-ease-step-fail">Ease penalty on fail: <span id="settings-srs-ease-step-fail-value">0.20</span></label>
                            <input type="range" id="settings-srs-ease-step-fail" class="form-input" min="0" max="0.5" step="0.05" value="0.2">
                            <p class="form-hint">How much ease drops on each incorrect answer.</p>
                        </div>

                        <div class="settings-subsection-header">Session Limits</div>

                        <div class="form-group">
                            <label for="settings-srs-max-new">Max new cards per session: <span id="settings-srs-max-new-value">10</span></label>
                            <input type="range" id="settings-srs-max-new" class="form-input" min="0" max="50" step="1" value="10">
                            <p class="form-hint">Caps the number of unseen cards introduced in one sitting. New cards are sorted by centrality, so the most important concepts go first.</p>
                        </div>

                        <div class="form-group">
                            <label for="settings-srs-max-reviews">Max reviews per session: <span id="settings-srs-max-reviews-value">30</span></label>
                            <input type="range" id="settings-srs-max-reviews" class="form-input" min="0" max="200" step="5" value="30">
                            <p class="form-hint">Caps the number of due cards reviewed in one sitting. Oldest-due-first.</p>
                        </div>
                    </details>

                    <!-- ===== Knowledge Graph ===== -->
                    <details class="settings-section">
                        <summary class="settings-section-header">
                            <span>Knowledge Graph</span>
                            <svg class="settings-section-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                        </summary>

                        <p class="form-hint" style="margin-top: 0; margin-bottom: var(--spacing-md);">
                            Extracts entities and relations from each chapter and resolves them into a knowledge graph.
                            The extraction LLM and the embedding model can each be configured independently.
                        </p>

                        <div class="settings-subsection-header">Extraction</div>

                        <div class="form-group">
                            <label for="settings-kg-backend">Extraction Backend</label>
                            <select id="settings-kg-backend" class="form-select">
                                <option value="openrouter">OpenRouter (Cloud)</option>
                                <option value="local">Local (transformers.js)</option>
                                <option value="mediapipe">Local (MediaPipe)</option>
                                <option value="lmstudio">LM Studio (Local Server)</option>
                            </select>
                            <p class="form-hint">Which LLM is asked to extract entities and relations from each chunk</p>
                        </div>

                        <div id="settings-kg-lmstudio-extraction-options" style="display: none;">
                            <div class="form-group">
                                <label for="settings-kg-lmstudio-endpoint">LM Studio Server URL</label>
                                <input type="text" id="settings-kg-lmstudio-endpoint" class="form-input"
                                    placeholder="http://127.0.0.1:1234">
                                <p class="form-hint">Shared with the Language Model section &mdash; changes here apply everywhere.</p>
                            </div>

                            <div class="form-group">
                                <label for="settings-kg-lmstudio-chat-model">Chat Model (API identifier)</label>
                                <select id="settings-kg-lmstudio-chat-model" class="form-select"></select>
                            </div>

                            <div class="form-group">
                                <div class="model-status" id="settings-kg-lmstudio-extraction-status">
                                    <span class="model-status-text">Connection not tested</span>
                                    <button class="btn btn-secondary btn-sm" id="settings-kg-lmstudio-extraction-test-btn">Test Connection</button>
                                </div>
                            </div>
                        </div>

                        <div class="form-group">
                            <label for="settings-kg-chunk-size">Chunk Size: <span id="settings-kg-chunk-size-value">6</span> sentences</label>
                            <input type="range" id="settings-kg-chunk-size" class="form-input" min="2" max="20" step="1" value="6">
                            <p class="form-hint">Number of sentences sent to the LLM in a single extraction prompt</p>
                        </div>

                        <div class="form-group">
                            <label for="settings-kg-chunk-overlap">Chunk Overlap: <span id="settings-kg-chunk-overlap-value">2</span> sentences</label>
                            <input type="range" id="settings-kg-chunk-overlap" class="form-input" min="0" max="10" step="1" value="2">
                            <p class="form-hint">Sentences shared between consecutive chunks to preserve context across boundaries</p>
                        </div>

                        <div class="form-group">
                            <label for="settings-kg-chunks-per-request">Chunks per Request: <span id="settings-kg-chunks-per-request-value">4</span></label>
                            <input type="range" id="settings-kg-chunks-per-request" class="form-input" min="1" max="16" step="1" value="4">
                            <p class="form-hint">How many chunks share a single extraction LLM call. Higher = fewer round-trips and faster, but the model has to attend to more text at once, so very high values may produce noisier graphs. Set to 1 to send each chunk individually.</p>
                        </div>

                        <div class="settings-subsection-header">Entity Resolution</div>

                        <div class="form-group">
                            <label for="settings-kg-similarity-threshold">Similarity Threshold: <span id="settings-kg-similarity-threshold-value">0.88</span></label>
                            <input type="range" id="settings-kg-similarity-threshold" class="form-input" min="0.5" max="0.99" step="0.01" value="0.88">
                            <p class="form-hint">Cosine similarity above which two extracted entities are merged into the same node</p>
                        </div>

                        <div class="form-group">
                            <label for="settings-kg-domain">Current book's domain</label>
                            <input type="text" id="settings-kg-domain" class="form-input" placeholder="Open a book to edit" autocomplete="off" disabled>
                            <p class="form-hint">Per-book Tier-1 + Tier-2 anchor. The LLM is told to favour entities load-bearing to this topic, and each entity's cosine to this string acts as the relevance score. The text is set on first build by the domain prompt; you can revise it here at any time. Editing applies to nodes extracted from this point on — past nodes' relevance scores are unchanged.</p>
                        </div>

                        <div class="form-group">
                            <label for="settings-kg-relevance-threshold">Domain Relevance Floor: <span id="settings-kg-relevance-threshold-value">0.15</span></label>
                            <input type="range" id="settings-kg-relevance-threshold" class="form-input" min="0" max="1" step="0.01" value="0.15">
                            <p class="form-hint">Hard floor applied at extraction time — entities scoring below this against the book's domain anchor are discarded permanently. Keep this low (≈0.15) and tune visualisation strictness in the Graph Explorer.</p>
                        </div>

                        <div class="form-group">
                            <label for="settings-kg-wheel-sensitivity">Mouse-wheel zoom speed: <span id="settings-kg-wheel-sensitivity-value">1.00</span></label>
                            <input type="range" id="settings-kg-wheel-sensitivity" class="form-input" min="0.1" max="3" step="0.1" value="1.0">
                            <p class="form-hint">Controls how aggressively the mouse wheel zooms the knowledge graph. 1.0 is the cytoscape default; lower is gentler, higher is snappier.</p>
                        </div>

                        <div class="form-group">
                            <label for="settings-kg-neighborhood-hops">Click focus depth: <span id="settings-kg-neighborhood-hops-value">1</span></label>
                            <input type="range" id="settings-kg-neighborhood-hops" class="form-input" min="0" max="5" step="1" value="1">
                            <p class="form-hint">When you click a node, this many hops of neighbours stay in focus while the rest of the graph greys out and recedes. 0 = highlight only the clicked node; 1 = direct neighbours; 2 = neighbours-of-neighbours; and so on. Tap the background to clear the focus.</p>
                        </div>

                        <div class="settings-subsection-header">Force-directed layout (fcose)</div>

                        <div class="form-group">
                            <label for="settings-kg-fcose-node-repulsion">Node repulsion: <span id="settings-kg-fcose-node-repulsion-value">8000</span></label>
                            <input type="range" id="settings-kg-fcose-node-repulsion" class="form-input" min="1000" max="100000" step="500" value="8000">
                            <p class="form-hint">How strongly nodes push each other apart. Raise this to spread an overlapping graph; lower it to pack nodes closer together. Takes effect on the next Re-layout.</p>
                        </div>

                        <div class="form-group">
                            <label for="settings-kg-fcose-ideal-edge-length">Ideal edge length: <span id="settings-kg-fcose-ideal-edge-length-value">80</span></label>
                            <input type="range" id="settings-kg-fcose-ideal-edge-length" class="form-input" min="30" max="300" step="5" value="80">
                            <p class="form-hint">Resting length the layout tries to keep edges at. Higher = neighbours sit further apart.</p>
                        </div>

                        <div class="form-group">
                            <label for="settings-kg-fcose-node-separation">Node separation: <span id="settings-kg-fcose-node-separation-value">100</span></label>
                            <input type="range" id="settings-kg-fcose-node-separation" class="form-input" min="25" max="300" step="5" value="100">
                            <p class="form-hint">Minimum spacing maintained between nodes during tiling. Raise this to enforce wider gutters around each node.</p>
                        </div>

                        <div class="form-group">
                            <label for="settings-kg-fcose-gravity">Gravity: <span id="settings-kg-fcose-gravity-value">0.25</span></label>
                            <input type="range" id="settings-kg-fcose-gravity" class="form-input" min="0" max="1" step="0.05" value="0.25">
                            <p class="form-hint">Pull toward the canvas centre. Lower values let disconnected clusters drift further out; higher values keep everything tightly grouped.</p>
                        </div>

                        <div class="form-group">
                            <label for="settings-kg-fcose-num-iter">Number of iterations: <span id="settings-kg-fcose-num-iter-value">2500</span></label>
                            <input type="range" id="settings-kg-fcose-num-iter" class="form-input" min="500" max="10000" step="250" value="2500">
                            <p class="form-hint">How many simulation steps the layout runs before stopping. More iterations produce a better-settled graph but slow down the Re-layout pass.</p>
                        </div>

                        <div class="form-group">
                            <label class="checkbox-label">
                                <input type="checkbox" id="settings-kg-fcose-fit" checked>
                                <span>Fit graph to screen after layout</span>
                            </label>
                            <p class="form-hint">When on, every layout pass zooms and pans so the whole graph fits the viewport. Turn off to keep your manual pan/zoom across Re-layouts — useful when ideal edge length is high and the graph is meant to extend past the screen.</p>
                        </div>

                        <div class="form-group">
                            <label for="settings-kg-node-size-scale">Node size by degree: <span id="settings-kg-node-size-scale-value">1.00</span></label>
                            <input type="range" id="settings-kg-node-size-scale" class="form-input" min="0" max="3" step="0.05" value="1.0">
                            <p class="form-hint">How strongly node size grows with the number of connections. 0 = every node the same size; 1 = default (30–70 px range); higher exaggerates hubs.</p>
                        </div>

                        <div class="form-group">
                            <label for="settings-kg-search-mode">Graph search mode</label>
                            <select id="settings-kg-search-mode" class="form-select">
                                <option value="text">Text (substring)</option>
                                <option value="semantic">Semantic (embedding cosine)</option>
                            </select>
                            <p class="form-hint">Text mode does a case-insensitive substring match against each node's canonical name and aliases. Semantic mode embeds the query and ranks every node by cosine similarity, keeping those above the threshold below. Semantic search requires the embedding model to be loaded (it loads on demand).</p>
                        </div>

                        <div class="form-group" id="settings-kg-semantic-threshold-row">
                            <label for="settings-kg-semantic-threshold">Semantic search threshold: <span id="settings-kg-semantic-threshold-value">0.50</span></label>
                            <input type="range" id="settings-kg-semantic-threshold" class="form-input" min="0" max="1" step="0.01" value="0.5">
                            <p class="form-hint">Minimum cosine similarity (0.0–1.0) between the query embedding and a node's embedding for the node to be highlighted. Higher = stricter / fewer matches.</p>
                        </div>

                        <div class="settings-subsection-header">Embedding Model</div>

                        <div class="form-group">
                            <label for="settings-kg-embedding-source">Embedding Source</label>
                            <select id="settings-kg-embedding-source" class="form-select">
                                <option value="openrouter">OpenRouter (Cloud)</option>
                                <option value="local">Local (transformers.js)</option>
                                <option value="lmstudio">LM Studio (Local Server)</option>
                            </select>
                            <p class="form-hint">Cloud embeddings reuse the OpenRouter API key from the LLM section. Local embeddings run a small transformers.js model on this device (~25 MB download on first use). LM Studio uses your local server's embedding model.</p>
                        </div>

                        <div class="form-group" id="settings-kg-cloud-embedding-options">
                            <label for="settings-kg-cloud-embedding-model">Cloud Embedding Model</label>
                            <select id="settings-kg-cloud-embedding-model" class="form-select">
                                <option value="openai/text-embedding-3-small">OpenAI text-embedding-3-small</option>
                                <option value="openai/text-embedding-3-large">OpenAI text-embedding-3-large</option>
                                <option value="qwen/qwen3-embedding-4b">Qwen3-Embedding-4B</option>
                                <option value="qwen/qwen3-embedding-8b">Qwen3-Embedding-8B</option>
                            </select>
                        </div>

                        <div class="form-group" id="settings-kg-local-embedding-options">
                            <label for="settings-kg-local-embedding-model">Local Embedding Model</label>
                            <select id="settings-kg-local-embedding-model" class="form-select">
                                <option value="Xenova/all-MiniLM-L6-v2">all-MiniLM-L6-v2 (384-d, ~25 MB)</option>
                                <option value="Xenova/bge-small-en-v1.5">BGE-small EN v1.5 (384-d, ~33 MB)</option>
                                <option value="Xenova/multilingual-e5-small">Multilingual E5 small (384-d, ~118 MB)</option>
                            </select>
                        </div>

                        <div id="settings-kg-lmstudio-embedding-options" style="display: none;">
                            <div class="form-group">
                                <label for="settings-kg-lmstudio-embedding-endpoint">LM Studio Server URL</label>
                                <input type="text" id="settings-kg-lmstudio-embedding-endpoint" class="form-input"
                                    placeholder="http://127.0.0.1:1234">
                                <p class="form-hint">Shared with the Language Model section &mdash; changes here apply everywhere.</p>
                            </div>

                            <div class="form-group">
                                <label for="settings-kg-lmstudio-embedding-model">Embedding Model (API identifier)</label>
                                <select id="settings-kg-lmstudio-embedding-model" class="form-select"></select>
                                <p class="form-hint">Pick from the embedding models currently visible to LM Studio. Use "Refresh" if you just loaded one.</p>
                            </div>

                            <div class="form-group">
                                <div class="model-status" id="settings-kg-lmstudio-embedding-status">
                                    <span class="model-status-text">Connection not tested</span>
                                    <button class="btn btn-secondary btn-sm" id="settings-kg-lmstudio-embedding-test-btn">Test Connection</button>
                                </div>
                            </div>
                        </div>

                        <div class="settings-subsection-header">Maintenance</div>

                        <div class="form-group">
                            <button type="button" class="btn btn-danger" id="settings-kg-clear-btn">Clear Knowledge Graph</button>
                            <p class="form-hint">Permanently deletes every node and edge for the currently-open book and re-enables extraction on each chapter. Cannot be undone.</p>
                        </div>
                    </details>

                    <!-- ===== About ===== -->
                    <details class="settings-section">
                        <summary class="settings-section-header">
                            <span>About</span>
                            <svg class="settings-section-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                        </summary>
                        <div id="settings-about-content" class="about-content">
                            <p>Loading information...</p>
                        </div>
                    </details>
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
            customVoice: this._container.querySelector('#settings-custom-voice'),
            customVoiceGroup: this._container.querySelector('#settings-custom-voice-group'),
            speed: this._container.querySelector('#settings-speed'),
            speedValue: this._container.querySelector('#settings-speed-value'),
            prefetchCount: this._container.querySelector('#settings-prefetch-count'),
            prefetchCountValue: this._container.querySelector('#settings-prefetch-count-value'),
            maxSentenceLength: this._container.querySelector('#settings-max-sentence-length'),
            maxSentenceLengthValue: this._container.querySelector('#settings-max-sentence-length-value'),
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
            localLlmDeferTts: this._container.querySelector('#settings-local-llm-defer-tts'),
            localLlmJitLoading: this._container.querySelector('#settings-local-llm-jit-loading'),
            // MediaPipe LLM backend
            mediapipeLlmOptions: this._container.querySelector('#settings-mediapipe-llm-options'),
            localBackendsShared: this._container.querySelector('#settings-local-backends-shared'),
            mediapipeLlmHfToken: this._container.querySelector('#settings-mediapipe-hf-token'),
            mediapipeLlmStatus: this._container.querySelector('#settings-mediapipe-llm-status'),
            mediapipeLlmStatusText: this._container.querySelector('#settings-mediapipe-llm-status .model-status-text'),
            mediapipeLlmDownloadBtn: this._container.querySelector('#settings-mediapipe-llm-download-btn'),
            // LM Studio backend (LLM section)
            lmstudioLlmOptions: this._container.querySelector('#settings-lmstudio-llm-options'),
            lmstudioLlmEndpoint: this._container.querySelector('#settings-lmstudio-llm-endpoint'),
            lmstudioLlmModel: this._container.querySelector('#settings-lmstudio-llm-model'),
            lmstudioLlmStatus: this._container.querySelector('#settings-lmstudio-llm-status'),
            lmstudioLlmStatusText: this._container.querySelector('#settings-lmstudio-llm-status .model-status-text'),
            lmstudioLlmTestBtn: this._container.querySelector('#settings-lmstudio-llm-test-btn'),
            // LM Studio backend (KG Extraction)
            kgLmstudioExtractionOptions: this._container.querySelector('#settings-kg-lmstudio-extraction-options'),
            kgLmstudioEndpoint: this._container.querySelector('#settings-kg-lmstudio-endpoint'),
            kgLmstudioChatModel: this._container.querySelector('#settings-kg-lmstudio-chat-model'),
            kgLmstudioExtractionStatus: this._container.querySelector('#settings-kg-lmstudio-extraction-status'),
            kgLmstudioExtractionStatusText: this._container.querySelector('#settings-kg-lmstudio-extraction-status .model-status-text'),
            kgLmstudioExtractionTestBtn: this._container.querySelector('#settings-kg-lmstudio-extraction-test-btn'),
            // LM Studio backend (KG Embedding)
            kgLmstudioEmbeddingOptions: this._container.querySelector('#settings-kg-lmstudio-embedding-options'),
            kgLmstudioEmbeddingEndpoint: this._container.querySelector('#settings-kg-lmstudio-embedding-endpoint'),
            kgLmstudioEmbeddingModel: this._container.querySelector('#settings-kg-lmstudio-embedding-model'),
            kgLmstudioEmbeddingStatus: this._container.querySelector('#settings-kg-lmstudio-embedding-status'),
            kgLmstudioEmbeddingStatusText: this._container.querySelector('#settings-kg-lmstudio-embedding-status .model-status-text'),
            kgLmstudioEmbeddingTestBtn: this._container.querySelector('#settings-kg-lmstudio-embedding-test-btn'),
            apiKey: this._container.querySelector('#settings-api-key'),
            model: this._container.querySelector('#settings-model'),
            fullChapterContext: this._container.querySelector('#settings-full-chapter-context'),
            contextBefore: this._container.querySelector('#settings-context-before'),
            contextAfter: this._container.querySelector('#settings-context-after'),
            quizMode: this._container.querySelector('#settings-quiz-mode'),
            quizGuided: this._container.querySelector('#settings-quiz-guided'),
            quizTtsQuestion: this._container.querySelector('#settings-quiz-tts-question'),
            quizTtsOptions: this._container.querySelector('#settings-quiz-tts-options'),
            quizTtsCorrectness: this._container.querySelector('#settings-quiz-tts-correctness'),
            quizTtsExplanation: this._container.querySelector('#settings-quiz-tts-explanation'),
            quizScope: this._container.querySelector('#settings-quiz-scope'),
            quizTypeFactual: this._container.querySelector('#settings-quiz-type-factual'),
            quizTypeDeeper: this._container.querySelector('#settings-quiz-type-deeper'),
            quizTypeVocabulary: this._container.querySelector('#settings-quiz-type-vocabulary'),
            quizTypeInference: this._container.querySelector('#settings-quiz-type-inference'),
            quizTypeThemes: this._container.querySelector('#settings-quiz-type-themes'),
            quizSystemPrompt: this._container.querySelector('#settings-quiz-system-prompt'),
            cancelBtn: this._container.querySelector('#settings-cancel-btn'),
            saveBtn: this._container.querySelector('#settings-save-btn'),
            aboutContent: this._container.querySelector('#settings-about-content'),
            // Transformers.js version
            transformersVersion: this._container.querySelector('#settings-transformers-version'),
            // Diagnostics
            verboseLogging: this._container.querySelector('#settings-verbose-logging'),
            reinitThreshold: this._container.querySelector('#settings-reinit-threshold'),
            // Log viewer
            viewLogBtn: this._container.querySelector('#settings-view-log-btn'),
            clearLogBtn: this._container.querySelector('#settings-clear-log-btn'),
            logViewer: this._container.querySelector('#settings-log-viewer'),
            // Knowledge Graph
            kgBackend: this._container.querySelector('#settings-kg-backend'),
            kgChunkSize: this._container.querySelector('#settings-kg-chunk-size'),
            kgChunkSizeValue: this._container.querySelector('#settings-kg-chunk-size-value'),
            kgChunkOverlap: this._container.querySelector('#settings-kg-chunk-overlap'),
            kgChunkOverlapValue: this._container.querySelector('#settings-kg-chunk-overlap-value'),
            kgChunksPerRequest: this._container.querySelector('#settings-kg-chunks-per-request'),
            kgChunksPerRequestValue: this._container.querySelector('#settings-kg-chunks-per-request-value'),
            kgSimilarityThreshold: this._container.querySelector('#settings-kg-similarity-threshold'),
            kgSimilarityThresholdValue: this._container.querySelector('#settings-kg-similarity-threshold-value'),
            kgDomain: this._container.querySelector('#settings-kg-domain'),
            kgRelevanceThreshold: this._container.querySelector('#settings-kg-relevance-threshold'),
            kgRelevanceThresholdValue: this._container.querySelector('#settings-kg-relevance-threshold-value'),
            kgWheelSensitivity: this._container.querySelector('#settings-kg-wheel-sensitivity'),
            kgWheelSensitivityValue: this._container.querySelector('#settings-kg-wheel-sensitivity-value'),
            kgFcoseNodeRepulsion: this._container.querySelector('#settings-kg-fcose-node-repulsion'),
            kgFcoseNodeRepulsionValue: this._container.querySelector('#settings-kg-fcose-node-repulsion-value'),
            kgFcoseIdealEdgeLength: this._container.querySelector('#settings-kg-fcose-ideal-edge-length'),
            kgFcoseIdealEdgeLengthValue: this._container.querySelector('#settings-kg-fcose-ideal-edge-length-value'),
            kgFcoseNodeSeparation: this._container.querySelector('#settings-kg-fcose-node-separation'),
            kgFcoseNodeSeparationValue: this._container.querySelector('#settings-kg-fcose-node-separation-value'),
            kgFcoseGravity: this._container.querySelector('#settings-kg-fcose-gravity'),
            kgFcoseGravityValue: this._container.querySelector('#settings-kg-fcose-gravity-value'),
            kgFcoseNumIter: this._container.querySelector('#settings-kg-fcose-num-iter'),
            kgFcoseNumIterValue: this._container.querySelector('#settings-kg-fcose-num-iter-value'),
            kgFcoseFit: this._container.querySelector('#settings-kg-fcose-fit'),
            kgNodeSizeScale: this._container.querySelector('#settings-kg-node-size-scale'),
            kgNodeSizeScaleValue: this._container.querySelector('#settings-kg-node-size-scale-value'),
            kgNeighborhoodHops: this._container.querySelector('#settings-kg-neighborhood-hops'),
            kgNeighborhoodHopsValue: this._container.querySelector('#settings-kg-neighborhood-hops-value'),
            kgSearchMode: this._container.querySelector('#settings-kg-search-mode'),
            kgSemanticThreshold: this._container.querySelector('#settings-kg-semantic-threshold'),
            kgSemanticThresholdValue: this._container.querySelector('#settings-kg-semantic-threshold-value'),
            kgSemanticThresholdRow: this._container.querySelector('#settings-kg-semantic-threshold-row'),
            kgEmbeddingSource: this._container.querySelector('#settings-kg-embedding-source'),
            kgCloudEmbeddingOptions: this._container.querySelector('#settings-kg-cloud-embedding-options'),
            kgCloudEmbeddingModel: this._container.querySelector('#settings-kg-cloud-embedding-model'),
            kgLocalEmbeddingOptions: this._container.querySelector('#settings-kg-local-embedding-options'),
            kgLocalEmbeddingModel: this._container.querySelector('#settings-kg-local-embedding-model'),
            kgClearBtn: this._container.querySelector('#settings-kg-clear-btn'),
            // Spaced Review (Grounded SRS)
            srsEnabled: this._container.querySelector('#settings-srs-enabled'),
            srsPaddingMode: this._container.querySelector('#settings-srs-padding-mode'),
            srsPaddingRow: this._container.querySelector('#settings-srs-padding-row'),
            srsPaddingN: this._container.querySelector('#settings-srs-padding-n'),
            srsPaddingNValue: this._container.querySelector('#settings-srs-padding-n-value'),
            srsDistractorCount: this._container.querySelector('#settings-srs-distractor-count'),
            srsDistractorCountValue: this._container.querySelector('#settings-srs-distractor-count-value'),
            srsTemperature: this._container.querySelector('#settings-srs-temperature'),
            srsTemperatureValue: this._container.querySelector('#settings-srs-temperature-value'),
            srsTriggerChapterFinish: this._container.querySelector('#settings-srs-trigger-chapter-finish'),
            srsTriggerLazy: this._container.querySelector('#settings-srs-trigger-lazy'),
            srsFailInterval: this._container.querySelector('#settings-srs-fail-interval'),
            srsFailIntervalValue: this._container.querySelector('#settings-srs-fail-interval-value'),
            srsEaseDefault: this._container.querySelector('#settings-srs-ease-default'),
            srsEaseDefaultValue: this._container.querySelector('#settings-srs-ease-default-value'),
            srsEaseMin: this._container.querySelector('#settings-srs-ease-min'),
            srsEaseMinValue: this._container.querySelector('#settings-srs-ease-min-value'),
            srsEaseStepFail: this._container.querySelector('#settings-srs-ease-step-fail'),
            srsEaseStepFailValue: this._container.querySelector('#settings-srs-ease-step-fail-value'),
            srsMaxNew: this._container.querySelector('#settings-srs-max-new'),
            srsMaxNewValue: this._container.querySelector('#settings-srs-max-new-value'),
            srsMaxReviews: this._container.querySelector('#settings-srs-max-reviews'),
            srsMaxReviewsValue: this._container.querySelector('#settings-srs-max-reviews-value')
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

        // MediaPipe LLM download button
        this._elements.mediapipeLlmDownloadBtn.addEventListener('click', () => {
            this._callbacks.onMediapipeLlmDownload?.({
                hfToken: this._elements.mediapipeLlmHfToken.value.trim()
            });
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

        // Prefetch count slider
        this._elements.prefetchCount.addEventListener('input', () => {
            const count = parseInt(this._elements.prefetchCount.value);
            this._elements.prefetchCountValue.textContent = count;
        });

        // Knowledge Graph sliders
        this._elements.kgChunkSize.addEventListener('input', () => {
            this._elements.kgChunkSizeValue.textContent = parseInt(this._elements.kgChunkSize.value);
        });
        this._elements.kgChunkOverlap.addEventListener('input', () => {
            this._elements.kgChunkOverlapValue.textContent = parseInt(this._elements.kgChunkOverlap.value);
        });
        this._elements.kgChunksPerRequest.addEventListener('input', () => {
            this._elements.kgChunksPerRequestValue.textContent = parseInt(this._elements.kgChunksPerRequest.value);
        });
        this._elements.kgSimilarityThreshold.addEventListener('input', () => {
            this._elements.kgSimilarityThresholdValue.textContent = parseFloat(this._elements.kgSimilarityThreshold.value).toFixed(2);
        });
        this._elements.kgRelevanceThreshold.addEventListener('input', () => {
            this._elements.kgRelevanceThresholdValue.textContent = parseFloat(this._elements.kgRelevanceThreshold.value).toFixed(2);
        });
        this._elements.kgWheelSensitivity.addEventListener('input', () => {
            this._elements.kgWheelSensitivityValue.textContent = parseFloat(this._elements.kgWheelSensitivity.value).toFixed(2);
        });
        this._elements.kgFcoseNodeRepulsion.addEventListener('input', () => {
            this._elements.kgFcoseNodeRepulsionValue.textContent = String(parseInt(this._elements.kgFcoseNodeRepulsion.value, 10));
        });
        this._elements.kgFcoseIdealEdgeLength.addEventListener('input', () => {
            this._elements.kgFcoseIdealEdgeLengthValue.textContent = String(parseInt(this._elements.kgFcoseIdealEdgeLength.value, 10));
        });
        this._elements.kgFcoseNodeSeparation.addEventListener('input', () => {
            this._elements.kgFcoseNodeSeparationValue.textContent = String(parseInt(this._elements.kgFcoseNodeSeparation.value, 10));
        });
        this._elements.kgFcoseGravity.addEventListener('input', () => {
            this._elements.kgFcoseGravityValue.textContent = parseFloat(this._elements.kgFcoseGravity.value).toFixed(2);
        });
        this._elements.kgFcoseNumIter.addEventListener('input', () => {
            this._elements.kgFcoseNumIterValue.textContent = String(parseInt(this._elements.kgFcoseNumIter.value, 10));
        });
        this._elements.kgNodeSizeScale.addEventListener('input', () => {
            this._elements.kgNodeSizeScaleValue.textContent = parseFloat(this._elements.kgNodeSizeScale.value).toFixed(2);
        });
        this._elements.kgNeighborhoodHops.addEventListener('input', () => {
            this._elements.kgNeighborhoodHopsValue.textContent = String(parseInt(this._elements.kgNeighborhoodHops.value, 10));
        });
        // Per-book domain — committed on blur or Enter. Not included in
        // the getSettings() return because it lives on the book record,
        // not in the global settings store; the callback forwards to
        // app.js which persists via storage.saveBook.
        const commitKGDomain = () => {
            if (!this._callbacks.onDomainChange) return;
            const next = String(this._elements.kgDomain.value || '').trim();
            this._callbacks.onDomainChange(next);
        };
        this._elements.kgDomain.addEventListener('blur', commitKGDomain);
        this._elements.kgDomain.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this._elements.kgDomain.blur();
            }
        });
        // Hide the semantic-threshold row when the user picks text mode —
        // the threshold doesn't apply there, and hiding it removes the
        // visual noise of a knob that would otherwise look configurable.
        const refreshSemanticRow = () => {
            const isSemantic = this._elements.kgSearchMode.value === 'semantic';
            this._elements.kgSemanticThresholdRow?.classList.toggle('hidden', !isSemantic);
        };
        this._elements.kgSearchMode.addEventListener('change', refreshSemanticRow);
        this._elements.kgSemanticThreshold.addEventListener('input', () => {
            this._elements.kgSemanticThresholdValue.textContent =
                parseFloat(this._elements.kgSemanticThreshold.value).toFixed(2);
        });

        // KG embedding source — show only the matching sub-option group
        this._elements.kgEmbeddingSource.addEventListener('change', () => {
            this._updateKGEmbeddingSourceUI();
        });

        // KG extraction backend — show LM Studio sub-options when selected
        this._elements.kgBackend.addEventListener('change', () => {
            this._updateKGExtractionBackendUI();
        });

        // LM Studio: keep all three URL inputs and both chat-model dropdowns in
        // sync so the user can configure from any of the three locations and
        // see the change reflected everywhere immediately.
        const lmstudioEndpointInputs = [
            this._elements.lmstudioLlmEndpoint,
            this._elements.kgLmstudioEndpoint,
            this._elements.kgLmstudioEmbeddingEndpoint
        ];
        const syncLmstudioEndpoint = (sourceInput) => {
            const v = sourceInput.value;
            for (const input of lmstudioEndpointInputs) {
                if (input && input !== sourceInput) input.value = v;
            }
            // A new URL invalidates whatever model list we cached against the
            // old one — wipe both dropdowns back to "saved-value only" until
            // the user clicks Test/Refresh.
            this._setLmstudioStatus({ tested: false });
            this._lmstudioAvailable = false;
            this._lmstudioChatModels = [];
            this._lmstudioEmbeddingModels = [];
            this._populateLmstudioDropdowns();
        };
        for (const input of lmstudioEndpointInputs) {
            input?.addEventListener('input', () => syncLmstudioEndpoint(input));
        }

        // The two chat-model dropdowns (LLM section + KG extraction) are
        // populated identically; sync their selection on change.
        const lmstudioChatModelInputs = [
            this._elements.lmstudioLlmModel,
            this._elements.kgLmstudioChatModel
        ];
        const syncLmstudioChatModel = (sourceInput) => {
            const v = sourceInput.value;
            for (const input of lmstudioChatModelInputs) {
                if (input && input !== sourceInput) input.value = v;
            }
        };
        for (const input of lmstudioChatModelInputs) {
            input?.addEventListener('change', () => syncLmstudioChatModel(input));
        }

        this._elements.lmstudioLlmTestBtn?.addEventListener('click', () => {
            this._refreshLmstudioModels();
        });
        this._elements.kgLmstudioExtractionTestBtn?.addEventListener('click', () => {
            this._refreshLmstudioModels();
        });
        this._elements.kgLmstudioEmbeddingTestBtn?.addEventListener('click', () => {
            this._refreshLmstudioModels();
        });

        // Clear Knowledge Graph button — delegates to the host app via a
        // callback so the modal stays UI-only. The host is responsible for
        // confirming, deleting, and refreshing the reader UI.
        this._elements.kgClearBtn?.addEventListener('click', () => {
            this._callbacks.onClearKG?.();
        });

        // ---------- Spaced Review (Grounded SRS) ----------

        // Hide the padding-N slider when whole-chapter mode is selected —
        // mirrors the kg-semantic-threshold pattern.
        const refreshSrsPaddingRow = () => {
            const isPadding = this._elements.srsPaddingMode.value === 'padding';
            this._elements.srsPaddingRow?.classList.toggle('hidden', !isPadding);
        };
        this._elements.srsPaddingMode.addEventListener('change', refreshSrsPaddingRow);

        this._elements.srsPaddingN.addEventListener('input', () => {
            this._elements.srsPaddingNValue.textContent = parseInt(this._elements.srsPaddingN.value);
        });
        this._elements.srsDistractorCount.addEventListener('input', () => {
            this._elements.srsDistractorCountValue.textContent = parseInt(this._elements.srsDistractorCount.value);
        });
        this._elements.srsTemperature.addEventListener('input', () => {
            this._elements.srsTemperatureValue.textContent = parseFloat(this._elements.srsTemperature.value).toFixed(2);
        });
        this._elements.srsFailInterval.addEventListener('input', () => {
            this._elements.srsFailIntervalValue.textContent = parseInt(this._elements.srsFailInterval.value);
        });
        this._elements.srsEaseDefault.addEventListener('input', () => {
            this._elements.srsEaseDefaultValue.textContent = parseFloat(this._elements.srsEaseDefault.value).toFixed(2);
        });
        this._elements.srsEaseMin.addEventListener('input', () => {
            this._elements.srsEaseMinValue.textContent = parseFloat(this._elements.srsEaseMin.value).toFixed(2);
        });
        this._elements.srsEaseStepFail.addEventListener('input', () => {
            this._elements.srsEaseStepFailValue.textContent = parseFloat(this._elements.srsEaseStepFail.value).toFixed(2);
        });
        this._elements.srsMaxNew.addEventListener('input', () => {
            this._elements.srsMaxNewValue.textContent = parseInt(this._elements.srsMaxNew.value);
        });
        this._elements.srsMaxReviews.addEventListener('input', () => {
            this._elements.srsMaxReviewsValue.textContent = parseInt(this._elements.srsMaxReviews.value);
        });

        // Max sentence length slider
        this._elements.maxSentenceLength.addEventListener('input', () => {
            const val = parseInt(this._elements.maxSentenceLength.value);
            this._elements.maxSentenceLengthValue.textContent = val === 0 ? 'Off' : `${val} chars`;
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

        // Log viewer buttons
        this._elements.viewLogBtn.addEventListener('click', () => this._showLog());
        this._elements.clearLogBtn.addEventListener('click', async () => {
            await appLogger.clear();
            this._elements.logViewer.textContent = 'Log cleared.';
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
        this._elements.customVoiceGroup.style.display = showFastApi ? '' : 'none';

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
        const showMediapipe = backend === 'mediapipe';
        const showLmstudio = backend === 'lmstudio';

        this._elements.openrouterOptions.style.display = showOpenRouter ? '' : 'none';
        this._elements.localLlmOptions.style.display = showLocal ? '' : 'none';
        this._elements.mediapipeLlmOptions.style.display = showMediapipe ? '' : 'none';
        this._elements.lmstudioLlmOptions.style.display = showLmstudio ? '' : 'none';
        this._elements.localBackendsShared.style.display = (showLocal || showMediapipe) ? '' : 'none';

        const hints = {
            'openrouter': 'Uses cloud AI models via OpenRouter. Requires an API key and internet connection.',
            'local': 'Runs a small language model locally on your device via transformers.js. Works offline but produces simpler responses.',
            'mediapipe': 'Runs Gemma3-1B-IT on-device using MediaPipe + WebGPU. Requires a Chromium browser with WebGPU. ~600 MB download on first use.',
            'lmstudio': 'Connects to a local LM Studio server (or any OpenAI-compatible endpoint). Default URL: http://127.0.0.1:1234. On mobile, enter the LAN address of the machine running LM Studio.'
        };
        this._elements.llmBackendHint.textContent = hints[backend] || '';
    }

    _updateKGEmbeddingSourceUI() {
        const source = this._elements.kgEmbeddingSource.value;
        this._elements.kgCloudEmbeddingOptions.style.display = source === 'openrouter' ? '' : 'none';
        this._elements.kgLocalEmbeddingOptions.style.display = source === 'local' ? '' : 'none';
        if (this._elements.kgLmstudioEmbeddingOptions) {
            this._elements.kgLmstudioEmbeddingOptions.style.display = source === 'lmstudio' ? '' : 'none';
        }
    }

    _updateKGExtractionBackendUI() {
        const backend = this._elements.kgBackend.value;
        if (this._elements.kgLmstudioExtractionOptions) {
            this._elements.kgLmstudioExtractionOptions.style.display = backend === 'lmstudio' ? '' : 'none';
        }
    }

    /**
     * Reset all three LM Studio status badges. Called whenever the URL
     * changes, since a previous "Connected" result no longer applies.
     */
    _setLmstudioStatus({ tested = false, ok = false, text = '' } = {}) {
        const badges = [
            this._elements.lmstudioLlmStatusText,
            this._elements.kgLmstudioExtractionStatusText,
            this._elements.kgLmstudioEmbeddingStatusText
        ];
        for (const badge of badges) {
            if (!badge) continue;
            if (!tested) {
                badge.textContent = 'Connection not tested';
                badge.style.color = '';
            } else {
                badge.textContent = text;
                badge.style.color = ok ? '#059669' : '#dc2626';
            }
        }
    }

    /**
     * Cache discovered LM Studio models and re-populate the dropdowns.
     * Called by app.js after startup detection, and after the user clicks
     * "Test Connection" inside settings.
     *
     * @param {{ available: boolean, chatModels?: string[], embeddingModels?: string[] }} info
     */
    setLmstudioAvailability(info) {
        this._lmstudioAvailable = !!info?.available;
        this._lmstudioChatModels = Array.isArray(info?.chatModels) ? info.chatModels.slice() : [];
        this._lmstudioEmbeddingModels = Array.isArray(info?.embeddingModels) ? info.embeddingModels.slice() : [];
        this._populateLmstudioDropdowns();

        if (this._lmstudioAvailable) {
            const total = this._lmstudioChatModels.length + this._lmstudioEmbeddingModels.length;
            this._setLmstudioStatus({
                tested: true,
                ok: true,
                text: `Server detected — ${total} model${total === 1 ? '' : 's'} available`
            });
        } else {
            this._setLmstudioStatus({ tested: true, ok: false, text: 'Server not detected' });
        }
    }

    /**
     * Re-populate the three LM Studio selects from the cached model lists,
     * preserving the user's saved selection if it isn't currently advertised
     * by the server (so we never silently lose their choice).
     */
    _populateLmstudioDropdowns() {
        const savedChat = String(this._settings?.lmstudioChatModel || DEFAULT_LMSTUDIO_CHAT_MODEL);
        const savedEmbed = String(this._settings?.lmstudioEmbeddingModel || DEFAULT_LMSTUDIO_EMBEDDING_MODEL);

        // Prefer the value currently shown in the DOM (it may be newer than
        // _settings if the user just changed it but hasn't saved).
        const currentChat = String(
            this._elements.lmstudioLlmModel?.value
            || this._elements.kgLmstudioChatModel?.value
            || savedChat
        );
        const currentEmbed = String(this._elements.kgLmstudioEmbeddingModel?.value || savedEmbed);

        for (const select of [this._elements.lmstudioLlmModel, this._elements.kgLmstudioChatModel]) {
            this._fillLmstudioSelect(select, this._lmstudioChatModels || [], currentChat);
        }
        this._fillLmstudioSelect(
            this._elements.kgLmstudioEmbeddingModel,
            this._lmstudioEmbeddingModels || [],
            currentEmbed
        );
    }

    /**
     * Replace the options of one LM Studio <select> with the discovered model
     * list, prepending the user's saved value if it isn't in the list. If no
     * models are known we still emit one option (the saved value) so the
     * select isn't visually empty.
     */
    _fillLmstudioSelect(select, models, savedValue) {
        if (!select) return;
        const ids = new Set(models);
        const ordered = [];
        if (savedValue && !ids.has(savedValue)) ordered.push(savedValue);
        for (const id of models) ordered.push(id);
        if (ordered.length === 0 && savedValue) ordered.push(savedValue);

        select.innerHTML = ordered.map((id) => {
            const flag = (savedValue && id === savedValue && !ids.has(id))
                ? ' (saved, not currently loaded)'
                : '';
            return `<option value="${this._escapeAttr(id)}">${this._escapeText(id)}${flag}</option>`;
        }).join('');
        if (savedValue) select.value = savedValue;
    }

    _escapeAttr(s) {
        return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    }

    _escapeText(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    /**
     * "Test Connection" / refresh: delegate to the host (which knows how to
     * talk to the LM Studio provider). Falls back to a direct probe so the
     * button still does something even if no callback is wired.
     */
    async _refreshLmstudioModels() {
        const endpoint = String(this._elements.lmstudioLlmEndpoint?.value || '').trim();
        if (!endpoint) {
            this._setLmstudioStatus({ tested: true, ok: false, text: 'Enter a server URL first' });
            return;
        }
        this._setLmstudioStatus({ tested: true, ok: false, text: 'Testing…' });

        let result;
        if (this._callbacks.onLmstudioDiscover) {
            try {
                result = await this._callbacks.onLmstudioDiscover(endpoint);
            } catch (err) {
                result = { ok: false, error: err?.message || String(err) };
            }
        } else {
            result = await this._fallbackProbe(endpoint);
        }

        if (result?.ok) {
            this.setLmstudioAvailability({
                available: true,
                chatModels: result.chatModels || [],
                embeddingModels: result.embeddingModels || []
            });
        } else {
            this.setLmstudioAvailability({ available: false });
            this._setLmstudioStatus({
                tested: true,
                ok: false,
                text: result?.error ? `Unreachable: ${result.error}` : 'Server not detected'
            });
        }
    }

    async _fallbackProbe(endpoint) {
        try {
            const base = endpoint.replace(/\/+$/, '');
            const res = await fetch(`${base}/v1/models`, { method: 'GET' });
            if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
            const data = await res.json().catch(() => ({}));
            const ids = Array.isArray(data?.data) ? data.data.map((m) => m?.id).filter(Boolean) : [];
            return { ok: true, chatModels: ids, embeddingModels: ids };
        } catch (err) {
            return { ok: false, error: err?.message || String(err) };
        }
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
     * Update MediaPipe LLM model status display
     * @param {{ loaded: boolean, loading: boolean, statusText?: string }} status
     */
    setMediapipeLlmStatus(status) {
        if (status.loading) {
            this._elements.mediapipeLlmStatusText.textContent = status.statusText || 'Loading...';
            this._elements.mediapipeLlmDownloadBtn.style.display = 'none';
        } else if (status.loaded) {
            this._elements.mediapipeLlmStatusText.textContent = status.statusText || 'Model ready';
            this._elements.mediapipeLlmStatusText.style.color = '#059669';
            this._elements.mediapipeLlmDownloadBtn.style.display = 'none';
        } else {
            this._elements.mediapipeLlmStatusText.textContent = status.statusText || 'Model not loaded';
            this._elements.mediapipeLlmStatusText.style.color = '';
            this._elements.mediapipeLlmDownloadBtn.style.display = '';
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
     * Show application log entries in the viewer
     */
    async _showLog() {
        const viewer = this._elements.logViewer;
        viewer.style.display = '';
        viewer.textContent = 'Loading log...';

        try {
            const entries = await appLogger.getEntries();
            if (entries.length === 0) {
                viewer.textContent = 'No log entries.';
                return;
            }

            const lines = entries.map(e => {
                const time = new Date(e.timestamp).toLocaleString();
                const lvl = e.level.toUpperCase().padEnd(5);
                let line = `[${time}] ${lvl} ${e.message}`;
                if (e.memory) {
                    line += `  | heap: ${e.memory.usedMB}/${e.memory.totalMB} MB (limit ${e.memory.limitMB} MB)`;
                }
                if (e.detail) {
                    line += `\n         ${e.detail}`;
                }
                return line;
            });

            viewer.textContent = lines.join('\n');
        } catch (err) {
            viewer.textContent = 'Failed to load log: ' + err.message;
        }
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
            fastApiUrl: this._elements.fastApiUrl.value.trim() || 'http://localhost:8880',
            voice: (() => {
                const isFastAPI = this._elements.ttsBackend.value === 'kokoro-fastapi';
                const custom = this._elements.customVoice.value.trim();
                return (isFastAPI && custom) ? custom : this._elements.voice.value;
            })(),
            speed: parseFloat(this._elements.speed.value),
            prefetchCount: parseInt(this._elements.prefetchCount.value) || 2,
            maxSentenceLength: parseInt(this._elements.maxSentenceLength.value) || 0,
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
            localLlmDeferTts: this._elements.localLlmDeferTts.checked,
            localLlmJitLoading: this._elements.localLlmJitLoading.checked,
            mediapipeLlmHfToken: this._elements.mediapipeLlmHfToken.value.trim(),
            // LM Studio settings — endpoint and chat model are synced across
            // three inputs by the change handler, so any of them is the truth.
            lmstudioEndpoint: (this._elements.lmstudioLlmEndpoint?.value || '').trim()
                || DEFAULT_LMSTUDIO_ENDPOINT,
            lmstudioChatModel: (this._elements.lmstudioLlmModel?.value || '').trim()
                || DEFAULT_LMSTUDIO_CHAT_MODEL,
            lmstudioEmbeddingModel: (this._elements.kgLmstudioEmbeddingModel?.value || '').trim()
                || DEFAULT_LMSTUDIO_EMBEDDING_MODEL,
            // Lookup settings
            lookupLanguage: this._elements.lookupLanguage.value,
            // Quiz settings
            quizMode: this._elements.quizMode.value,
            quizGuided: this._elements.quizGuided.checked,
            quizTtsQuestion: this._elements.quizTtsQuestion.checked,
            quizTtsOptions: this._elements.quizTtsOptions.checked,
            quizTtsCorrectness: this._elements.quizTtsCorrectness.checked,
            quizTtsExplanation: this._elements.quizTtsExplanation.checked,
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
            mediaSessionDuration: parseInt(this._elements.mediaDuration.value) || 300,
            // Transformers.js version
            transformersVersion: this._elements.transformersVersion.value || '3',
            verboseLogging: this._elements.verboseLogging.checked,
            kokoroReinitThreshold: parseInt(this._elements.reinitThreshold.value) || 25,
            // Knowledge Graph settings
            kgExtractionBackend: this._elements.kgBackend.value,
            kgChunkSize: parseInt(this._elements.kgChunkSize.value) || 6,
            kgChunkOverlap: parseInt(this._elements.kgChunkOverlap.value) || 0,
            kgChunksPerRequest: parseInt(this._elements.kgChunksPerRequest.value) || 4,
            kgSimilarityThreshold: parseFloat(this._elements.kgSimilarityThreshold.value) || 0.88,
            kgRelevanceThreshold: (() => {
                const v = parseFloat(this._elements.kgRelevanceThreshold.value);
                return Number.isFinite(v) ? v : 0.15;
            })(),
            kgWheelSensitivity: (() => {
                const v = parseFloat(this._elements.kgWheelSensitivity.value);
                return Number.isFinite(v) && v > 0 ? v : 1.0;
            })(),
            kgFcoseNodeRepulsion: (() => {
                const v = parseInt(this._elements.kgFcoseNodeRepulsion.value, 10);
                return Number.isFinite(v) && v > 0 ? v : 8000;
            })(),
            kgFcoseIdealEdgeLength: (() => {
                const v = parseInt(this._elements.kgFcoseIdealEdgeLength.value, 10);
                return Number.isFinite(v) && v > 0 ? v : 80;
            })(),
            kgFcoseNodeSeparation: (() => {
                const v = parseInt(this._elements.kgFcoseNodeSeparation.value, 10);
                return Number.isFinite(v) && v > 0 ? v : 100;
            })(),
            kgFcoseGravity: (() => {
                const v = parseFloat(this._elements.kgFcoseGravity.value);
                return Number.isFinite(v) && v >= 0 ? v : 0.25;
            })(),
            kgFcoseNumIter: (() => {
                const v = parseInt(this._elements.kgFcoseNumIter.value, 10);
                return Number.isFinite(v) && v > 0 ? v : 2500;
            })(),
            kgFcoseFit: !!this._elements.kgFcoseFit.checked,
            kgNodeSizeScale: (() => {
                const v = parseFloat(this._elements.kgNodeSizeScale.value);
                return Number.isFinite(v) && v >= 0 ? v : 1.0;
            })(),
            kgNeighborhoodHops: (() => {
                const v = parseInt(this._elements.kgNeighborhoodHops.value, 10);
                return Number.isFinite(v) && v >= 0 ? v : 1;
            })(),
            kgEmbeddingSource: this._elements.kgEmbeddingSource.value,
            kgCloudEmbeddingModel: this._elements.kgCloudEmbeddingModel.value,
            kgLocalEmbeddingModel: this._elements.kgLocalEmbeddingModel.value,
            kgSearchMode: this._elements.kgSearchMode.value === 'semantic' ? 'semantic' : 'text',
            kgSemanticSearchThreshold: (() => {
                const v = parseFloat(this._elements.kgSemanticThreshold.value);
                return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5;
            })(),
            // Spaced Review (Grounded SRS) settings
            srsEnabled: this._elements.srsEnabled.checked,
            srsPaddingMode: this._elements.srsPaddingMode.value === 'whole-chapter'
                ? 'whole-chapter' : 'padding',
            srsPaddingSentences: parseInt(this._elements.srsPaddingN.value) || 0,
            srsDistractorCount: parseInt(this._elements.srsDistractorCount.value) || 3,
            srsLLMTemperature: (() => {
                const v = parseFloat(this._elements.srsTemperature.value);
                return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.4;
            })(),
            srsTriggerOnChapterFinish: this._elements.srsTriggerChapterFinish.checked,
            srsTriggerLazyOnOpen: this._elements.srsTriggerLazy.checked,
            srsFailIntervalMinutes: parseInt(this._elements.srsFailInterval.value) || 10,
            srsEaseDefault: (() => {
                const v = parseFloat(this._elements.srsEaseDefault.value);
                return Number.isFinite(v) ? v : 2.5;
            })(),
            srsEaseMin: (() => {
                const v = parseFloat(this._elements.srsEaseMin.value);
                return Number.isFinite(v) ? v : 1.3;
            })(),
            srsEaseStepFail: (() => {
                const v = parseFloat(this._elements.srsEaseStepFail.value);
                return Number.isFinite(v) ? v : 0.2;
            })(),
            srsMaxNewPerSession: parseInt(this._elements.srsMaxNew.value) || 0,
            srsMaxReviewsPerSession: parseInt(this._elements.srsMaxReviews.value) || 0
        };

        // Validate
        if (settings.contextBefore < 0) settings.contextBefore = 0;
        if (settings.contextBefore > 500) settings.contextBefore = 500;
        if (settings.contextAfter < 0) settings.contextAfter = 0;
        if (settings.contextAfter > 500) settings.contextAfter = 500;

        // Detect backend change
        const backendChanged = settings.ttsBackend !== this._settings.ttsBackend ||
            settings.fastApiUrl !== this._settings.fastApiUrl;

        // Detect voice/speed change
        const voiceChanged = settings.voice !== this._settings.voice;
        const speedChanged = settings.speed !== this._settings.speed;
        const prefetchChanged = settings.prefetchCount !== this._settings.prefetchCount;
        const maxSentenceLengthChanged = settings.maxSentenceLength !== this._settings.maxSentenceLength;

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

        if (prefetchChanged) {
            this._callbacks.onPrefetchChange?.(settings.prefetchCount);
        }

        if (maxSentenceLengthChanged) {
            this._callbacks.onMaxSentenceLengthChange?.(settings.maxSentenceLength);
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
        this._refreshKGDomainField();
    }

    /**
     * Populate the KG domain text field from the current book. Called
     * every time the modal opens so the field always reflects the
     * currently-open book (which may have changed since the previous
     * open). Disabled when no book is open or no callback is wired.
     */
    _refreshKGDomainField() {
        const input = this._elements.kgDomain;
        if (!input) return;
        const book = this._callbacks.getBook ? this._callbacks.getBook() : null;
        if (!book) {
            input.value = '';
            input.disabled = true;
            input.placeholder = 'Open a book to edit';
            return;
        }
        input.disabled = false;
        input.placeholder = 'e.g. Molecular cell biology';
        input.value = String(book.kgDomain || '');
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
        this._elements.fastApiUrl.value = this._settings.fastApiUrl || 'http://localhost:8880';

        // Load voice & speed settings
        const savedVoice = this._settings.voice || 'af_bella';
        const voiceInDropdown = Array.from(this._elements.voice.options).some(
            o => o.value === savedVoice && !o.disabled
        );
        if (voiceInDropdown) {
            this._elements.voice.value = savedVoice;
            this._elements.customVoice.value = '';
        } else {
            // Custom combination not in the dropdown - put it in the text input
            this._elements.customVoice.value = savedVoice;
        }
        this._elements.speed.value = this._settings.speed || 1.0;
        this._elements.speedValue.textContent = `${(this._settings.speed || 1.0).toFixed(1)}x`;

        // Load prefetch count
        const prefetchCount = this._settings.prefetchCount || 2;
        this._elements.prefetchCount.value = prefetchCount;
        this._elements.prefetchCountValue.textContent = prefetchCount;

        // Load max sentence length
        const maxSentenceLength = this._settings.maxSentenceLength || 0;
        this._elements.maxSentenceLength.value = maxSentenceLength;
        this._elements.maxSentenceLengthValue.textContent = maxSentenceLength === 0 ? 'Off' : `${maxSentenceLength} chars`;

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
        this._elements.localLlmDeferTts.checked = this._settings.localLlmDeferTts === true; // default false
        this._elements.localLlmJitLoading.checked = this._settings.localLlmJitLoading !== false; // default true
        this._elements.mediapipeLlmHfToken.value = this._settings.mediapipeLlmHfToken || '';

        // LM Studio inputs (mirrored across three sections; populate all).
        // The model fields are <select>s — _populateLmstudioDropdowns will
        // emit the current saved value as an option even when the server
        // hasn't been probed yet, so the dropdown always reflects the
        // persisted choice on settings open.
        const lmstudioEndpoint = this._settings.lmstudioEndpoint || DEFAULT_LMSTUDIO_ENDPOINT;
        if (this._elements.lmstudioLlmEndpoint) this._elements.lmstudioLlmEndpoint.value = lmstudioEndpoint;
        if (this._elements.kgLmstudioEndpoint) this._elements.kgLmstudioEndpoint.value = lmstudioEndpoint;
        if (this._elements.kgLmstudioEmbeddingEndpoint) this._elements.kgLmstudioEmbeddingEndpoint.value = lmstudioEndpoint;
        this._populateLmstudioDropdowns();
        if (!this._lmstudioAvailable) {
            this._setLmstudioStatus({ tested: false });
        }

        this._updateLLMBackendUI();

        // Load lookup settings
        this._elements.lookupLanguage.value = this._settings.lookupLanguage || 'auto';

        // Load quiz settings
        this._elements.quizMode.value = this._settings.quizMode || 'multiple-choice';
        this._elements.quizGuided.checked = this._settings.quizGuided !== false;
        this._elements.quizTtsQuestion.checked = !!this._settings.quizTtsQuestion;
        this._elements.quizTtsOptions.checked = !!this._settings.quizTtsOptions;
        this._elements.quizTtsCorrectness.checked = !!this._settings.quizTtsCorrectness;
        this._elements.quizTtsExplanation.checked = !!this._settings.quizTtsExplanation;
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

        // Load transformers.js version
        this._elements.transformersVersion.value = this._settings.transformersVersion || '3';

        // Load diagnostics settings
        this._elements.verboseLogging.checked = this._settings.verboseLogging || false;
        this._elements.reinitThreshold.value = this._settings.kokoroReinitThreshold || 25;

        // Load Knowledge Graph settings
        this._elements.kgBackend.value = this._settings.kgExtractionBackend || 'openrouter';
        const kgChunkSize = this._settings.kgChunkSize ?? 6;
        this._elements.kgChunkSize.value = kgChunkSize;
        this._elements.kgChunkSizeValue.textContent = kgChunkSize;
        const kgChunkOverlap = this._settings.kgChunkOverlap ?? 2;
        this._elements.kgChunkOverlap.value = kgChunkOverlap;
        this._elements.kgChunkOverlapValue.textContent = kgChunkOverlap;
        const kgChunksPerRequest = this._settings.kgChunksPerRequest ?? 4;
        this._elements.kgChunksPerRequest.value = kgChunksPerRequest;
        this._elements.kgChunksPerRequestValue.textContent = kgChunksPerRequest;
        const kgSimilarityThreshold = this._settings.kgSimilarityThreshold ?? 0.88;
        this._elements.kgSimilarityThreshold.value = kgSimilarityThreshold;
        this._elements.kgSimilarityThresholdValue.textContent = parseFloat(kgSimilarityThreshold).toFixed(2);
        const kgRelevanceThreshold = this._settings.kgRelevanceThreshold ?? 0.15;
        this._elements.kgRelevanceThreshold.value = kgRelevanceThreshold;
        this._elements.kgRelevanceThresholdValue.textContent = parseFloat(kgRelevanceThreshold).toFixed(2);
        const kgWheelSensitivity = this._settings.kgWheelSensitivity ?? 1.0;
        this._elements.kgWheelSensitivity.value = kgWheelSensitivity;
        this._elements.kgWheelSensitivityValue.textContent = parseFloat(kgWheelSensitivity).toFixed(2);
        const kgFcoseNodeRepulsion = this._settings.kgFcoseNodeRepulsion ?? 8000;
        this._elements.kgFcoseNodeRepulsion.value = kgFcoseNodeRepulsion;
        this._elements.kgFcoseNodeRepulsionValue.textContent = String(kgFcoseNodeRepulsion);
        const kgFcoseIdealEdgeLength = this._settings.kgFcoseIdealEdgeLength ?? 80;
        this._elements.kgFcoseIdealEdgeLength.value = kgFcoseIdealEdgeLength;
        this._elements.kgFcoseIdealEdgeLengthValue.textContent = String(kgFcoseIdealEdgeLength);
        const kgFcoseNodeSeparation = this._settings.kgFcoseNodeSeparation ?? 100;
        this._elements.kgFcoseNodeSeparation.value = kgFcoseNodeSeparation;
        this._elements.kgFcoseNodeSeparationValue.textContent = String(kgFcoseNodeSeparation);
        const kgFcoseGravity = this._settings.kgFcoseGravity ?? 0.25;
        this._elements.kgFcoseGravity.value = kgFcoseGravity;
        this._elements.kgFcoseGravityValue.textContent = parseFloat(kgFcoseGravity).toFixed(2);
        const kgFcoseNumIter = this._settings.kgFcoseNumIter ?? 2500;
        this._elements.kgFcoseNumIter.value = kgFcoseNumIter;
        this._elements.kgFcoseNumIterValue.textContent = String(kgFcoseNumIter);
        this._elements.kgFcoseFit.checked = this._settings.kgFcoseFit !== false;
        const kgNodeSizeScale = Number.isFinite(this._settings.kgNodeSizeScale)
            ? this._settings.kgNodeSizeScale : 1.0;
        this._elements.kgNodeSizeScale.value = kgNodeSizeScale;
        this._elements.kgNodeSizeScaleValue.textContent = parseFloat(kgNodeSizeScale).toFixed(2);
        const kgNeighborhoodHops = Number.isFinite(this._settings.kgNeighborhoodHops)
            ? this._settings.kgNeighborhoodHops : 1;
        this._elements.kgNeighborhoodHops.value = kgNeighborhoodHops;
        this._elements.kgNeighborhoodHopsValue.textContent = String(kgNeighborhoodHops);
        const kgSearchMode = this._settings.kgSearchMode === 'semantic' ? 'semantic' : 'text';
        this._elements.kgSearchMode.value = kgSearchMode;
        const kgSemanticThreshold = Number.isFinite(this._settings.kgSemanticSearchThreshold)
            ? this._settings.kgSemanticSearchThreshold : 0.5;
        this._elements.kgSemanticThreshold.value = kgSemanticThreshold;
        this._elements.kgSemanticThresholdValue.textContent = parseFloat(kgSemanticThreshold).toFixed(2);
        // Hide the threshold row when text mode is selected.
        this._elements.kgSemanticThresholdRow?.classList.toggle('hidden', kgSearchMode !== 'semantic');
        this._elements.kgEmbeddingSource.value = this._settings.kgEmbeddingSource || 'openrouter';
        this._elements.kgCloudEmbeddingModel.value = this._settings.kgCloudEmbeddingModel || 'openai/text-embedding-3-small';
        this._elements.kgLocalEmbeddingModel.value = this._settings.kgLocalEmbeddingModel || 'Xenova/all-MiniLM-L6-v2';
        this._updateKGEmbeddingSourceUI();
        this._updateKGExtractionBackendUI();

        // Load Spaced Review (Grounded SRS) settings
        this._elements.srsEnabled.checked = this._settings.srsEnabled !== false;
        const srsPaddingMode = this._settings.srsPaddingMode === 'whole-chapter' ? 'whole-chapter' : 'padding';
        this._elements.srsPaddingMode.value = srsPaddingMode;
        this._elements.srsPaddingRow?.classList.toggle('hidden', srsPaddingMode !== 'padding');
        const srsPaddingN = this._settings.srsPaddingSentences ?? 3;
        this._elements.srsPaddingN.value = srsPaddingN;
        this._elements.srsPaddingNValue.textContent = srsPaddingN;
        const srsDistractorCount = this._settings.srsDistractorCount ?? 3;
        this._elements.srsDistractorCount.value = srsDistractorCount;
        this._elements.srsDistractorCountValue.textContent = srsDistractorCount;
        const srsTemperature = Number.isFinite(this._settings.srsLLMTemperature) ? this._settings.srsLLMTemperature : 0.4;
        this._elements.srsTemperature.value = srsTemperature;
        this._elements.srsTemperatureValue.textContent = srsTemperature.toFixed(2);
        this._elements.srsTriggerChapterFinish.checked = this._settings.srsTriggerOnChapterFinish !== false;
        this._elements.srsTriggerLazy.checked = this._settings.srsTriggerLazyOnOpen !== false;
        const srsFailInterval = this._settings.srsFailIntervalMinutes ?? 10;
        this._elements.srsFailInterval.value = srsFailInterval;
        this._elements.srsFailIntervalValue.textContent = srsFailInterval;
        const srsEaseDefault = Number.isFinite(this._settings.srsEaseDefault) ? this._settings.srsEaseDefault : 2.5;
        this._elements.srsEaseDefault.value = srsEaseDefault;
        this._elements.srsEaseDefaultValue.textContent = srsEaseDefault.toFixed(2);
        const srsEaseMin = Number.isFinite(this._settings.srsEaseMin) ? this._settings.srsEaseMin : 1.3;
        this._elements.srsEaseMin.value = srsEaseMin;
        this._elements.srsEaseMinValue.textContent = srsEaseMin.toFixed(2);
        const srsEaseStepFail = Number.isFinite(this._settings.srsEaseStepFail) ? this._settings.srsEaseStepFail : 0.2;
        this._elements.srsEaseStepFail.value = srsEaseStepFail;
        this._elements.srsEaseStepFailValue.textContent = srsEaseStepFail.toFixed(2);
        const srsMaxNew = this._settings.srsMaxNewPerSession ?? 10;
        this._elements.srsMaxNew.value = srsMaxNew;
        this._elements.srsMaxNewValue.textContent = srsMaxNew;
        const srsMaxReviews = this._settings.srsMaxReviewsPerSession ?? 30;
        this._elements.srsMaxReviews.value = srsMaxReviews;
        this._elements.srsMaxReviewsValue.textContent = srsMaxReviews;

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
