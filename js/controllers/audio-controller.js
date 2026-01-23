/**
 * Audio Controller
 * Manages TTS playback with pre-buffering
 */

import { ttsEngine } from '../services/tts-engine.js';

/**
 * @typedef {Object} PlaybackState
 * @property {'stopped'|'playing'|'paused'} status
 * @property {number} currentIndex
 */

export class AudioController {
    /**
     * @param {Object} options
     * @param {(index: number) => void} options.onSentenceChange
     * @param {(state: PlaybackState) => void} options.onStateChange
     * @param {() => void} options.onChapterEnd
     */
    constructor({ onSentenceChange, onStateChange, onChapterEnd }) {
        this._onSentenceChange = onSentenceChange;
        this._onStateChange = onStateChange;
        this._onChapterEnd = onChapterEnd;

        this._sentences = [];
        this._currentIndex = 0;
        this._status = 'stopped';
        this._speed = 1.0;

        // Buffer management
        this._bufferQueue = new Map(); // index -> AudioBuffer
        this._prefetchAhead = 3;
        this._bufferBehind = 2; // Keep for rewind support

        // Current playback
        this._currentSource = null;
        this._isPlaying = false;
        this._stopRequested = false;

        // Generation tracking
        this._generatingIndices = new Set();
    }

    /**
     * Initialize the audio controller
     * @returns {Promise<void>}
     */
    async initialize() {
        await ttsEngine.initialize();
    }

    /**
     * Set sentences to play
     * @param {string[]} sentences
     * @param {number} [startIndex=0]
     */
    setSentences(sentences, startIndex = 0) {
        this._sentences = sentences;
        this._currentIndex = startIndex;
        this._clearBuffers();
    }

    /**
     * Start or resume playback
     * @param {number} [fromIndex] - Optional index to start from
     */
    async play(fromIndex) {
        if (fromIndex !== undefined) {
            this._currentIndex = fromIndex;
        }

        if (this._sentences.length === 0) {
            console.warn('No sentences to play');
            return;
        }

        if (this._currentIndex >= this._sentences.length) {
            // End of chapter
            this._onChapterEnd?.();
            return;
        }

        this._stopRequested = false;
        this._status = 'playing';
        this._notifyStateChange();

        // Start pre-buffering
        this._maintainBuffer();

        // Begin playback loop
        await this._playbackLoop();
    }

    /**
     * Main playback loop
     */
    async _playbackLoop() {
        while (!this._stopRequested && this._currentIndex < this._sentences.length) {
            this._isPlaying = true;

            // Get or wait for buffer
            let buffer = this._bufferQueue.get(this._currentIndex);

            if (!buffer) {
                // Need to generate on-demand
                try {
                    buffer = await this._generateBuffer(this._currentIndex);
                } catch (error) {
                    console.error('Failed to generate audio:', error);
                    // Skip to next sentence
                    this._currentIndex++;
                    continue;
                }
            }

            if (this._stopRequested) break;

            // Notify UI of current sentence
            this._onSentenceChange?.(this._currentIndex);

            // Play the buffer
            try {
                await ttsEngine.playBuffer(buffer, this._speed);
            } catch (error) {
                console.error('Playback error:', error);
            }

            if (this._stopRequested) break;

            // Move to next sentence
            this._currentIndex++;

            // Maintain buffer for upcoming sentences
            this._maintainBuffer();
        }

        this._isPlaying = false;

        if (!this._stopRequested && this._currentIndex >= this._sentences.length) {
            // Reached end of chapter
            this._status = 'stopped';
            this._notifyStateChange();
            this._onChapterEnd?.();
        }
    }

    /**
     * Pause playback
     */
    pause() {
        this._stopRequested = true;
        this._status = 'paused';
        ttsEngine.stopWebSpeech(); // Stop any Web Speech playback
        this._notifyStateChange();
    }

    /**
     * Resume playback
     */
    resume() {
        if (this._status === 'paused') {
            this.play();
        }
    }

    /**
     * Stop playback completely
     */
    stop() {
        this._stopRequested = true;
        this._status = 'stopped';
        this._currentIndex = 0;
        ttsEngine.stopWebSpeech();
        this._notifyStateChange();
    }

