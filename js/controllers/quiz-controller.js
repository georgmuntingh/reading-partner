/**
 * Quiz Controller
 * Orchestrates quiz generation, answer evaluation, hints, and TTS feedback
 */

import { sttService as defaultSttService } from '../services/stt-service.js';
import { llmClient } from '../services/llm-client.js';
import { ttsEngine } from '../services/tts-engine.js';
import { storage } from '../services/storage.js';

export const QuizState = {
    IDLE: 'idle',
    GENERATING: 'generating',
    AWAITING_ANSWER: 'awaiting_answer',
    EVALUATING: 'evaluating',
    SPEAKING_QUESTION: 'speaking_question',
    SPEAKING_FEEDBACK: 'speaking_feedback'
};

export class QuizController {
    /**
     * @param {Object} options
     * @param {Object} options.readingState - ReadingStateController instance
     * @param {(state: string, data?: any) => void} options.onStateChange
     * @param {(question: Object) => void} options.onQuestionReady
     * @param {(text: string) => void} options.onFeedbackChunk - Streaming feedback text
     * @param {(result: Object) => void} options.onAnswerResult - { correct, feedback, done }
     * @param {(text: string) => void} options.onTranscript - Live voice transcript
     * @param {() => void} options.onVoiceStart - Voice recording started
     * @param {() => void} options.onVoiceEnd - Voice recording ended
     * @param {(error: string) => void} options.onError
     */
    constructor(options) {
        this._readingState = options.readingState;
        this._onStateChange = options.onStateChange;
        this._onQuestionReady = options.onQuestionReady;
        this._onFeedbackChunk = options.onFeedbackChunk;
        this._onAnswerResult = options.onAnswerResult;
        this._onTranscript = options.onTranscript;
        this._onVoiceStart = options.onVoiceStart;
        this._onVoiceEnd = options.onVoiceEnd;
        this._onError = options.onError;

        // STT service (injectable, defaults to Web Speech API singleton)
        this._sttService = options.sttService || defaultSttService;

        // State
        this._state = QuizState.IDLE;
        this._currentQuestion = null;
        this._previousQuestions = [];
        this._disabledOptions = []; // MC options already tried (guided mode)
        this._chatHistory = []; // For free-form conversation context

        // TTS state
        this._playbackSpeed = 1.0;
        this._isStopped = false;
        this._feedbackSentences = [];
        this._currentSentenceIndex = 0;
        this._audioBufferCache = new Map();
        this._speechCache = new Map(); // text → Promise<AudioBuffer> | AudioBuffer
        this._isStreamingComplete = false;

        // Settings
        this._bookMeta = null;
        this._isMultipleChoice = true;
        this._isGuided = true;
        this._questionTypes = ['factual'];
        this._useFullChapter = true;
        this._customSystemPrompt = '';
        this._selectionContext = null;

        // TTS component flags (all off by default)
        this._ttsQuestion = false;
        this._ttsOptions = false;
        this._ttsCorrectness = false;
        this._ttsExplanation = false;
    }

    // ========== Getters ==========

    getState() {
        return this._state;
    }

    isActive() {
        return this._state !== QuizState.IDLE;
    }

    getCurrentQuestion() {
        return this._currentQuestion;
    }

    getDisabledOptions() {
        return [...this._disabledOptions];
    }

    // ========== Settings ==========

    /**
     * Switch the STT service (e.g., from Web Speech to Whisper)
     * @param {Object} sttService - STT service instance with same API
     */
    setSTTService(sttService) {
        this._sttService = sttService;
    }

    setBookMeta(bookMeta) {
        this._bookMeta = bookMeta;
    }

    setPlaybackSpeed(speed) {
        this._playbackSpeed = speed;
    }

