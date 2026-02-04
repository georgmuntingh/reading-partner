/**
 * Speech-to-Text Service
 * Uses Web Speech API with text input fallback
 */

export class STTService {
    constructor() {
        this._recognition = null;
        this._isSupported = false;
        this._isListening = false;
        this._silenceTimer = null;
        this._silenceTimeout = 3000; // ms of silence before stopping

        // Callbacks
        this.onInterimResult = null;
        this.onError = null;
        this.onStart = null;
        this.onEnd = null;

        this._initRecognition();
    }

    /**
     * Initialize the Web Speech API
     */
    _initRecognition() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

        if (!SpeechRecognition) {
            console.warn('Web Speech API not supported');
            this._isSupported = false;
            return;
        }

        this._isSupported = true;
        this._recognition = new SpeechRecognition();
        this._recognition.continuous = true;
        this._recognition.interimResults = true;
        this._recognition.lang = 'en-US';
        this._recognition.maxAlternatives = 1;
    }

    /**
     * Check if STT is supported
     * @returns {boolean}
     */
    isSupported() {
        return this._isSupported;
    }

    /**
     * Check if currently listening
     * @returns {boolean}
     */
    isListening() {
        return this._isListening;
    }

    /**
     * Set the silence timeout duration
     * @param {number} ms - Milliseconds of silence before stopping
     */
    setSilenceTimeout(ms) {
        this._silenceTimeout = ms;
    }

    /**
     * Start listening for speech
     * @returns {Promise<string>} Transcribed text
     */
    startListening() {
        return new Promise((resolve, reject) => {
            if (!this._isSupported) {
                reject(new Error('Speech recognition not supported'));
                return;
            }

            if (this._isListening) {
                reject(new Error('Already listening'));
                return;
            }

            this._isListening = true;
            let finalTranscript = '';
            let hasResult = false;

            const resetSilenceTimer = () => {
                clearTimeout(this._silenceTimer);
                this._silenceTimer = setTimeout(() => {
                    // Silence threshold reached, stop gracefully
                    if (this._isListening) {
                        this._recognition.stop();
                    }
                }, this._silenceTimeout);
            };

            this._recognition.onstart = () => {
                console.log('STT: Started listening');
                this.onStart?.();
                // Start silence timer — if no speech at all, stop after timeout
                resetSilenceTimer();
            };

            this._recognition.onresult = (event) => {
                // Rebuild transcripts from all results each time rather than
                // incrementally appending. On mobile Chrome (Android), the
                // results array and event.resultIndex behave differently than
                // on desktop: partial results may accumulate as separate entries
                // or be finalized with overlapping text, causing concatenation
                // artifacts like "whatwhat iswhat is the..." when using +=.
                let currentFinal = '';
                let currentInterim = '';

                for (let i = 0; i < event.results.length; i++) {
                    const result = event.results[i];
                    if (result.isFinal) {
                        currentFinal += result[0].transcript;
                    } else {
                        currentInterim += result[0].transcript;
                    }
                }

                finalTranscript = currentFinal;
                if (currentFinal) {
                    hasResult = true;
                }

                // Reset silence timer on any speech activity
                resetSilenceTimer();

                // Report current transcript for live display.
                // Include final results too, not just interim — on mobile
                // Chrome, results may be finalized progressively without
                // interim phases, so only checking interim would miss updates.
                const displayTranscript = currentFinal + currentInterim;
                if (displayTranscript) {
                    this.onInterimResult?.(displayTranscript);
                }
            };

            this._recognition.onerror = (event) => {
                console.error('STT Error:', event.error);
                clearTimeout(this._silenceTimer);

                // With continuous mode, no-speech is not fatal — just ignore it
                if (event.error === 'no-speech') {
                    return;
                }

                this._isListening = false;

                let errorMessage = 'Speech recognition error';
                switch (event.error) {
                    case 'not-allowed':
                    case 'permission-denied':
                        errorMessage = 'Microphone permission denied';
                        break;
                    case 'audio-capture':
                        errorMessage = 'No microphone found';
                        break;
                    case 'network':
                        errorMessage = 'Network error occurred';
                        break;
                    case 'aborted':
                        errorMessage = 'Speech recognition aborted';
                        break;
                }

                this.onError?.(event.error, errorMessage);
                reject(new Error(errorMessage));
            };

            this._recognition.onend = () => {
                console.log('STT: Stopped listening');
                clearTimeout(this._silenceTimer);
                this._isListening = false;
                this.onEnd?.();

                if (hasResult && finalTranscript.trim()) {
                    resolve(finalTranscript.trim());
                } else if (!hasResult) {
                    reject(new Error('No speech detected'));
                }
            };

            try {
                this._recognition.start();
            } catch (error) {
                clearTimeout(this._silenceTimer);
                this._isListening = false;
                reject(error);
            }
        });
    }

    /**
     * Stop listening
     */
    stopListening() {
        clearTimeout(this._silenceTimer);
        if (this._recognition && this._isListening) {
            this._recognition.stop();
        }
    }

    /**
     * Abort listening (discard results)
     */
    abortListening() {
        clearTimeout(this._silenceTimer);
        if (this._recognition && this._isListening) {
            this._recognition.abort();
        }
    }

    /**
     * Set the recognition language
     * @param {string} lang - Language code (e.g., 'en-US', 'es-ES')
     */
    setLanguage(lang) {
        if (this._recognition) {
            this._recognition.lang = lang;
        }
    }

    /**
     * Request microphone permission
     * @returns {Promise<boolean>} Whether permission was granted
     */
    async requestPermission() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            // Stop the stream immediately - we just needed to request permission
            stream.getTracks().forEach(track => track.stop());
            return true;
        } catch (error) {
            console.error('Microphone permission denied:', error);
            return false;
        }
    }
}

// Export singleton instance
export const sttService = new STTService();
