/**
 * Q&A Controller
 * Orchestrates the STT -> LLM -> TTS flow for Q&A mode
 */

import { sttService } from '../services/stt-service.js';
import { llmClient } from '../services/llm-client.js';
import { ttsEngine } from '../services/tts-engine.js';
import { splitIntoSentences } from '../utils/sentence-splitter.js';

// Q&A States
export const QAState = {
    IDLE: 'idle',
    LISTENING: 'listening',
    THINKING: 'thinking',
    RESPONDING: 'responding',
    PAUSED: 'paused'
};

/**
 * @typedef {Object} QAHistoryEntry
 * @property {string} id - Unique ID
 * @property {string} question - User's question
 * @property {string} answer - LLM's answer
 * @property {number} timestamp - When the Q&A occurred
 */

export class QAController {
    /**
     * @param {Object} options
     * @param {Object} options.readingState - ReadingStateController instance
     * @param {(state: string, data?: any) => void} options.onStateChange - State change callback
     * @param {(text: string) => void} options.onTranscript - Live transcript callback
     * @param {(text: string) => void} options.onResponse - Response text callback
     * @param {(sentence: string, index: number) => void} options.onSentenceSpoken - When a sentence finishes
     * @param {(entry: QAHistoryEntry) => void} options.onHistoryAdd - When a Q&A is added to history
     */
    constructor(options) {
        this._readingState = options.readingState;
        this._onStateChange = options.onStateChange;
        this._onTranscript = options.onTranscript;
        this._onResponse = options.onResponse;
        this._onSentenceSpoken = options.onSentenceSpoken;
        this._onHistoryAdd = options.onHistoryAdd;

        // State
        this._state = QAState.IDLE;
        this._currentQuestion = '';
        this._currentResponse = '';
        this._responseSentences = [];
        this._currentSentenceIndex = 0;
        this._isPaused = false;
        this._isStopped = false;
        this._isStreamingComplete = false;

        // TTS state
        this._playbackSpeed = 1.0;

        // Audio buffer cache for pre-synthesizing sentences
        // Maps sentence index -> AudioBuffer
        this._audioBufferCache = new Map();
        this._nextSynthesisIndex = 0;

        // Session history
        this._history = [];

        // Book metadata for LLM context
        this._bookMeta = null;

        // Context settings (sentences before and after current position)
        this._contextBefore = 20;
        this._contextAfter = 5;
        this._useFullChapter = false;

        // Setup STT callbacks
        sttService.onInterimResult = (text) => {
            this._onTranscript?.(text);
        };
    }

    /**
     * Get current state
     * @returns {string}
     */
    getState() {
        return this._state;
    }

    /**
     * Check if Q&A mode is active
     * @returns {boolean}
     */
    isActive() {
        return this._state !== QAState.IDLE;
    }

    /**
     * Get session Q&A history
     * @returns {QAHistoryEntry[]}
     */
    getHistory() {
        return [...this._history];
    }

    /**
     * Clear session history
     */
    clearHistory() {
        this._history = [];
    }

    /**
     * Set book metadata for LLM context
     * @param {{ title?: string, author?: string }} bookMeta
     */
    setBookMeta(bookMeta) {
        this._bookMeta = bookMeta;
    }

    /**
     * Set context settings
     * @param {number} before - Sentences before current position
     * @param {number} after - Sentences after current position
     * @param {boolean} [useFullChapter=false] - Send all chapter sentences
     */
    setContextSettings(before, after, useFullChapter = false) {
        this._contextBefore = before;
        this._contextAfter = after;
        this._useFullChapter = useFullChapter;
    }

    /**
     * Set playback speed for TTS
     * @param {number} speed
     */
    setPlaybackSpeed(speed) {
        this._playbackSpeed = speed;
    }

    /**
     * Start Q&A mode with voice input
     * @returns {Promise<void>}
     */
    async startVoiceQA() {
        if (this._state !== QAState.IDLE && this._state !== QAState.PAUSED) {
            console.warn('Q&A already in progress');
            return;
        }

        this._isStopped = false;
        this._isPaused = false;
        this._setState(QAState.LISTENING);

        try {
            // Start listening
            const question = await sttService.startListening();
            this._currentQuestion = question;
            this._onTranscript?.(question);

            // Process the question
            await this._processQuestion(question);
        } catch (error) {
            console.error('Voice Q&A error:', error);
            if (error.message !== 'Speech recognition aborted') {
                this._onStateChange?.(QAState.IDLE, { error: error.message });
            }
            this._setState(QAState.IDLE);
        }
    }