    setSettings({ isMultipleChoice, isGuided, questionTypes, useFullChapter, customSystemPrompt, ttsQuestion, ttsOptions, ttsCorrectness, ttsExplanation }) {
        if (isMultipleChoice !== undefined) this._isMultipleChoice = isMultipleChoice;
        if (isGuided !== undefined) this._isGuided = isGuided;
        if (questionTypes !== undefined) this._questionTypes = questionTypes;
        if (useFullChapter !== undefined) this._useFullChapter = useFullChapter;
        if (customSystemPrompt !== undefined) this._customSystemPrompt = customSystemPrompt;
        if (ttsQuestion !== undefined) this._ttsQuestion = ttsQuestion;
        if (ttsOptions !== undefined) this._ttsOptions = ttsOptions;
        if (ttsCorrectness !== undefined) this._ttsCorrectness = ttsCorrectness;
        if (ttsExplanation !== undefined) this._ttsExplanation = ttsExplanation;
    }

    /**
     * Set override context sentences (e.g., from text selection).
     * When set, these are used instead of chapter-based context.
     * Cleared when stop() is called.
     * @param {string[]|null} sentences
     */
    setSelectionContext(sentences) {
        this._selectionContext = sentences;
    }

    // ========== Quiz Flow ==========

    /**
     * Generate and show the next question
     */
    async nextQuestion() {
        if (this._state !== QuizState.IDLE && this._state !== QuizState.AWAITING_ANSWER &&
            this._state !== QuizState.SPEAKING_FEEDBACK) {
            return;
        }

        this._isStopped = false;
        this._disabledOptions = [];
        this._chatHistory = [];
        this._currentQuestion = null;
        this._clearTTSState();

        this._setState(QuizState.GENERATING);

        try {
            const contextSentences = await this._getContextSentences();

            const question = await llmClient.generateQuizQuestion({
                contextSentences,
                bookMeta: this._bookMeta,
                isMultipleChoice: this._isMultipleChoice,
                questionTypes: this._questionTypes,
                previousQuestions: this._previousQuestions,
                customSystemPrompt: this._customSystemPrompt
            });

            if (this._isStopped) return;

            this._currentQuestion = question;
            this._previousQuestions.push(question);

            // Pre-fetch TTS in parallel with DB persistence to eliminate gaps
            if (this._ttsQuestion) {
                this._prefetchSpeech(question.question);
            }
            if (this._ttsOptions && this._isMultipleChoice && question.options?.length) {
                const labels = ['A', 'B', 'C', 'D'];
                for (let i = 0; i < question.options.length; i++) {
                    const label = labels[i] || String(i + 1);
                    this._prefetchSpeech(`${label}. ${question.options[i]}`);
                }
            }
            if (this._ttsCorrectness) {
                this._prefetchSpeech('Correct!');
                this._prefetchSpeech('That is incorrect.');
            }

            // Save to persistence (synthesis runs in parallel)
            await this._persistQuestion(question);

            this._onQuestionReady?.(question);
            this._setState(QuizState.SPEAKING_QUESTION);

            // Speak the question text
            if (this._ttsQuestion) {
                await this._speakText(question.question);
                if (this._isStopped) return;
            }

            // Speak multiple choice options
            if (this._ttsOptions && this._isMultipleChoice && question.options?.length) {
                const labels = ['A', 'B', 'C', 'D'];
                for (let i = 0; i < question.options.length; i++) {
                    if (this._isStopped) return;
                    const label = labels[i] || String(i + 1);
                    await this._speakText(`${label}. ${question.options[i]}`);
                }
            }

            if (this._isStopped) return;

            this._setState(QuizState.AWAITING_ANSWER);
        } catch (error) {
            if (this._isStopped) return;
            console.error('Quiz question generation error:', error);
            this._onError?.(error.message);
            this._setState(QuizState.IDLE);
        }
    }