    /**
     * Skip to next sentence
     */
    skipForward() {
        const wasPlaying = this._status === 'playing';
        this._stopRequested = true;
        ttsEngine.stopWebSpeech();

        if (this._currentIndex < this._sentences.length - 1) {
            this._currentIndex++;
            this._onSentenceChange?.(this._currentIndex);

            if (wasPlaying) {
                // Small delay to allow current playback to stop
                setTimeout(() => this.play(), 50);
            }
        }
    }

    /**
     * Skip backward by N sentences
     * @param {number} [count=1]
     */
    skipBackward(count = 1) {
        const wasPlaying = this._status === 'playing';
        this._stopRequested = true;
        ttsEngine.stopWebSpeech();

        this._currentIndex = Math.max(0, this._currentIndex - count);
        this._onSentenceChange?.(this._currentIndex);

        if (wasPlaying) {
            setTimeout(() => this.play(), 50);
        }
    }

    /**
     * Jump to specific sentence
     * @param {number} index
     */
    goToSentence(index) {
        const wasPlaying = this._status === 'playing';
        this._stopRequested = true;
        ttsEngine.stopWebSpeech();

        this._currentIndex = Math.max(0, Math.min(index, this._sentences.length - 1));
        this._onSentenceChange?.(this._currentIndex);
        this._maintainBuffer();

        if (wasPlaying) {
            setTimeout(() => this.play(), 50);
        }
    }

    /**
     * Set playback speed
     * @param {number} speed - 0.5 to 2.0
     */
    setSpeed(speed) {
        this._speed = Math.max(0.5, Math.min(2.0, speed));
    }

    /**
     * Get current playback state
     * @returns {PlaybackState}
     */
    getState() {
        return {
            status: this._status,
            currentIndex: this._currentIndex
        };
    }

    /**
     * Get current sentence index
     * @returns {number}
     */
    getCurrentIndex() {
        return this._currentIndex;
    }

    /**
     * Maintain buffer for upcoming sentences
     */
    async _maintainBuffer() {
        // Determine range to buffer
        const start = Math.max(0, this._currentIndex - this._bufferBehind);
        const end = Math.min(
            this._sentences.length,
            this._currentIndex + this._prefetchAhead + 1
        );

        // Remove buffers outside range
        for (const idx of this._bufferQueue.keys()) {
            if (idx < start || idx >= end) {
                this._bufferQueue.delete(idx);
            }
        }

        // Generate missing buffers
        const generatePromises = [];

        for (let i = this._currentIndex; i < end; i++) {
            if (!this._bufferQueue.has(i) && !this._generatingIndices.has(i)) {
                generatePromises.push(this._generateBuffer(i));
            }
        }

        // Don't await - let them generate in background
        Promise.all(generatePromises).catch(err => {
            console.warn('Buffer generation error:', err);
        });
    }

    /**
     * Generate audio buffer for a sentence
     * @param {number} index
     * @returns {Promise<AudioBuffer>}
     */
    async _generateBuffer(index) {
        if (this._generatingIndices.has(index)) {
            // Already generating, wait for it
            return new Promise((resolve) => {
                const checkBuffer = setInterval(() => {
                    if (this._bufferQueue.has(index)) {
                        clearInterval(checkBuffer);
                        resolve(this._bufferQueue.get(index));
                    }
                }, 50);
            });
        }

        this._generatingIndices.add(index);

        try {
            const sentence = this._sentences[index];
            const buffer = await ttsEngine.synthesize(sentence);
            this._bufferQueue.set(index, buffer);
            return buffer;
        } finally {
            this._generatingIndices.delete(index);
        }
    }

    /**
     * Clear all buffers
     */
    _clearBuffers() {
        this._bufferQueue.clear();
        this._generatingIndices.clear();
    }

    /**
     * Notify state change
     */
    _notifyStateChange() {
        this._onStateChange?.({
            status: this._status,
            currentIndex: this._currentIndex
        });
    }

    /**
     * Cleanup
     */
    destroy() {
        this.stop();
        this._clearBuffers();
    }
}
