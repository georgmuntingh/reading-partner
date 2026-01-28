/**
 * Playback Controls UI Component
 */

export class PlaybackControls {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.playBtn
     * @param {HTMLElement} options.pauseIcon
     * @param {HTMLElement} options.playIcon
     * @param {HTMLElement} options.prevBtn
     * @param {HTMLElement} options.nextBtn
     * @param {HTMLElement} options.prevChapterBtn
     * @param {HTMLElement} options.nextChapterBtn
     * @param {HTMLElement} options.askBtn
     * @param {HTMLInputElement} options.speedSlider
     * @param {HTMLElement} options.speedValue
     * @param {HTMLSelectElement} options.voiceSelect
     * @param {Object} callbacks
     * @param {() => void} callbacks.onPlay
     * @param {() => void} callbacks.onPause
     * @param {() => void} callbacks.onPrev
     * @param {() => void} callbacks.onNext
     * @param {() => void} callbacks.onPrevChapter
     * @param {() => void} callbacks.onNextChapter
     * @param {() => void} callbacks.onAsk
     * @param {(speed: number) => void} callbacks.onSpeedChange
     * @param {(voiceId: string) => void} callbacks.onVoiceChange
     */
    constructor(options, callbacks) {
        this._playBtn = options.playBtn;
        this._pauseIcon = options.pauseIcon;
        this._playIcon = options.playIcon;
        this._prevBtn = options.prevBtn;
        this._nextBtn = options.nextBtn;
        this._prevChapterBtn = options.prevChapterBtn;
        this._nextChapterBtn = options.nextChapterBtn;
        this._askBtn = options.askBtn;
        this._speedSlider = options.speedSlider;
        this._speedValue = options.speedValue;
        this._voiceSelect = options.voiceSelect;

        this._callbacks = callbacks;
        this._isPlaying = false;
        this._isEnabled = false;

        this._setupEventListeners();
    }

    /**
     * Setup event listeners
     */
    _setupEventListeners() {
        // Play/Pause button
        this._playBtn.addEventListener('click', () => {
            if (this._isPlaying) {
                this._callbacks.onPause?.();
            } else {
                this._callbacks.onPlay?.();
            }
        });

        // Navigation buttons
        this._prevBtn.addEventListener('click', () => {
            this._callbacks.onPrev?.();
        });

        this._nextBtn.addEventListener('click', () => {
            this._callbacks.onNext?.();
        });

        this._prevChapterBtn.addEventListener('click', () => {
            this._callbacks.onPrevChapter?.();
        });

        this._nextChapterBtn.addEventListener('click', () => {
            this._callbacks.onNextChapter?.();
        });

        // Ask button
        this._askBtn.addEventListener('click', () => {
            this._callbacks.onAsk?.();
        });

        // Speed slider
        this._speedSlider.addEventListener('input', () => {
            const speed = parseFloat(this._speedSlider.value);
            this._updateSpeedDisplay(speed);
            this._callbacks.onSpeedChange?.(speed);
        });

        // Voice selector
        this._voiceSelect.addEventListener('change', () => {
            const voiceId = this._voiceSelect.value;
            this._callbacks.onVoiceChange?.(voiceId);
        });
    }

    /**
     * Update speed display
     * @param {number} speed
     */
    _updateSpeedDisplay(speed) {
        this._speedValue.textContent = `${speed.toFixed(1)}x`;
    }

    /**
     * Set playing state
     * @param {boolean} isPlaying
     */
    setPlaying(isPlaying) {
        this._isPlaying = isPlaying;
        this._setBuffering(false); // Clear buffering state

        if (isPlaying) {
            this._playIcon.classList.add('hidden');
            this._pauseIcon.classList.remove('hidden');
        } else {
            this._playIcon.classList.remove('hidden');
            this._pauseIcon.classList.add('hidden');
        }
    }

    /**
     * Set buffering state (shows spinner)
     * @param {boolean} isBuffering
     */
    setBuffering(isBuffering) {
        this._setBuffering(isBuffering);
    }

    /**
     * Internal method to set buffering state
     * @param {boolean} isBuffering
     */
    _setBuffering(isBuffering) {
        if (isBuffering) {
            this._playBtn.classList.add('buffering');
            this._playIcon.classList.add('hidden');
            this._pauseIcon.classList.add('hidden');
        } else {
            this._playBtn.classList.remove('buffering');
        }
    }

    /**
     * Enable/disable all controls
     * @param {boolean} enabled
     */
    setEnabled(enabled) {
        this._isEnabled = enabled;

        this._playBtn.disabled = !enabled;
        this._prevBtn.disabled = !enabled;
        this._nextBtn.disabled = !enabled;
        this._prevChapterBtn.disabled = !enabled;
        this._nextChapterBtn.disabled = !enabled;
        this._askBtn.disabled = !enabled;
        this._speedSlider.disabled = !enabled;
    }

    /**
     * Set speed value
     * @param {number} speed
     */
    setSpeed(speed) {
        this._speedSlider.value = speed.toString();
        this._updateSpeedDisplay(speed);
    }

    /**
     * Get current speed
     * @returns {number}
     */
    getSpeed() {
        return parseFloat(this._speedSlider.value);
    }

    /**
     * Set available voices
     * @param {{ id: string, name: string }[]} voices
     */
    setVoices(voices) {
        const currentValue = this._voiceSelect.value;

        // Clear existing options
        this._voiceSelect.innerHTML = '';

        // Add new options
        voices.forEach(voice => {
            const option = document.createElement('option');
            option.value = voice.id;
            option.textContent = voice.name;
            this._voiceSelect.appendChild(option);
        });

        // Restore previous selection if it exists
        if (voices.some(v => v.id === currentValue)) {
            this._voiceSelect.value = currentValue;
        }
    }

    /**
     * Set voice
     * @param {string} voiceId
     */
    setVoice(voiceId) {
        this._voiceSelect.value = voiceId;
    }

    /**
     * Get current voice
     * @returns {string}
     */
    getVoice() {
        return this._voiceSelect.value;
    }

    /**
     * Temporarily disable Ask button (during Q&A mode)
     * @param {boolean} disabled
     * @param {string} [reason] - Optional reason for disabling (shown as tooltip)
     */
    setAskDisabled(disabled, reason) {
        this._askBtn.disabled = disabled;
        if (disabled && reason) {
            this._askBtn.title = reason;
        } else {
            this._askBtn.title = 'Ask a question';
        }
    }
}