    /**
     * Submit a multiple choice answer
     * @param {number} selectedIndex - 0-3
     */
    async submitMCAnswer(selectedIndex) {
        if (this._state !== QuizState.AWAITING_ANSWER || !this._currentQuestion) return;

        this._stopTTS();
        const correct = selectedIndex === this._currentQuestion.correctIndex;

        if (correct) {
            this._onAnswerResult?.({
                correct: true,
                selectedIndex,
                feedback: this._currentQuestion.explanation,
                done: true
            });
            this._setState(QuizState.SPEAKING_FEEDBACK);
            // Pre-fetch explanation so it's ready when "Correct!" finishes playing
            if (this._ttsExplanation && this._currentQuestion.explanation) {
                this._prefetchSpeech(this._currentQuestion.explanation);
            }
            if (this._ttsCorrectness) {
                await this._speakText('Correct!');
                if (this._isStopped) return;
            }
            if (this._ttsExplanation) {
                await this._speakText(this._currentQuestion.explanation);
                if (this._isStopped) return;
            }
            if (!this._isStopped) {
                this._setState(QuizState.AWAITING_ANSWER);
            }
        } else if (this._isGuided) {
            // Guided: hint + try again
            this._disabledOptions.push(selectedIndex);
            this._setState(QuizState.EVALUATING);

            try {
                const hint = await this._getMCHint(selectedIndex);
                if (this._isStopped) return;

                this._onAnswerResult?.({
                    correct: false,
                    selectedIndex,
                    feedback: hint,
                    done: false
                });
                this._setState(QuizState.SPEAKING_FEEDBACK);
                // Pre-fetch hint audio so it's ready when "That is incorrect." finishes
                if (this._ttsExplanation && hint) {
                    this._prefetchSpeech(hint);
                }
                if (this._ttsCorrectness) {
                    await this._speakText('That is incorrect.');
                    if (this._isStopped) return;
                }
                if (this._ttsExplanation) {
                    await this._speakText(hint);
                    if (this._isStopped) return;
                }
                if (!this._isStopped) {
                    this._setState(QuizState.AWAITING_ANSWER);
                }
            } catch (error) {
                if (this._isStopped) return;
                console.error('Hint error:', error);
                this._onError?.(error.message);
                this._setState(QuizState.AWAITING_ANSWER);
            }
        } else {
            // Single shot: reveal answer
            const feedback = `The correct answer was: ${this._currentQuestion.options[this._currentQuestion.correctIndex]}. ${this._currentQuestion.explanation}`;
            this._onAnswerResult?.({
                correct: false,
                selectedIndex,
                correctIndex: this._currentQuestion.correctIndex,
                feedback,
                done: true
            });
            this._setState(QuizState.SPEAKING_FEEDBACK);
            // Pre-fetch feedback so it's ready when "That is incorrect." finishes
            if (this._ttsExplanation && feedback) {
                this._prefetchSpeech(feedback);
            }
            if (this._ttsCorrectness) {
                await this._speakText('That is incorrect.');
                if (this._isStopped) return;
            }
            if (this._ttsExplanation) {
                await this._speakText(feedback);
                if (this._isStopped) return;
            }
            if (!this._isStopped) {
                this._setState(QuizState.AWAITING_ANSWER);
            }
        }
    }

