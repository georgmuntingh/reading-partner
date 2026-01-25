/**
 * Speech-to-Text Service
 * Uses Web Speech API with text input fallback
 */

export class STTService {
    constructor() {
        this._recognition = null;
        this._isSupported = false;
        this._isListening = false;

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
        this._recognition.continuous = false;
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

            this._recognition.onstart = () => {
                console.log('STT: Started listening');
                this.onStart?.();
            };

            this._recognition.onresult = (event) => {
                let interimTranscript = '';

                for (let i = event.resultIndex; i < event.results.length; i++) {
                    const result = event.results[i];
                    if (result.isFinal) {
                        finalTranscript += result[0].transcript;
                        hasResult = true;
                    } else {
                        interimTranscript += result[0].transcript;
                    }
                }

                // Report interim results for live display
                if (interimTranscript) {
                    this.onInterimResult?.(interimTranscript);
                }
            };

            this._recognition.onerror = (event) => {
                console.error('STT Error:', event.error);
                this._isListening = false;

                let errorMessage = 'Speech recognition error';
                switch (event.error) {
                    case 'not-allowed':
                    case 'permission-denied':
                        errorMessage = 'Microphone permission denied';
                        break;
                    case 'no-speech':
                        errorMessage = 'No speech detected';
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
                this._isListening = false;
                this.onEnd?.();

                if (hasResult && finalTranscript.trim()) {
                    resolve(finalTranscript.trim());
                } else if (!hasResult) {
                    // No final result received, this can happen on some errors
                    reject(new Error('No speech detected'));
                }
            };

            try {
                this._recognition.start();
            } catch (error) {
                this._isListening = false;
                reject(error);
            }
        });
    }

    /**
     * Stop listening
     */
    stopListening() {
        if (this._recognition && this._isListening) {
            this._recognition.stop();
        }
    }

    /**
     * Abort listening (discard results)
     */
    abortListening() {
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
