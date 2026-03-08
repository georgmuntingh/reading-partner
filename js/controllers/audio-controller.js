/**
 * Audio Controller
 * Manages TTS playback with pre-buffering
 */

import { ttsEngine } from '../services/tts-engine.js';
import { appLogger } from '../services/app-logger.js';

/**
 * @typedef {Object} PlaybackState
 * @property {'stopped'|'playing'|'paused'|'buffering'} status
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

        // Buffer management - reduced for faster startup
        this._bufferQueue = new Map(); // index -> AudioBuffer
        this._prefetchAhead = 2; // Reduced from 3
        this._bufferBehind = 2;

        // Current playback
        this._currentSource = null;
        this._isPlaying = false;
        this._stopRequested = false;

        // Generation tracking
        this._generatingIndices = new Set();

        // Debounce timer for play-after-skip
        this._skipPlayTimer = null;
    }

    /**
     * Initialize the audio controller
     * @returns {Promise<void>}
     */
    async initialize() {
        await ttsEngine.initialize();
    }

    /**
     * Set sentences to play and pre-buffer the first one
     * @param {string[]} sentences
     * @param {number} [startIndex=0]
     */
    setSentences(sentences, startIndex = 0) {
        this._sentences = sentences;
        this._currentIndex = startIndex;
        this._clearBuffers();

        // Pre-buffer the first sentence in the background
        if (sentences.length > 0) {
            console.log('Pre-buffering first sentence...');
            this._generateBuffer(startIndex).then(() => {
                console.log('First sentence pre-buffered');
            }).catch(err => {
                console.warn('Pre-buffer failed:', err);
            });
        }
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
            this._onChapterEnd?.();
            return;
        }

        this._stopRequested = false;
        this._status = 'playing';
        this._notifyStateChange();

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
                // Show buffering state
                this._status = 'buffering';
                this._notifyStateChange();

                if (appLogger.enabled) appLogger.info(`Buffering sentence ${this._currentIndex} (queue: ${this._bufferQueue.size} buffers, generating: ${this._generatingIndices.size})`);
                console.time(`TTS generate sentence ${this._currentIndex}`);
                try {
                    buffer = await this._generateBuffer(this._currentIndex);
                } catch (error) {
                    console.error('Failed to generate audio:', error);
                    appLogger.error(`Failed to generate sentence ${this._currentIndex}: ${error.message}`);
                    this._currentIndex++;
                    continue;
                }
                console.timeEnd(`TTS generate sentence ${this._currentIndex}`);

                this._status = 'playing';
                this._notifyStateChange();
            }

            if (this._stopRequested) break;

            // Notify UI of current sentence
            this._onSentenceChange?.(this._currentIndex);

            if (appLogger.enabled) {
                const queueEstKB = this._estimateQueueMemory();
                appLogger.info(
                    `Playing sentence ${this._currentIndex}/${this._sentences.length - 1}, ` +
                    `duration=${buffer.duration ? buffer.duration.toFixed(1) : '?'}s, ` +
                    `queue: ${this._bufferQueue.size} buffers (~${queueEstKB} KB)`
                );
            }

            // Start buffering next sentences in background (don't await)
            this._maintainBuffer();

            // Play the buffer
            try {
                await ttsEngine.playBuffer(buffer, this._speed);
            } catch (error) {
                console.error('Playback error:', error);
                appLogger.error(`Playback error at sentence ${this._currentIndex}: ${error.message}`);
            }

            if (this._stopRequested) break;

            // Move to next sentence
            this._currentIndex++;
        }

        this._isPlaying = false;

        if (!this._stopRequested && this._currentIndex >= this._sentences.length) {
            this._status = 'stopped';
            this._notifyStateChange();
            this._onChapterEnd?.();
        }
    }

    /**
     * Pause playback
     */
    pause() {
        if (this._skipPlayTimer) {
            clearTimeout(this._skipPlayTimer);
            this._skipPlayTimer = null;
        }
        this._stopRequested = true;
        this._status = 'paused';
        ttsEngine.stopAudio();
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
        if (this._skipPlayTimer) {
            clearTimeout(this._skipPlayTimer);
            this._skipPlayTimer = null;
        }
        this._stopRequested = true;
        this._status = 'stopped';
        this._currentIndex = 0;
        ttsEngine.stopAudio();
        this._notifyStateChange();
    }

    /**
     * Skip to next sentence
     */
    skipForward() {
        const wasPlaying = this._status === 'playing' || this._skipPlayTimer !== null;

        if (this._skipPlayTimer) {
            clearTimeout(this._skipPlayTimer);
            this._skipPlayTimer = null;
        }

        this._stopRequested = true;
        ttsEngine.stopAudio();

        if (this._currentIndex < this._sentences.length - 1) {
            this._currentIndex++;
            this._onSentenceChange?.(this._currentIndex);

            if (wasPlaying) {
                this._status = 'paused';
                this._notifyStateChange();
                this._skipPlayTimer = setTimeout(() => {
                    this._skipPlayTimer = null;
                    this.play();
                }, 2000);
            }
        }
    }

    /**
     * Skip backward by N sentences
     * @param {number} [count=1]
     */
    skipBackward(count = 1) {
        const wasPlaying = this._status === 'playing' || this._skipPlayTimer !== null;

        if (this._skipPlayTimer) {
            clearTimeout(this._skipPlayTimer);
            this._skipPlayTimer = null;
        }

        this._stopRequested = true;
        ttsEngine.stopAudio();

        this._currentIndex = Math.max(0, this._currentIndex - count);
        this._onSentenceChange?.(this._currentIndex);

        if (wasPlaying) {
            this._status = 'paused';
            this._notifyStateChange();
            this._skipPlayTimer = setTimeout(() => {
                this._skipPlayTimer = null;
                this.play();
            }, 2000);
        }
    }

    /**
     * Jump to specific sentence
     * @param {number} index
     */
    goToSentence(index) {
        const wasPlaying = this._status === 'playing';
        this._stopRequested = true;
        ttsEngine.stopAudio();

        this._currentIndex = Math.max(0, Math.min(index, this._sentences.length - 1));
        this._onSentenceChange?.(this._currentIndex);

        if (wasPlaying) {
            setTimeout(() => this.play(), 50);
        }
    }

    /**
     * Set the number of sentences to prefetch ahead
     * @param {number} count - Number of sentences to buffer ahead (1-10)
     */
    setPrefetchCount(count) {
        this._prefetchAhead = Math.max(1, Math.min(10, count));
        console.log(`Prefetch ahead set to ${this._prefetchAhead}`);
    }

    /**
     * Get the current prefetch count
     * @returns {number}
     */
    getPrefetchCount() {
        return this._prefetchAhead;
    }

    /**
     * Set playback speed
     * @param {number} speed - 0.5 to 2.0
     */
    setSpeed(speed) {
        const newSpeed = Math.max(0.5, Math.min(2.0, speed));
        if (newSpeed !== this._speed) {
            this._speed = newSpeed;
            // Update TTS engine speed for future generations
            ttsEngine.setSpeed(newSpeed);
            // Clear buffers so they'll be regenerated at new speed
            this._clearBuffers();
        }
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
     * Check if first buffer is ready
     * @returns {boolean}
     */
    isFirstBufferReady() {
        return this._bufferQueue.has(this._currentIndex);
    }

    /**
     * Maintain buffer for upcoming sentences (non-blocking)
     */
    _maintainBuffer() {
        const end = Math.min(
            this._sentences.length,
            this._currentIndex + this._prefetchAhead + 1
        );

        // Generate missing buffers in background
        for (let i = this._currentIndex + 1; i < end; i++) {
            if (!this._bufferQueue.has(i) && !this._generatingIndices.has(i)) {
                this._generateBuffer(i).catch(err => {
                    console.warn(`Buffer generation error for sentence ${i}:`, err);
                });
            }
        }

        // Clean old buffers
        const start = Math.max(0, this._currentIndex - this._bufferBehind);
        let cleaned = 0;
        for (const idx of this._bufferQueue.keys()) {
            if (idx < start) {
                this._bufferQueue.delete(idx);
                cleaned++;
            }
        }
        if (cleaned > 0 && appLogger.enabled) {
            appLogger.info(`Evicted ${cleaned} old buffer(s), queue now: ${this._bufferQueue.size} (~${this._estimateQueueMemory()} KB)`);
        }
    }

    /**
     * Generate audio buffer for a sentence
     * @param {number} index
     * @returns {Promise<AudioBuffer>}
     */
    async _generateBuffer(index) {
        if (this._bufferQueue.has(index)) {
            return this._bufferQueue.get(index);
        }

        if (this._generatingIndices.has(index)) {
            // Already generating, wait for it
            return new Promise((resolve, reject) => {
                const checkBuffer = setInterval(() => {
                    if (this._bufferQueue.has(index)) {
                        clearInterval(checkBuffer);
                        resolve(this._bufferQueue.get(index));
                    }
                }, 50);

                // Timeout after 30 seconds
                setTimeout(() => {
                    clearInterval(checkBuffer);
                    reject(new Error('Buffer generation timeout'));
                }, 30000);
            });
        }

        this._generatingIndices.add(index);

        try {
            const sentence = this._sentences[index];
            console.log(`Generating TTS for sentence ${index}: "${sentence.slice(0, 50)}..."`);

            const genStart = performance.now();
            const buffer = await ttsEngine.synthesize(sentence);
            const genTime = Math.round(performance.now() - genStart);
            this._bufferQueue.set(index, buffer);

            if (appLogger.enabled) {
                const bufferKB = buffer.length ? Math.round((buffer.length * 4) / 1024) : 0;
                appLogger.info(
                    `Buffer ready: sentence ${index}, ${sentence.length} chars, ` +
                    `${genTime}ms gen, ${bufferKB} KB, ` +
                    `queue total: ${this._bufferQueue.size} buffers (~${this._estimateQueueMemory()} KB)`
                );
            }
            console.log(`TTS ready for sentence ${index}`);
            return buffer;
        } finally {
            this._generatingIndices.delete(index);
        }
    }

    /**
     * Estimate total memory held by the buffer queue (KB).
     * AudioBuffers store Float32 samples (4 bytes each).
     */
    _estimateQueueMemory() {
        let totalSamples = 0;
        for (const buf of this._bufferQueue.values()) {
            if (buf && buf.length) totalSamples += buf.length;
        }
        return Math.round((totalSamples * 4) / 1024);
    }

    /**
     * Clear all buffers (public, for backend switches)
     */
    clearBuffers() {
        this._clearBuffers();
    }

    /**
     * Clear all buffers
     */
    _clearBuffers() {
        if (this._bufferQueue.size > 0 && appLogger.enabled) {
            appLogger.info(`Clearing ${this._bufferQueue.size} buffers (~${this._estimateQueueMemory()} KB)`);
        }
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
        if (this._skipPlayTimer) {
            clearTimeout(this._skipPlayTimer);
            this._skipPlayTimer = null;
        }
        this.stop();
        this._clearBuffers();
    }
}
