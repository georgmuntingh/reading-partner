/**
 * TTS Engine Service
 * Handles text-to-speech using Kokoro (ONNX) with Web Speech API fallback
 */

/**
 * @typedef {Object} TTSOptions
 * @property {string} [voice] - Voice ID
 * @property {number} [speed] - Playback speed (0.5-2.0)
 */

/**
 * TTS Engine class
 * Uses Kokoro TTS when available, falls back to Web Speech API
 */
export class TTSEngine {
    constructor() {
        this._kokoro = null;
        this._isReady = false;
        this._isLoading = false;
        this._useKokoro = true;
        this._currentVoice = 'af_bella'; // Default Kokoro voice
        this._audioContext = null;
        this._onProgress = null;

        // Check for Web Speech API support
        this._webSpeechSupported = 'speechSynthesis' in window;
    }

    /**
     * Set progress callback for model loading
     * @param {(progress: {status: string, progress?: number}) => void} callback
     */
    onProgress(callback) {
        this._onProgress = callback;
    }

    /**
     * Initialize the TTS engine
     * @returns {Promise<boolean>} True if Kokoro loaded, false if using fallback
     */
    async initialize() {
        if (this._isReady) return this._useKokoro;
        if (this._isLoading) {
            // Wait for existing initialization
            return new Promise((resolve) => {
                const checkReady = setInterval(() => {
                    if (this._isReady) {
                        clearInterval(checkReady);
                        resolve(this._useKokoro);
                    }
                }, 100);
            });
        }

        this._isLoading = true;

        try {
            this._reportProgress({ status: 'Loading TTS engine...' });

            // Try to load Kokoro
            await this._initializeKokoro();
            this._useKokoro = true;
            this._isReady = true;
            this._reportProgress({ status: 'TTS engine ready', progress: 100 });
            console.log('Kokoro TTS initialized successfully');
            return true;

        } catch (error) {
            console.warn('Kokoro TTS failed to load, using Web Speech fallback:', error);

            if (this._webSpeechSupported) {
                this._useKokoro = false;
                this._isReady = true;
                this._reportProgress({ status: 'Using browser TTS (fallback)' });
                return false;
            } else {
                throw new Error('No TTS engine available. Please use a browser that supports speech synthesis.');
            }
        } finally {
            this._isLoading = false;
        }
    }

    /**
     * Initialize Kokoro TTS
     */
    async _initializeKokoro() {
        // Dynamic import of Kokoro from ESM CDN
        this._reportProgress({ status: 'Loading Kokoro model...', progress: 10 });

        // Import the KokoroTTS library
        const { KokoroTTS } = await import('https://cdn.jsdelivr.net/npm/kokoro-js@1.1.0/+esm');

        this._reportProgress({ status: 'Initializing model...', progress: 30 });

        // Create Kokoro instance - this will download the model
        // Using the smaller/faster model for better mobile performance
        this._kokoro = await KokoroTTS.from_pretrained(
            'onnx-community/Kokoro-82M-v1.0-ONNX',
            {
                dtype: 'q8',  // Quantized for smaller size and faster inference
                device: 'wasm' // Use WebAssembly backend
            }
        );

        this._reportProgress({ status: 'Model loaded', progress: 100 });

        // Initialize audio context
        this._audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }

    /**
     * Report progress to callback
     * @param {{status: string, progress?: number}} progress
     */
    _reportProgress(progress) {
        if (this._onProgress) {
            this._onProgress(progress);
        }
    }

    /**
     * Synthesize speech from text
     * @param {string} text - Text to synthesize
     * @param {TTSOptions} [options]
     * @returns {Promise<AudioBuffer>}
     */
    async synthesize(text, options = {}) {
        if (!this._isReady) {
            await this.initialize();
        }

        if (!text || !text.trim()) {
            throw new Error('No text provided for synthesis');
        }

        if (this._useKokoro) {
            return this._synthesizeKokoro(text, options);
        } else {
            return this._synthesizeWebSpeech(text, options);
        }
    }

    /**
     * Synthesize using Kokoro
     * @param {string} text
     * @param {TTSOptions} options
     * @returns {Promise<AudioBuffer>}
     */
    async _synthesizeKokoro(text, options) {
        const voice = options.voice || this._currentVoice;

        // Generate audio using Kokoro
        const audio = await this._kokoro.generate(text, { voice });

        // Convert to AudioBuffer
        // Kokoro returns audio data that we need to convert
        const audioData = audio.audio;
        const sampleRate = audio.sampling_rate || 24000;

        // Create AudioBuffer
        const audioBuffer = this._audioContext.createBuffer(
            1, // mono
            audioData.length,
            sampleRate
        );

        // Copy data to buffer
        audioBuffer.getChannelData(0).set(audioData);

        return audioBuffer;
    }