    /**
     * Submit a free-form text answer
     * @param {string} answer
     */
    async submitFreeFormAnswer(answer) {
        if (this._state !== QuizState.AWAITING_ANSWER || !this._currentQuestion) return;
        if (!answer || !answer.trim()) return;

        this._stopTTS();
        this._setState(QuizState.EVALUATING);

        try {
            const contextSentences = await this._getContextSentences();
            const contextText = contextSentences.join(' ');

            const systemPrompt = `You are evaluating a reading comprehension answer. Based on the provided book context, evaluate if the student's answer is correct.

IMPORTANT: Start your response with exactly "CORRECT" or "INCORRECT" on the first line.
Then provide concise feedback.${this._isGuided ? '\nIf incorrect, give a helpful hint without revealing the answer.' : '\nIf incorrect, explain the correct answer.'}`;

            // Build message history
            const messages = [
                { role: 'system', content: systemPrompt }
            ];

            // Add context
            let contextMsg = '';
            if (this._bookMeta?.title) {
                contextMsg += `Book: ${this._bookMeta.title}`;
                if (this._bookMeta.author) contextMsg += ` by ${this._bookMeta.author}`;
                contextMsg += '\n\n';
            }
            contextMsg += `Context from the book:\n"${contextText}"\n\nQuestion: ${this._currentQuestion.question}`;

            // Include previous attempts if in guided mode
            if (this._chatHistory.length > 0) {
                for (const entry of this._chatHistory) {
                    messages.push({ role: 'user', content: entry.userMsg });
                    messages.push({ role: 'assistant', content: entry.assistantMsg });
                }
                messages.push({ role: 'user', content: `Student's new answer: "${answer.trim()}"` });
            } else {
                messages.push({ role: 'user', content: contextMsg + `\n\nStudent's answer: "${answer.trim()}"` });
            }

            // Stream the response
            let fullResponse = '';
            await llmClient.streamQuizChat(
                messages,
                (chunk) => {
                    fullResponse += chunk;
                    this._onFeedbackChunk?.(fullResponse);
                },
                (sentence) => {
                    if (this._isStopped) return;
                    const idx = this._feedbackSentences.length;
                    this._feedbackSentences.push(sentence);
                    if (this._ttsExplanation) {
                        this._prefetchAudio(idx, sentence);
                    }
                    if (this._state === QuizState.EVALUATING && this._feedbackSentences.length === 1) {
                        this._setState(QuizState.SPEAKING_FEEDBACK);
                        if (this._ttsExplanation) {
                            this._startFeedbackSpeaking();
                        }
                    }
                }
            );

            if (this._isStopped) return;
            this._isStreamingComplete = true;

            // Determine correctness from first line
            const firstLine = fullResponse.trim().split('\n')[0].toUpperCase();
            const isCorrect = firstLine.startsWith('CORRECT');

            // Strip CORRECT/INCORRECT prefix for display
            const feedbackText = fullResponse.replace(/^(CORRECT|INCORRECT)[:\s]*/i, '').trim();

            // Save chat history for guided follow-ups
            const userMsg = this._chatHistory.length > 0
                ? `Student's new answer: "${answer.trim()}"`
                : `${contextMsg}\n\nStudent's answer: "${answer.trim()}"`;
            this._chatHistory.push({ userMsg, assistantMsg: fullResponse });

            const isDone = isCorrect || !this._isGuided;

            // For guided incorrect: show result immediately so user can try again
            if (!isDone) {
                this._onAnswerResult?.({
                    correct: false,
                    feedback: feedbackText,
                    done: false
                });
            }

            // Wait for feedback TTS to finish before showing "done" state
            await this._waitForSpeakingDone();

            if (this._isStopped) return;

            // For done case: show result after TTS so user hears full feedback
            if (isDone) {
                this._onAnswerResult?.({
                    correct: isCorrect,
                    feedback: feedbackText,
                    done: true
                });
            }

            this._setState(QuizState.AWAITING_ANSWER);
        } catch (error) {
            if (this._isStopped) return;
            console.error('Answer evaluation error:', error);
            this._onError?.(error.message);
            this._setState(QuizState.AWAITING_ANSWER);
        }
    }

