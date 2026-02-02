/**
 * Quiz Overlay UI Component
 * Displays quiz questions (multiple choice or free-form) with feedback
 */

import { QuizState } from '../controllers/quiz-controller.js';

const OPTION_LABELS = ['A', 'B', 'C', 'D'];

export class QuizOverlay {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.container
     * @param {Object} callbacks
     * @param {() => void} callbacks.onClose
     * @param {() => void} callbacks.onNextQuestion
     * @param {(index: number) => void} callbacks.onMCAnswer
     * @param {(text: string) => void} callbacks.onTextAnswer
     * @param {() => void} callbacks.onVoiceAnswer
     * @param {() => void} callbacks.onSkipToAnswer
     */
    constructor(options, callbacks) {
        this._container = options.container;
        this._callbacks = callbacks;

        this._state = QuizState.IDLE;
        this._currentQuestion = null;
        this._isMultipleChoice = true;
        this._disabledOptions = [];
        this._selectedCorrect = -1; // index of correct option revealed
        this._showNextButton = false;
        this._feedbackText = '';

        this._buildUI();
        this._setupEventListeners();
    }

    _buildUI() {
        this._container.innerHTML = `
            <div class="quiz-dialog">
                <div class="quiz-header">
                    <h2 class="quiz-title">Quiz Mode</h2>
                    <button class="quiz-close-btn" aria-label="Close">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="18" y1="6" x2="6" y2="18"/>
                            <line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </button>
                </div>

                <div class="quiz-content">
                    <!-- Status (loading/generating) -->
                    <div class="quiz-status-section" id="quiz-status-section">
                        <div class="quiz-icon" id="quiz-icon"></div>
                        <div class="quiz-status" id="quiz-status">Ready</div>
                    </div>

                    <!-- Question text -->
                    <div class="quiz-question-section hidden" id="quiz-question-section">
                        <div class="quiz-question-text" id="quiz-question-text"></div>
                    </div>

                    <!-- MC Options -->
                    <div class="quiz-options-section hidden" id="quiz-options-section">
                        <button class="quiz-option" data-index="0"><span class="quiz-option-label">A)</span> <span class="quiz-option-text"></span></button>
                        <button class="quiz-option" data-index="1"><span class="quiz-option-label">B)</span> <span class="quiz-option-text"></span></button>
                        <button class="quiz-option" data-index="2"><span class="quiz-option-label">C)</span> <span class="quiz-option-text"></span></button>
                        <button class="quiz-option" data-index="3"><span class="quiz-option-label">D)</span> <span class="quiz-option-text"></span></button>
                    </div>

                    <!-- Free-form input -->
                    <div class="quiz-input-section hidden" id="quiz-input-section">
                        <div class="quiz-text-input-wrapper">
                            <input type="text" class="quiz-text-input" id="quiz-text-input" placeholder="Type your answer...">
                            <button class="btn btn-primary quiz-submit-btn" id="quiz-submit-btn">Send</button>
                        </div>
                        <button class="btn btn-secondary quiz-mic-btn" id="quiz-mic-btn">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                                <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                            </svg>
                            Use Microphone
                        </button>
                    </div>

                    <!-- Voice transcript (shown during recording) -->
                    <div class="quiz-transcript-section hidden" id="quiz-transcript-section">
                        <label class="quiz-label">Listening...</label>
                        <div class="quiz-transcript" id="quiz-transcript">...</div>
                    </div>

                    <!-- Feedback -->
                    <div class="quiz-feedback-section hidden" id="quiz-feedback-section">
                        <label class="quiz-label">Feedback:</label>
                        <div class="quiz-feedback" id="quiz-feedback"></div>
                    </div>
                </div>

                <div class="quiz-controls" id="quiz-controls"></div>
            </div>
        `;

        this._elements = {
            dialog: this._container.querySelector('.quiz-dialog'),
            closeBtn: this._container.querySelector('.quiz-close-btn'),
            statusSection: this._container.querySelector('#quiz-status-section'),
            icon: this._container.querySelector('#quiz-icon'),
            status: this._container.querySelector('#quiz-status'),
            questionSection: this._container.querySelector('#quiz-question-section'),
            questionText: this._container.querySelector('#quiz-question-text'),
            optionsSection: this._container.querySelector('#quiz-options-section'),
            options: this._container.querySelectorAll('.quiz-option'),
            optionTexts: this._container.querySelectorAll('.quiz-option-text'),
            inputSection: this._container.querySelector('#quiz-input-section'),
            textInput: this._container.querySelector('#quiz-text-input'),
            submitBtn: this._container.querySelector('#quiz-submit-btn'),
            micBtn: this._container.querySelector('#quiz-mic-btn'),
            transcriptSection: this._container.querySelector('#quiz-transcript-section'),
            transcript: this._container.querySelector('#quiz-transcript'),
            feedbackSection: this._container.querySelector('#quiz-feedback-section'),
            feedback: this._container.querySelector('#quiz-feedback'),
            controls: this._container.querySelector('#quiz-controls')
        };
    }