    /**
     * Start Q&A mode with text input
     * @param {string} question
     * @returns {Promise<void>}
     */
    async startTextQA(question) {
        if (this._state !== QAState.IDLE && this._state !== QAState.PAUSED) {
            console.warn('Q&A already in progress');
            return;
        }

        if (!question || !question.trim()) {
            return;
        }

        this._isStopped = false;
        this._isPaused = false;
        this._currentQuestion = question.trim();

        await this._processQuestion(this._currentQuestion);
    }

    /**
     * Process a question through LLM and TTS
     * @param {string} question
     */
    async _processQuestion(question) {
        this._setState(QAState.THINKING);
        this._currentResponse = '';
        this._responseSentences = [];
        this._currentSentenceIndex = 0;
        this._isStreamingComplete = false;

        // Clear audio buffer cache
        this._audioBufferCache.clear();
        this._nextSynthesisIndex = 0;

        try {
            // Get context sentences
            const context = await this._getContextSentences();

            // Stream the LLM response
            const fullResponse = await llmClient.askQuestionStreaming(
                context,
                question,
                // On each chunk
                (chunk) => {
                    this._currentResponse += chunk;
                    this._onResponse?.(this._currentResponse);
                },
                // On each complete sentence
                (sentence) => {
                    if (this._isStopped) return;

                    const sentenceIndex = this._responseSentences.length;
                    this._responseSentences.push(sentence);

                    // Start pre-synthesizing this sentence immediately
                    this._prefetchSentenceAudio(sentenceIndex, sentence);

                    // If this is the first sentence and we're still thinking, start responding
                    if (this._state === QAState.THINKING && this._responseSentences.length === 1) {
                        this._setState(QAState.RESPONDING);
                        this._startSpeaking();
                    }
                },
                this._bookMeta
            );

            // Mark streaming as complete
            this._isStreamingComplete = true;

            // Add to history
            const historyEntry = {
                id: `qa_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                question,
                answer: fullResponse,
                timestamp: Date.now()
            };
            this._history.push(historyEntry);
            this._onHistoryAdd?.(historyEntry);

        } catch (error) {
            console.error('Q&A processing error:', error);
            this._isStreamingComplete = true;
            if (!this._isStopped) {
                this._onStateChange?.(QAState.IDLE, { error: error.message });
                this._setState(QAState.IDLE);
            }
        }
    }

    /**
     * Get context sentences (before and after current position, or full chapter)
     * @returns {Promise<string[]>}
     */
    async _getContextSentences() {
        if (!this._readingState) {
            return [];
        }

        if (this._useFullChapter) {
            const position = this._readingState.getCurrentPosition();
            return await this._readingState.loadChapter(position.chapterIndex);
        }

        const beforeSentences = await this._readingState.getContextSentences(this._contextBefore);
        const afterSentences = await this._readingState.getContextSentencesAfter(this._contextAfter);

        return [...beforeSentences, ...afterSentences];
    }

    /**
     * Start speaking the response sentences
     */
    async _startSpeaking() {
        // Keep looping while not stopped
        while (!this._isStopped) {
            // Check if paused
            if (this._isPaused) {
                // Wait for unpause
                await new Promise(resolve => {
                    this._resumeCallback = resolve;
                });
                continue;
            }

            // Check if there's a sentence to speak
            if (this._currentSentenceIndex < this._responseSentences.length) {
                const sentence = this._responseSentences[this._currentSentenceIndex];

                try {
                    await this._speakSentence(sentence);
                    this._onSentenceSpoken?.(sentence, this._currentSentenceIndex);
                    this._currentSentenceIndex++;
                } catch (error) {
                    if (this._isStopped || this._isPaused) {
                        break;
                    }
                    console.error('TTS error:', error);
                    this._currentSentenceIndex++;
                }
            } else if (this._isStreamingComplete) {
                // No more sentences and streaming is done - we're finished
                break;
            } else {
                // Wait for more sentences from the LLM stream
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }

        // Set to idle if we finished normally (not stopped or paused)
        if (!this._isStopped && !this._isPaused) {
            this._setState(QAState.IDLE);
        }
    }

    /**
     * Pre-fetch (synthesize) audio for a sentence in the background
     * @param {number} index - Sentence index
     * @param {string} text - Sentence text
     */
    async _prefetchSentenceAudio(index, text) {
        if (!text || !text.trim() || this._isStopped) {
            return;
        }

        // Don't re-synthesize if already in cache or being synthesized
        if (this._audioBufferCache.has(index)) {
            return;
        }

        // Mark as being synthesized (store a Promise)
        const synthesisPromise = ttsEngine.synthesize(text)
            .then(audioBuffer => {
                if (!this._isStopped) {
                    this._audioBufferCache.set(index, audioBuffer);
                }
                return audioBuffer;
            })
            .catch(error => {
                console.error(`Pre-fetch synthesis error for sentence ${index}:`, error);
                return null;
            });

        // Store the promise so we can await it if needed
        this._audioBufferCache.set(index, synthesisPromise);
    }

    /**
     * Speak a single sentence (uses cached audio if available)
     * @param {string} text
     * @returns {Promise<void>}
     */
    async _speakSentence(text) {
        if (!text || !text.trim()) {
            return;
        }

        const index = this._currentSentenceIndex;
        let audioBuffer;

        // Check if audio is in cache (or being synthesized)
        const cached = this._audioBufferCache.get(index);
        if (cached) {
            // If it's a Promise, await it; if it's an AudioBuffer, use it directly
            audioBuffer = await Promise.resolve(cached);
        }

        // If not in cache or synthesis failed, synthesize now
        if (!audioBuffer) {
            audioBuffer = await ttsEngine.synthesize(text);
        }

        if (this._isStopped) {
            return;
        }

        // Clear this entry from cache after use to free memory
        this._audioBufferCache.delete(index);

        // Play audio - playBuffer returns a Promise that resolves when playback ends
        await ttsEngine.playBuffer(audioBuffer, this._playbackSpeed);
    }

    /**
     * Pause the Q&A response
     */
    pause() {
        if (this._state !== QAState.RESPONDING) {
            return;
        }

        this._isPaused = true;
        this._setState(QAState.PAUSED);

        // Stop current audio using TTS engine
        ttsEngine.stopAudio();
    }

    /**
     * Resume the Q&A response
     */
    resume() {
        if (this._state !== QAState.PAUSED) {
            return;
        }

        this._isPaused = false;
        this._setState(QAState.RESPONDING);

        // Resume speaking
        if (this._resumeCallback) {
            this._resumeCallback();
            this._resumeCallback = null;
        } else {
            this._startSpeaking();
        }
    }

    /**
     * Stop Q&A mode completely
     */
    stop() {
        this._isStopped = true;
        this._isPaused = false;

        // Cancel STT if listening
        if (this._state === QAState.LISTENING) {
            sttService.abortListening();
        }

        // Cancel LLM request
        llmClient.abort();

        // Stop current audio using TTS engine
        ttsEngine.stopAudio();

        // Clear state
        this._currentQuestion = '';
        this._currentResponse = '';
        this._responseSentences = [];
        this._currentSentenceIndex = 0;

        // Clear audio buffer cache
        this._audioBufferCache.clear();
        this._nextSynthesisIndex = 0;

        this._setState(QAState.IDLE);
    }

    /**
     * Cancel listening (during STT phase)
     */
    cancelListening() {
        if (this._state === QAState.LISTENING) {
            sttService.abortListening();
            this._setState(QAState.IDLE);
        }
    }

    /**
     * Ask another question (restart Q&A)
     */
    askAnother() {
        this.stop();
        // Small delay to ensure cleanup
        setTimeout(() => {
            this.startVoiceQA();
        }, 100);
    }

    /**
     * Get current question
     * @returns {string}
     */
    getCurrentQuestion() {
        return this._currentQuestion;
    }

    /**
     * Get current response
     * @returns {string}
     */
    getCurrentResponse() {
        return this._currentResponse;
    }

    /**
     * Check if STT is supported
     * @returns {boolean}
     */
    isSTTSupported() {
        return sttService.isSupported();
    }

    /**
     * Request microphone permission
     * @returns {Promise<boolean>}
     */
    async requestMicPermission() {
        return sttService.requestPermission();
    }

    /**
     * Set state and notify
     * @param {string} newState
     */
    _setState(newState) {
        const oldState = this._state;
        this._state = newState;

        if (oldState !== newState) {
            this._onStateChange?.(newState, {
                question: this._currentQuestion,
                response: this._currentResponse,
                sentenceIndex: this._currentSentenceIndex,
                totalSentences: this._responseSentences.length
            });
        }
    }
}