    /**
     * Submit a voice answer (starts STT, then evaluates)
     * @returns {Promise<void>}
     */
    async submitVoiceAnswer() {
        if (this._state !== QuizState.AWAITING_ANSWER) return;

        this._stopTTS();

        // Wire up live transcription
        const prevOnInterim = this._sttService.onInterimResult;
        this._sttService.onInterimResult = (text) => {
            this._onTranscript?.(text);
        };

        this._onVoiceStart?.();

        try {
            const answer = await this._sttService.startListening();

            // Restore previous callback and signal end
            this._sttService.onInterimResult = prevOnInterim;
            this._onVoiceEnd?.();

            if (answer && answer.trim()) {
                if (this._isMultipleChoice) {
                    // Try to match voice answer to MC option
                    const idx = this._matchVoiceToOption(answer);
                    if (idx !== -1) {
                        await this.submitMCAnswer(idx);
                    } else {
                        this._onError?.('Could not match your answer to an option. Please try clicking an option instead.');
                    }
                } else {
                    await this.submitFreeFormAnswer(answer);
                }
            }
        } catch (error) {
            // Restore previous callback and signal end
            this._sttService.onInterimResult = prevOnInterim;
            this._onVoiceEnd?.();

            if (error.message !== 'Speech recognition aborted') {
                this._onError?.(error.message);
            }
        }
    }

    /**
     * Skip to revealing the answer
     */
    async skipToAnswer() {
        if (!this._currentQuestion) return;

        this._stopTTS();
        this._clearTTSState();
        llmClient.abort();

        if (this._isMultipleChoice) {
            const feedback = `The correct answer is: ${this._currentQuestion.options[this._currentQuestion.correctIndex]}. ${this._currentQuestion.explanation}`;
            this._onAnswerResult?.({
                correct: false,
                correctIndex: this._currentQuestion.correctIndex,
                feedback,
                done: true,
                skipped: true
            });
            this._setState(QuizState.SPEAKING_FEEDBACK);
            if (this._ttsExplanation) {
                await this._speakText(feedback);
                if (this._isStopped) return;
            }
            if (!this._isStopped) {
                this._setState(QuizState.AWAITING_ANSWER);
            }
        } else {
            // For free-form, ask LLM to reveal the answer
            this._setState(QuizState.EVALUATING);
            try {
                const contextSentences = await this._getContextSentences();
                const contextText = contextSentences.join(' ');

                const messages = [
                    {
                        role: 'system',
                        content: 'You are a reading comprehension quiz master. The student is skipping this question. Provide the answer concisely.'
                    },
                    {
                        role: 'user',
                        content: `Context from the book:\n"${contextText}"\n\nQuestion: ${this._currentQuestion.question}\n\nPlease provide the answer.`
                    }
                ];

                let fullResponse = '';
                await llmClient.streamQuizChat(
                    messages,
                    (chunk) => {
                        fullResponse += chunk;
                        this._onFeedbackChunk?.(fullResponse);
                    },
                    (sentence) => {
                        if (this._isStopped) return;
                        const idx = this._feedbackSentences.length;
                        this._feedbackSentences.push(sentence);
                        if (this._ttsExplanation) {
                            this._prefetchAudio(idx, sentence);
                        }
                        if (this._state === QuizState.EVALUATING && this._feedbackSentences.length === 1) {
                            this._setState(QuizState.SPEAKING_FEEDBACK);
                            if (this._ttsExplanation) {
                                this._startFeedbackSpeaking();
                            }
                        }
                    }
                );

                if (this._isStopped) return;
                this._isStreamingComplete = true;

                // Wait for TTS to finish before showing done state
                await this._waitForSpeakingDone();

                if (this._isStopped) return;

                this._onAnswerResult?.({
                    correct: false,
                    feedback: fullResponse,
                    done: true,
                    skipped: true
                });

                if (!this._isStopped) {
                    this._setState(QuizState.AWAITING_ANSWER);
                }
            } catch (error) {
                if (this._isStopped) return;
                console.error('Skip to answer error:', error);
                this._onError?.(error.message);
                this._setState(QuizState.AWAITING_ANSWER);
            }
        }
    }