    _setupEventListeners() {
        // Close
        this._elements.closeBtn.addEventListener('click', () => {
            this._callbacks.onClose?.();
        });

        this._container.addEventListener('click', (e) => {
            if (e.target === this._container) {
                this._callbacks.onClose?.();
            }
        });

        // MC option clicks
        this._elements.optionsSection.addEventListener('click', (e) => {
            const btn = e.target.closest('.quiz-option');
            if (!btn || btn.disabled) return;
            const index = parseInt(btn.dataset.index, 10);
            this._callbacks.onMCAnswer?.(index);
        });

        // Free-form text submit
        this._elements.submitBtn.addEventListener('click', () => {
            this._submitText();
        });

        this._elements.textInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                this._submitText();
            }
        });

        // Voice input
        this._elements.micBtn.addEventListener('click', () => {
            this._callbacks.onVoiceAnswer?.();
        });

        // Dynamic controls
        this._elements.controls.addEventListener('click', (e) => {
            const btn = e.target.closest('button');
            if (!btn) return;
            const action = btn.dataset.action;
            switch (action) {
                case 'next-question':
                    this._callbacks.onNextQuestion?.();
                    break;
                case 'skip-answer':
                    this._callbacks.onSkipToAnswer?.();
                    break;
                case 'close':
                    this._callbacks.onClose?.();
                    break;
            }
        });
    }

    _submitText() {
        const text = this._elements.textInput.value.trim();
        if (text) {
            this._elements.textInput.value = '';
            this._callbacks.onTextAnswer?.(text);
        }
    }

    // ========== Public API ==========

    show() {
        this._container.classList.remove('hidden');
        this._container.offsetHeight;
        this._container.classList.add('active');
    }

    hide() {
        this._container.classList.remove('active');
        setTimeout(() => {
            if (!this._container.classList.contains('active')) {
                this._container.classList.add('hidden');
            }
        }, 300);
    }

    isVisible() {
        return this._container.classList.contains('active');
    }

    setMultipleChoice(isMultipleChoice) {
        this._isMultipleChoice = isMultipleChoice;
    }

    /**
     * Show the transcript section (when voice recording starts)
     */
    showTranscript() {
        this._elements.transcriptSection.classList.remove('hidden');
        this._elements.transcript.textContent = '...';
    }

    /**
     * Hide the transcript section (when voice recording ends)
     */
    hideTranscript() {
        this._elements.transcriptSection.classList.add('hidden');
    }

    /**
     * Update live transcript text
     * @param {string} text
     */
    setTranscript(text) {
        this._elements.transcript.textContent = text || '...';
    }

    /**
     * Show a new question
     * @param {Object} question - { question, options?, correctIndex?, explanation? }
     */
    showQuestion(question) {
        this._currentQuestion = question;
        this._disabledOptions = [];
        this._selectedCorrect = -1;
        this._showNextButton = false;
        this._feedbackText = '';

        // Show question text
        this._elements.questionSection.classList.remove('hidden');
        this._elements.questionText.textContent = question.question;

        // Hide feedback
        this._elements.feedbackSection.classList.add('hidden');
        this._elements.feedback.textContent = '';

        if (this._isMultipleChoice && question.options) {
            // Show MC options
            this._elements.optionsSection.classList.remove('hidden');
            this._elements.inputSection.classList.add('hidden');

            question.options.forEach((opt, i) => {
                this._elements.optionTexts[i].textContent = opt;
                this._elements.options[i].disabled = false;
                this._elements.options[i].className = 'quiz-option';
            });
        } else {
            // Show free-form input
            this._elements.optionsSection.classList.add('hidden');
            this._elements.inputSection.classList.remove('hidden');
            this._elements.textInput.value = '';
            this._elements.textInput.disabled = false;
            this._elements.submitBtn.disabled = false;
            this._elements.micBtn.disabled = false;
        }
    }

    /**
     * Update MC option states (disable tried options, mark correct/incorrect)
     * @param {Object} result - { correct, selectedIndex, correctIndex, feedback, done }
     */
    showAnswerResult(result) {
        this._feedbackText = result.feedback || '';

        // Show feedback section
        if (this._feedbackText) {
            this._elements.feedbackSection.classList.remove('hidden');
            this._elements.feedback.textContent = this._feedbackText;
            this._elements.feedback.scrollTop = this._elements.feedback.scrollHeight;
        }

        if (this._isMultipleChoice) {
            if (result.selectedIndex !== undefined) {
                const selectedBtn = this._elements.options[result.selectedIndex];
                if (result.correct) {
                    selectedBtn.classList.add('quiz-option-correct');
                } else {
                    selectedBtn.classList.add('quiz-option-incorrect');
                    selectedBtn.disabled = true;
                    this._disabledOptions.push(result.selectedIndex);
                }
            }

            // Reveal correct answer if done
            if (result.done && result.correctIndex !== undefined) {
                this._elements.options[result.correctIndex].classList.add('quiz-option-correct');
            }

            if (result.done) {
                // Disable all options
                this._elements.options.forEach(opt => opt.disabled = true);
            }
        } else {
            // Free-form
            if (result.done) {
                this._elements.textInput.disabled = true;
                this._elements.submitBtn.disabled = true;
                this._elements.micBtn.disabled = true;
            }
        }

        this._showNextButton = result.done;
        this._updateControls();
    }

    /**
     * Update streaming feedback text
     * @param {string} text
     */
    setFeedbackText(text) {
        this._feedbackText = text;
        this._elements.feedbackSection.classList.remove('hidden');
        this._elements.feedback.textContent = text;
        this._elements.feedback.scrollTop = this._elements.feedback.scrollHeight;
    }

    /**
     * Update UI state based on controller state
     * @param {string} state
     * @param {Object} [data]
     */
    setState(state, data = {}) {
        this._state = state;
        this._updateStatusDisplay(state);
        this._updateInteractivity(state);
        this._updateControls();
    }

    /**
     * Show error
     * @param {string} message
     */
    showError(message) {
        this._elements.icon.innerHTML = `
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
        `;
        this._elements.status.textContent = `Error: ${message}`;
        this._elements.statusSection.classList.remove('hidden');
    }

    /**
     * Reset for new session
     */
    reset() {
        this._currentQuestion = null;
        this._disabledOptions = [];
        this._selectedCorrect = -1;
        this._showNextButton = false;
        this._feedbackText = '';

        this._elements.questionSection.classList.add('hidden');
        this._elements.optionsSection.classList.add('hidden');
        this._elements.inputSection.classList.add('hidden');
        this._elements.transcriptSection.classList.add('hidden');
        this._elements.feedbackSection.classList.add('hidden');
        this._elements.feedback.textContent = '';
        this._elements.transcript.textContent = '...';
        this._elements.textInput.value = '';

        this.setState(QuizState.IDLE);
    }

    // ========== Internal ==========

    _updateStatusDisplay(state) {
        switch (state) {
            case QuizState.IDLE:
                this._elements.statusSection.classList.remove('hidden');
                this._elements.icon.innerHTML = '<span class="quiz-icon-emoji">?</span>';
                this._elements.status.textContent = 'Ready to quiz';
                break;
            case QuizState.GENERATING:
                this._elements.statusSection.classList.remove('hidden');
                this._elements.icon.innerHTML = '<div class="spinner"></div>';
                this._elements.status.textContent = 'Generating question...';
                break;
            case QuizState.SPEAKING_QUESTION:
                this._elements.statusSection.classList.add('hidden');
                break;
            case QuizState.AWAITING_ANSWER:
                this._elements.statusSection.classList.add('hidden');
                break;
            case QuizState.EVALUATING:
                this._elements.statusSection.classList.remove('hidden');
                this._elements.icon.innerHTML = '<div class="spinner"></div>';
                this._elements.status.textContent = 'Evaluating...';
                break;
            case QuizState.SPEAKING_FEEDBACK:
                this._elements.statusSection.classList.add('hidden');
                break;
        }
    }

    _updateInteractivity(state) {
        const answerable = state === QuizState.AWAITING_ANSWER;

        // MC options
        if (this._isMultipleChoice && this._currentQuestion?.options) {
            this._elements.options.forEach((opt, i) => {
                if (this._disabledOptions.includes(i) || this._showNextButton) {
                    opt.disabled = true;
                } else {
                    opt.disabled = !answerable;
                }
            });
        }

        // Free-form inputs
        this._elements.textInput.disabled = !answerable || this._showNextButton;
        this._elements.submitBtn.disabled = !answerable || this._showNextButton;
        this._elements.micBtn.disabled = !answerable || this._showNextButton;
    }

    _updateControls() {
        let html = '';

        if (this._state === QuizState.GENERATING) {
            html = `<button class="btn btn-secondary" data-action="close">Cancel</button>`;
        } else if (this._showNextButton) {
            html = `
                <button class="btn btn-primary" data-action="next-question">Next Question</button>
                <button class="btn btn-secondary" data-action="close">Close</button>
            `;
        } else if (this._state === QuizState.AWAITING_ANSWER || this._state === QuizState.SPEAKING_QUESTION) {
            html = `
                <button class="btn btn-secondary" data-action="skip-answer">Skip to Answer</button>
                <button class="btn btn-secondary" data-action="close">Close</button>
            `;
        } else if (this._state === QuizState.EVALUATING || this._state === QuizState.SPEAKING_FEEDBACK) {
            html = `<button class="btn btn-secondary" data-action="close">Close</button>`;
        } else {
            html = `
                <button class="btn btn-primary" data-action="next-question">Start Quiz</button>
                <button class="btn btn-secondary" data-action="close">Close</button>
            `;
        }

        this._elements.controls.innerHTML = html;
    }
}