    /**
     * Synthesize using Web Speech API (fallback)
     * Returns a "fake" AudioBuffer - actually uses SpeechSynthesis directly
     * @param {string} text
     * @param {TTSOptions} options
     * @returns {Promise<AudioBuffer>}
     */
    async _synthesizeWebSpeech(text, options) {
        // For Web Speech API, we can't get an AudioBuffer
        // Instead, we return a marker and handle playback differently
        // Create a minimal AudioBuffer as a placeholder

        if (!this._audioContext) {
            this._audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }

        // Create a tiny silent buffer as placeholder
        // The actual playback will use speechSynthesis
        const buffer = this._audioContext.createBuffer(1, 1, 22050);

        // Store the text for later playback
        buffer._webSpeechText = text;
        buffer._webSpeechOptions = options;
        buffer._isWebSpeechFallback = true;

        return buffer;
    }

    /**
     * Play an AudioBuffer (or trigger Web Speech)
     * @param {AudioBuffer} buffer
     * @param {number} [speed=1.0]
     * @returns {Promise<void>}
     */
    async playBuffer(buffer, speed = 1.0) {
        // Resume audio context if suspended (required for user gesture)
        if (this._audioContext && this._audioContext.state === 'suspended') {
            await this._audioContext.resume();
        }

        if (buffer._isWebSpeechFallback) {
            return this._playWebSpeech(buffer._webSpeechText, speed);
        }

        return new Promise((resolve, reject) => {
            const source = this._audioContext.createBufferSource();
            source.buffer = buffer;
            source.playbackRate.value = speed;
            source.connect(this._audioContext.destination);

            source.onended = () => resolve();
            source.onerror = (e) => reject(e);

            source.start();
        });
    }

    /**
     * Play using Web Speech API
     * @param {string} text
     * @param {number} speed
     * @returns {Promise<void>}
     */
    _playWebSpeech(text, speed) {
        return new Promise((resolve, reject) => {
            const utterance = new SpeechSynthesisUtterance(text);
            utterance.rate = speed;
            utterance.onend = () => resolve();
            utterance.onerror = (e) => reject(e);
            speechSynthesis.speak(utterance);
        });
    }

    /**
     * Stop any ongoing Web Speech synthesis
     */
    stopWebSpeech() {
        if (this._webSpeechSupported) {
            speechSynthesis.cancel();
        }
    }

    /**
     * Check if engine is ready
     * @returns {boolean}
     */
    isReady() {
        return this._isReady;
    }

    /**
     * Check if using Kokoro (vs fallback)
     * @returns {boolean}
     */
    isUsingKokoro() {
        return this._useKokoro;
    }

    /**
     * Get available voices
     * @returns {Array<{id: string, name: string}>}
     */
    getAvailableVoices() {
        if (this._useKokoro) {
            // Kokoro voices
            return [
                { id: 'af_bella', name: 'Bella (American Female)' },
                { id: 'af_nicole', name: 'Nicole (American Female)' },
                { id: 'af_sarah', name: 'Sarah (American Female)' },
                { id: 'af_sky', name: 'Sky (American Female)' },
                { id: 'am_adam', name: 'Adam (American Male)' },
                { id: 'am_michael', name: 'Michael (American Male)' },
                { id: 'bf_emma', name: 'Emma (British Female)' },
                { id: 'bf_isabella', name: 'Isabella (British Female)' },
                { id: 'bm_george', name: 'George (British Male)' },
                { id: 'bm_lewis', name: 'Lewis (British Male)' }
            ];
        } else {
            // Web Speech voices
            const voices = speechSynthesis.getVoices();
            return voices.map(v => ({
                id: v.voiceURI,
                name: v.name
            }));
        }
    }

    /**
     * Set current voice
     * @param {string} voiceId
     */
    setVoice(voiceId) {
        this._currentVoice = voiceId;
    }

    /**
     * Get AudioContext (for external use)
     * @returns {AudioContext}
     */
    getAudioContext() {
        if (!this._audioContext) {
            this._audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        return this._audioContext;
    }

    /**
     * Cleanup resources
     */
    destroy() {
        this.stopWebSpeech();
        if (this._audioContext) {
            this._audioContext.close();
            this._audioContext = null;
        }
        this._kokoro = null;
        this._isReady = false;
    }
}

// Export singleton instance
export const ttsEngine = new TTSEngine();