    /**
     * Stop quiz mode
     */
    stop() {
        this._isStopped = true;
        this._sttService.abortListening();
        llmClient.abort();
        this._stopTTS();
        this._clearTTSState();
        this._currentQuestion = null;
        this._disabledOptions = [];
        this._chatHistory = [];
        this._selectionContext = null;
        this._setState(QuizState.IDLE);
    }

    /**
     * Reset quiz session (clear previous questions)
     */
    resetSession() {
        this._previousQuestions = [];
    }

    // ========== Internal: Context ==========

    async _getContextSentences() {
        // Use selection context if available
        if (this._selectionContext && this._selectionContext.length > 0) {
            return this._selectionContext;
        }

        if (!this._readingState) return [];

        const position = this._readingState.getCurrentPosition();

        if (this._useFullChapter) {
            return await this._readingState.loadChapter(position.chapterIndex);
        }

        // Up to current sentence
        const sentences = await this._readingState.loadChapter(position.chapterIndex);
        return sentences.slice(0, position.sentenceIndex + 1);
    }

    // ========== Internal: MC Hint ==========

    async _getMCHint(selectedIndex) {
        const contextSentences = await this._getContextSentences();
        const contextText = contextSentences.join(' ');

        const messages = [
            {
                role: 'system',
                content: 'You are a quiz master helping a student. They selected a wrong answer. Give a brief, helpful hint (1-2 sentences) explaining why their choice is incorrect, without revealing the correct answer.'
            },
            {
                role: 'user',
                content: `Context: "${contextText}"\n\nQuestion: ${this._currentQuestion.question}\nOptions: ${this._currentQuestion.options.map((o, i) => `${i}) ${o}`).join(', ')}\nCorrect answer index: ${this._currentQuestion.correctIndex}\nStudent chose: ${selectedIndex}) ${this._currentQuestion.options[selectedIndex]}\n\nGive a hint.`
            }
        ];

        let hint = '';
        await llmClient.streamQuizChat(messages, (chunk) => {
            hint += chunk;
            this._onFeedbackChunk?.(hint);
        }, null);

