/**
 * Q&A Overlay UI Component
 * Displays the Q&A interface with different states
 */

import { QAState } from '../controllers/qa-controller.js';

export class QAOverlay {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.container - Container element for the overlay
     * @param {Object} callbacks
     * @param {() => void} callbacks.onClose - Close overlay
     * @param {() => void} callbacks.onPause - Pause response
     * @param {() => void} callbacks.onResume - Resume response
     * @param {() => void} callbacks.onStop - Stop Q&A
     * @param {() => void} callbacks.onContinueReading - Return to reading
     * @param {() => void} callbacks.onAskAnother - Ask another question
     * @param {(text: string) => void} callbacks.onTextSubmit - Submit text question
     * @param {() => void} callbacks.onRetryVoice - Retry voice input
     */
    constructor(options, callbacks) {
        this._container = options.container;
        this._callbacks = callbacks;

        this._state = QAState.IDLE;
        this._transcript = '';
        this._response = '';
        this._history = [];
        this._historyIndex = -1;
        this._showTextInput = false;

        this._buildUI();
        this._setupEventListeners();
    }

    /**
     * Build the overlay UI
     */
    _buildUI() {
        this._container.innerHTML = `
            <div class="qa-dialog">
                <div class="qa-header">
                    <h2 class="qa-title">Q&A Mode</h2>
                    <button class="qa-close-btn" aria-label="Close">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="18" y1="6" x2="6" y2="18"/>
                            <line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </button>
                </div>

                <div class="qa-content">
                    <div class="qa-status-section">
                        <div class="qa-icon" id="qa-icon"></div>
                        <div class="qa-status" id="qa-status">Ready</div>
                    </div>

                    <div class="qa-transcript-section" id="qa-transcript-section">
                        <label class="qa-label">Your Question:</label>
                        <div class="qa-transcript" id="qa-transcript"></div>
                    </div>

                    <div class="qa-text-input-section hidden" id="qa-text-input-section">
                        <label class="qa-label">Type your question:</label>
                        <div class="qa-text-input-wrapper">
                            <input type="text" class="qa-text-input" id="qa-text-input" placeholder="Enter your question...">
                            <button class="btn btn-primary qa-submit-btn" id="qa-submit-btn">Ask</button>
                        </div>
                        <button class="btn btn-secondary qa-retry-voice-btn" id="qa-retry-voice-btn">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                                <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                            </svg>
                            Try Voice Again
                        </button>
                    </div>

                    <div class="qa-response-section hidden" id="qa-response-section">
                        <label class="qa-label">Answer:</label>
                        <div class="qa-response" id="qa-response"></div>
                    </div>

                    <div class="qa-history-section hidden" id="qa-history-section">
                        <label class="qa-label">Previous Q&A:</label>
                        <div class="qa-history-nav">
                            <button class="btn-icon qa-history-prev" id="qa-history-prev" disabled>
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <polyline points="15 18 9 12 15 6"/>
                                </svg>
                            </button>
                            <span class="qa-history-counter" id="qa-history-counter">0 / 0</span>
                            <button class="btn-icon qa-history-next" id="qa-history-next" disabled>
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <polyline points="9 18 15 12 9 6"/>
                                </svg>
                            </button>
                        </div>
                        <div class="qa-history-item" id="qa-history-item">
                            <div class="qa-history-question" id="qa-history-question"></div>
                            <div class="qa-history-answer" id="qa-history-answer"></div>
                        </div>
                    </div>
                </div>

                <div class="qa-controls" id="qa-controls">
                    <button class="btn btn-secondary" id="qa-cancel-btn">Cancel</button>
                </div>
            </div>
        `;

        // Cache elements
        this._elements = {
            dialog: this._container.querySelector('.qa-dialog'),
            closeBtn: this._container.querySelector('.qa-close-btn'),
            icon: this._container.querySelector('#qa-icon'),
            status: this._container.querySelector('#qa-status'),
            transcriptSection: this._container.querySelector('#qa-transcript-section'),
            transcript: this._container.querySelector('#qa-transcript'),
            textInputSection: this._container.querySelector('#qa-text-input-section'),
            textInput: this._container.querySelector('#qa-text-input'),
            submitBtn: this._container.querySelector('#qa-submit-btn'),
            retryVoiceBtn: this._container.querySelector('#qa-retry-voice-btn'),
            responseSection: this._container.querySelector('#qa-response-section'),
            response: this._container.querySelector('#qa-response'),
            historySection: this._container.querySelector('#qa-history-section'),
            historyPrev: this._container.querySelector('#qa-history-prev'),
            historyNext: this._container.querySelector('#qa-history-next'),
            historyCounter: this._container.querySelector('#qa-history-counter'),
            historyQuestion: this._container.querySelector('#qa-history-question'),
            historyAnswer: this._container.querySelector('#qa-history-answer'),
            controls: this._container.querySelector('#qa-controls'),
            cancelBtn: this._container.querySelector('#qa-cancel-btn')
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

        // Click outside to close
        this._container.addEventListener('click', (e) => {
            if (e.target === this._container) {
                this._callbacks.onClose?.();
            }
        });

        // Text input submit
        this._elements.submitBtn.addEventListener('click', () => {
            this._submitTextQuestion();
        });

        this._elements.textInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                this._submitTextQuestion();
            }
        });

        // Retry voice button
        this._elements.retryVoiceBtn.addEventListener('click', () => {
            this._callbacks.onRetryVoice?.();
        });

        // History navigation
        this._elements.historyPrev.addEventListener('click', () => {
            this._navigateHistory(-1);
        });

        this._elements.historyNext.addEventListener('click', () => {
            this._navigateHistory(1);
        });

        // Controls container will have dynamic buttons
        this._elements.controls.addEventListener('click', (e) => {
            const btn = e.target.closest('button');
            if (!btn) return;

            const action = btn.dataset.action;
            switch (action) {
                case 'cancel':
                    this._callbacks.onStop?.();
                    this._callbacks.onClose?.();
                    break;
                case 'pause':
                    this._callbacks.onPause?.();
                    break;
                case 'resume':
                    this._callbacks.onResume?.();
                    break;
                case 'stop':
                    this._callbacks.onStop?.();
                    break;
                case 'continue':
                    this._callbacks.onContinueReading?.();
                    break;
                case 'ask-another':
                    this._callbacks.onAskAnother?.();
                    break;
            }
        });
    }

    /**
     * Submit text question
     */
    _submitTextQuestion() {
        const text = this._elements.textInput.value.trim();
        if (text) {
            this._elements.textInput.value = '';
            this._callbacks.onTextSubmit?.(text);
        }
    }

    /**
     * Show the overlay
     */
    show() {
        // Remove hidden first, then add active after a frame to trigger transition
        this._container.classList.remove('hidden');
        // Force reflow
        this._container.offsetHeight;
        this._container.classList.add('active');
    }

    /**
     * Hide the overlay
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
     * Check if overlay is visible
     * @returns {boolean}
     */
    isVisible() {
        return this._container.classList.contains('active');
    }

    /**
     * Update the state
     * @param {string} state
     * @param {Object} [data]
     */
    setState(state, data = {}) {
        this._state = state;

        // Update icon and status
        this._updateStatusDisplay(state);

        // Update sections visibility
        this._updateSectionsVisibility(state, data);

        // Update controls
        this._updateControls(state);

        // Handle error
        if (data.error) {
            this._showError(data.error);
        }
    }

    /**
     * Update status display (icon and text)
     * @param {string} state
     */
    _updateStatusDisplay(state) {
        const iconMap = {
            [QAState.IDLE]: '<span class="qa-icon-emoji">?</span>',
            [QAState.LISTENING]: `
                <div class="qa-listening-animation">
                    <span></span><span></span><span></span>
                </div>
            `,
            [QAState.THINKING]: '<div class="spinner"></div>',
            [QAState.RESPONDING]: `
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polygon points="11 5 6 9 6 15 11 19 11 5"/>
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>
                </svg>
            `,
            [QAState.PAUSED]: `
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="6" y="4" width="4" height="16"/>
                    <rect x="14" y="4" width="4" height="16"/>
                </svg>
            `
        };

        const statusMap = {
            [QAState.IDLE]: 'Ready',
            [QAState.LISTENING]: 'Listening...',
            [QAState.THINKING]: 'Thinking...',
            [QAState.RESPONDING]: 'Responding',
            [QAState.PAUSED]: 'Paused'
        };

        this._elements.icon.innerHTML = iconMap[state] || '';
        this._elements.status.textContent = statusMap[state] || state;
    }

    /**
     * Update sections visibility based on state
     * @param {string} state
     * @param {Object} data
     */
    _updateSectionsVisibility(state, data) {
        // Reset sections
        this._elements.transcriptSection.classList.add('hidden');
        this._elements.textInputSection.classList.add('hidden');
        this._elements.responseSection.classList.add('hidden');

        switch (state) {
            case QAState.IDLE:
                if (this._showTextInput) {
                    this._elements.textInputSection.classList.remove('hidden');
                }
                break;

            case QAState.LISTENING:
                this._elements.transcriptSection.classList.remove('hidden');
                break;

            case QAState.THINKING:
                this._elements.transcriptSection.classList.remove('hidden');
                break;

            case QAState.RESPONDING:
            case QAState.PAUSED:
                this._elements.transcriptSection.classList.remove('hidden');
                this._elements.responseSection.classList.remove('hidden');
                break;
        }
    }

    /**
     * Update control buttons based on state
     * @param {string} state
     */
    _updateControls(state) {
        let html = '';

        switch (state) {
            case QAState.IDLE:
                html = `
                    <button class="btn btn-secondary" data-action="cancel">Close</button>
                `;
                break;

            case QAState.LISTENING:
                html = `
                    <button class="btn btn-secondary" data-action="cancel">Cancel</button>
                `;
                break;

            case QAState.THINKING:
                html = `
                    <button class="btn btn-secondary" data-action="stop">Stop</button>
                `;
                break;

            case QAState.RESPONDING:
                html = `
                    <button class="btn btn-secondary" data-action="pause">Pause</button>
                    <button class="btn btn-secondary" data-action="stop">Stop</button>
                    <button class="btn btn-primary" data-action="continue">Continue Reading</button>
                `;
                break;

            case QAState.PAUSED:
                html = `
                    <button class="btn btn-primary" data-action="resume">Resume</button>
                    <button class="btn btn-secondary" data-action="stop">Stop</button>
                    <button class="btn btn-secondary" data-action="continue">Continue Reading</button>
                    <button class="btn btn-secondary" data-action="ask-another">Ask Another</button>
                `;
                break;
        }

        this._elements.controls.innerHTML = html;
    }

    /**
     * Update transcript display
     * @param {string} text
     */
    setTranscript(text) {
        this._transcript = text;
        this._elements.transcript.textContent = text || '...';
    }

    /**
     * Update response display
     * @param {string} text
     */
    setResponse(text) {
        this._response = text;
        this._elements.response.textContent = text;

        // Auto-scroll to bottom
        this._elements.response.scrollTop = this._elements.response.scrollHeight;
    }

    /**
     * Show text input mode (when STT fails)
     */
    showTextInput() {
        this._showTextInput = true;
        this._elements.textInputSection.classList.remove('hidden');
        this._elements.textInput.focus();
    }

    /**
     * Hide text input mode
     */
    hideTextInput() {
        this._showTextInput = false;
        this._elements.textInputSection.classList.add('hidden');
    }

    /**
     * Show error message
     * @param {string} message
     */
    _showError(message) {
        this._elements.status.textContent = `Error: ${message}`;
        this._elements.icon.innerHTML = `
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
        `;
    }

    /**
     * Set Q&A history
     * @param {Array} history
     */
    setHistory(history) {
        this._history = history;
        this._historyIndex = history.length > 0 ? history.length - 1 : -1;
        this._updateHistoryDisplay();
    }

    /**
     * Add entry to history
     * @param {Object} entry
     */
    addHistoryEntry(entry) {
        this._history.push(entry);
        this._historyIndex = this._history.length - 1;
        this._updateHistoryDisplay();
    }

    /**
     * Navigate history
     * @param {number} direction - -1 for previous, 1 for next
     */
    _navigateHistory(direction) {
        const newIndex = this._historyIndex + direction;
        if (newIndex >= 0 && newIndex < this._history.length) {
            this._historyIndex = newIndex;
            this._updateHistoryDisplay();
        }
    }

    /**
     * Update history display
     */
    _updateHistoryDisplay() {
        if (this._history.length === 0) {
            this._elements.historySection.classList.add('hidden');
            return;
        }

        this._elements.historySection.classList.remove('hidden');

        // Update counter
        this._elements.historyCounter.textContent = `${this._historyIndex + 1} / ${this._history.length}`;

        // Update navigation buttons
        this._elements.historyPrev.disabled = this._historyIndex <= 0;
        this._elements.historyNext.disabled = this._historyIndex >= this._history.length - 1;

        // Update content
        const entry = this._history[this._historyIndex];
        if (entry) {
            this._elements.historyQuestion.textContent = entry.question;
            this._elements.historyAnswer.textContent = entry.answer;
        }
    }

    /**
     * Reset the overlay
     */
    reset() {
        this._transcript = '';
        this._response = '';
        this._showTextInput = false;

        this._elements.transcript.textContent = '';
        this._elements.response.textContent = '';
        this._elements.textInput.value = '';

        this.setState(QAState.IDLE);
    }
}