        return hint;
    }

    // ========== Internal: Voice to MC option matching ==========

    _matchVoiceToOption(voiceText) {
        const lower = voiceText.toLowerCase().trim();

        // Try letter matching (A, B, C, D)
        const letters = ['a', 'b', 'c', 'd'];
        for (let i = 0; i < letters.length; i++) {
            if (lower === letters[i] || lower.startsWith(letters[i] + ')') || lower.startsWith(letters[i] + '.') || lower.startsWith('option ' + letters[i])) {
                if (!this._disabledOptions.includes(i)) return i;
            }
        }

        // Try number matching (1, 2, 3, 4)
        for (let i = 0; i < 4; i++) {
            if (lower === String(i + 1) || lower.startsWith(String(i + 1) + ')')) {
                if (!this._disabledOptions.includes(i)) return i;
            }
        }

        // Try fuzzy content matching
        if (this._currentQuestion?.options) {
            for (let i = 0; i < this._currentQuestion.options.length; i++) {
                if (this._disabledOptions.includes(i)) continue;
                if (this._currentQuestion.options[i].toLowerCase().includes(lower) ||
                    lower.includes(this._currentQuestion.options[i].toLowerCase())) {
                    return i;
                }
            }
        }

        return -1;
    }

    // ========== Internal: TTS ==========

    _stopTTS() {
        ttsEngine.stopAudio();
    }

    _clearTTSState() {
        this._feedbackSentences = [];
        this._currentSentenceIndex = 0;
        this._audioBufferCache.clear();
        this._speechCache.clear();
        this._isStreamingComplete = false;
        this._speakingDoneResolve = null;
    }

    /**
     * Speak a short text (non-streaming, for questions and short feedback).
     * Uses the speech cache if a pre-fetch was started earlier.
     */
    async _speakText(text) {
        if (!text || !text.trim() || this._isStopped) return;

        try {
            let audioBuffer;
            const cached = this._speechCache.get(text);
            if (cached) {
                audioBuffer = await Promise.resolve(cached);
                this._speechCache.delete(text);
            }
            if (!audioBuffer) {
                audioBuffer = await ttsEngine.synthesize(text);
            }
            if (this._isStopped) return;
            await ttsEngine.playBuffer(audioBuffer, this._playbackSpeed);
        } catch (error) {
            console.error('TTS speak error:', error);
        }
    }

    /**
     * Pre-fetch TTS for a text string into the speech cache so _speakText
     * can retrieve a ready buffer without a synthesis gap.
     */
    _prefetchSpeech(text) {
        if (!text || !text.trim() || this._isStopped) return;
        if (this._speechCache.has(text)) return;

        const promise = ttsEngine.synthesize(text)
            .then(buf => {
                this._speechCache.set(text, buf);
                return buf;
            })
            .catch(err => {
                console.error('TTS prefetch error:', err);
                this._speechCache.delete(text);
                return null;
            });

        this._speechCache.set(text, promise);
    }

    /**
     * Pre-fetch audio for a sentence
     */
    async _prefetchAudio(index, text) {
        if (!text || !text.trim() || this._isStopped) return;
        if (this._audioBufferCache.has(index)) return;

        const promise = ttsEngine.synthesize(text)
            .then(buf => {
                if (!this._isStopped) this._audioBufferCache.set(index, buf);
                return buf;
            })
            .catch(err => {
                console.error(`Pre-fetch error for sentence ${index}:`, err);
                return null;
            });

        this._audioBufferCache.set(index, promise);
    }

    /**
     * Start speaking feedback sentences (streaming pattern)
     */
    async _startFeedbackSpeaking() {
        this._speakingDonePromise = new Promise(resolve => {
            this._speakingDoneResolve = resolve;
        });

        while (!this._isStopped) {
            if (this._currentSentenceIndex < this._feedbackSentences.length) {
                const sentence = this._feedbackSentences[this._currentSentenceIndex];
                try {
                    let audioBuffer;
                    const cached = this._audioBufferCache.get(this._currentSentenceIndex);
                    if (cached) {
                        audioBuffer = await Promise.resolve(cached);
                    }
                    if (!audioBuffer) {
                        audioBuffer = await ttsEngine.synthesize(sentence);
                    }
                    if (this._isStopped) break;
                    this._audioBufferCache.delete(this._currentSentenceIndex);
                    await ttsEngine.playBuffer(audioBuffer, this._playbackSpeed);
                    this._currentSentenceIndex++;
                } catch (error) {
                    if (this._isStopped) break;
                    console.error('Feedback TTS error:', error);
                    this._currentSentenceIndex++;
                }
            } else if (this._isStreamingComplete) {
                break;
            } else {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }

        this._speakingDoneResolve?.();
    }

    /**
     * Wait for feedback speaking to complete
     */
    async _waitForSpeakingDone() {
        if (this._speakingDonePromise) {
            await this._speakingDonePromise;
        }
    }

    // ========== Internal: Persistence ==========

    async _persistQuestion(question) {
        try {
            const book = this._readingState?.getCurrentBook();
            const position = this._readingState?.getCurrentPosition();
            if (!book || !position) return;

            await storage.saveQuizQuestion(book.id, position.chapterIndex, {
                ...question,
                timestamp: Date.now(),
                isMultipleChoice: this._isMultipleChoice
            });
        } catch (error) {
            console.error('Failed to persist quiz question:', error);
        }
    }

    // ========== Internal: State ==========

    _setState(newState) {
        const oldState = this._state;
        this._state = newState;

        if (oldState !== newState) {
            this._onStateChange?.(newState, {
                question: this._currentQuestion,
                disabledOptions: this._disabledOptions
            });
        }
    }

    /**
     * Check if STT is supported
     * @returns {boolean}
     */
    isSTTSupported() {
        return this._sttService.isSupported();
    }
}
