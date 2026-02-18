/**
 * Whisper STT Service
 * Speech-to-text using Whisper via transformers.js in a Web Worker.
 * Provides the same public API as STTService for drop-in replacement.
 */

// Default Whisper models available
export const WHISPER_MODELS = [
    { id: 'onnx-community/whisper-tiny.en', name: 'Whisper Tiny (English)', size: '~75 MB' },
    { id: 'onnx-community/whisper-base.en', name: 'Whisper Base (English)', size: '~150 MB' },
    { id: 'onnx-community/whisper-small.en', name: 'Whisper Small (English)', size: '~470 MB' },
    { id: 'onnx-community/whisper-tiny', name: 'Whisper Tiny (Multilingual)', size: '~75 MB' },
    { id: 'onnx-community/whisper-base', name: 'Whisper Base (Multilingual)', size: '~150 MB' },
];

export const DEFAULT_WHISPER_MODEL = 'onnx-community/whisper-tiny.en';

export class WhisperSTTService {
    constructor() {
        this._worker = null;
        this._isReady = false;
        this._isLoading = false;
        this._isListening = false;
        this._silenceTimeout = 3000;
        this._maxDuration = 30000; // 30 second hard cap to handle noisy environments

        // Audio recording state
        this._mediaStream = null;
        this._audioContext = null;
        this._analyser = null;
        this._processor = null;
        this._audioChunks = [];
        this._silenceTimer = null;
        this._maxDurationTimer = null;

        // Configuration
        this._model = DEFAULT_WHISPER_MODEL;
        this._device = 'auto';

        // Callbacks (same interface as STTService)
        this.onInterimResult = null;
        this.onError = null;
        this.onStart = null;
        this.onEnd = null;

        // Model loading progress callback
        this.onModelProgress = null;
    }

    /**
     * Check if Whisper STT is supported (requires MediaDevices + Worker)
     * @returns {boolean}
     */
    isSupported() {
        return !!(navigator.mediaDevices?.getUserMedia && typeof Worker !== 'undefined');
    }

    /**
     * Check if currently listening
     * @returns {boolean}
     */
    isListening() {
        return this._isListening;
    }

    /**
     * Check if the model is loaded and ready
     * @returns {boolean}
     */
    isModelReady() {
        return this._isReady;
    }

    /**
     * Check if the model is currently loading
     * @returns {boolean}
     */
    isModelLoading() {
        return this._isLoading;
    }

    /**
     * Set the silence timeout duration
     * @param {number} ms
     */
    setSilenceTimeout(ms) {
        this._silenceTimeout = ms;
    }

    /**
     * Set the maximum recording duration (hard cap for noisy environments)
     * @param {number} ms - 0 to disable
     */
    setMaxDuration(ms) {
        this._maxDuration = ms;
    }

    /**
     * Set the Whisper model to use
     * @param {string} modelId
     */
    setModel(modelId) {
        if (modelId !== this._model) {
            this._model = modelId;
            // Need to reload if already loaded
            if (this._isReady) {
                this._isReady = false;
                this._worker?.postMessage({ type: 'unload' });
            }
        }
    }

    /**
     * Get the current model ID
     * @returns {string}
     */
    getModel() {
        return this._model;
    }

    /**
     * Set device preference
     * @param {'auto'|'webgpu'|'wasm'} device
     */
    setDevice(device) {
        this._device = device;
    }

    /**
     * Get available models
     * @returns {Array}
     */
    getAvailableModels() {
        return WHISPER_MODELS;
    }

    /**
     * Initialize the worker and load the model
     * @returns {Promise<void>}
     */
    async loadModel() {
        if (this._isReady) return;
        if (this._isLoading) {
            // Wait for current loading to complete
            return new Promise((resolve, reject) => {
                const check = setInterval(() => {
                    if (this._isReady) {
                        clearInterval(check);
                        resolve();
                    } else if (!this._isLoading) {
                        clearInterval(check);
                        reject(new Error('Model loading failed'));
                    }
                }, 100);
            });
        }

        this._isLoading = true;

        return new Promise((resolve, reject) => {
            // Create worker
            this._worker = new Worker(
                new URL('../workers/whisper-worker.js', import.meta.url),
                { type: 'module' }
            );

            this._worker.onmessage = (event) => {
                const { type, ...data } = event.data;

                switch (type) {
                    case 'loading':
                        this.onModelProgress?.(data.progress);
                        break;
                    case 'ready':
                        this._isReady = true;
                        this._isLoading = false;
                        resolve();
                        break;
                    case 'error':
                        this._isLoading = false;
                        reject(new Error(data.error));
                        break;
                }
            };

            this._worker.onerror = (error) => {
                this._isLoading = false;
                reject(new Error(`Worker error: ${error.message}`));
            };

            // Start loading
            this._worker.postMessage({
                type: 'load',
                model: this._model,
                device: this._device
            });
        });
    }

    /**
     * Start listening for speech
     * @returns {Promise<string>} Transcribed text
     */
    startListening() {
        return new Promise(async (resolve, reject) => {
            if (!this.isSupported()) {
                reject(new Error('Whisper STT not supported in this browser'));
                return;
            }

            if (this._isListening) {
                reject(new Error('Already listening'));
                return;
            }

            try {
                // Ensure model is loaded
                if (!this._isReady) {
                    await this.loadModel();
                }

                this._isListening = true;
                this._audioChunks = [];

                // Get microphone access
                this._mediaStream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        channelCount: 1,
                        sampleRate: 16000
                    }
                });

                // Set up audio context for silence detection
                this._audioContext = new (window.AudioContext || window.webkitAudioContext)({
                    sampleRate: 16000
                });

                const source = this._audioContext.createMediaStreamSource(this._mediaStream);

                // Analyser for silence detection
                this._analyser = this._audioContext.createAnalyser();
                this._analyser.fftSize = 2048;
                this._analyser.smoothingTimeConstant = 0.8;
                source.connect(this._analyser);

                // ScriptProcessor to capture raw PCM data
                // (AudioWorklet would be better but ScriptProcessor is simpler and more compatible)
                this._processor = this._audioContext.createScriptProcessor(4096, 1, 1);
                source.connect(this._processor);
                this._processor.connect(this._audioContext.destination);

                this._processor.onaudioprocess = (event) => {
                    if (!this._isListening) return;
                    const inputData = event.inputBuffer.getChannelData(0);
                    // Copy the data (the buffer gets reused)
                    this._audioChunks.push(new Float32Array(inputData));
                };

                this.onStart?.();

                // Show "Listening..." as interim result
                this.onInterimResult?.('Listening...');

                // Called when silence is detected or max duration reached
                const onSilenceDetected = () => {
                    clearTimeout(this._maxDurationTimer);
                    this._maxDurationTimer = null;
                    // Silence detected - stop and transcribe
                    this._stopRecording().then(audioData => {
                        if (!audioData || audioData.length < 1600) {
                            // Less than 0.1s of audio
                            this._isListening = false;
                            this.onEnd?.();
                            reject(new Error('No speech detected'));
                            return;
                        }

                        this.onInterimResult?.('Transcribing...');

                        // Set up one-time message handler for transcription result
                        const resultHandler = (event) => {
                            const { type, ...data } = event.data;

                            if (type === 'result') {
                                this._worker.removeEventListener('message', resultHandler);
                                this._isListening = false;
                                this.onEnd?.();

                                if (data.text && data.text.trim()) {
                                    this.onInterimResult?.(data.text);
                                    resolve(data.text);
                                } else {
                                    reject(new Error('No speech detected'));
                                }
                            } else if (type === 'error') {
                                this._worker.removeEventListener('message', resultHandler);
                                this._isListening = false;
                                this.onEnd?.();
                                this.onError?.('transcription-error', data.error);
                                reject(new Error(data.error));
                            }
                        };

                        this._worker.addEventListener('message', resultHandler);

                        // Send audio to worker for transcription
                        this._worker.postMessage({
                            type: 'transcribe',
                            audio: audioData
                        });
                    });
                };

                // Hard cap: stop after maxDuration regardless of audio level (handles noisy environments)
                if (this._maxDuration > 0) {
                    this._maxDurationTimer = setTimeout(() => {
                        if (this._isListening) {
                            cancelAnimationFrame(this._silenceRAF);
                            onSilenceDetected();
                        }
                    }, this._maxDuration);
                }

                // Start silence detection
                this._startSilenceDetection(onSilenceDetected);

            } catch (error) {
                this._isListening = false;
                this._cleanup();

                let errorMessage = 'Microphone error';
                if (error.name === 'NotAllowedError') {
                    errorMessage = 'Microphone permission denied';
                } else if (error.name === 'NotFoundError') {
                    errorMessage = 'No microphone found';
                }

                this.onError?.('audio-capture', errorMessage);
                reject(new Error(errorMessage));
            }
        });
    }

    /**
     * Stop listening
     */
    stopListening() {
        if (this._isListening) {
            clearTimeout(this._silenceTimer);
            clearTimeout(this._maxDurationTimer);
            this._maxDurationTimer = null;
            cancelAnimationFrame(this._silenceRAF);
            this._stopRecording();
        }
    }

    /**
     * Abort listening (discard results)
     */
    abortListening() {
        this._isListening = false;
        clearTimeout(this._silenceTimer);
        clearTimeout(this._maxDurationTimer);
        this._maxDurationTimer = null;
        cancelAnimationFrame(this._silenceRAF);
        this._cleanup();
        this.onEnd?.();
    }

    /**
     * Set the recognition language (for multilingual Whisper models)
     * @param {string} lang - Language code (e.g., 'en', 'es')
     */
    setLanguage(lang) {
        // Whisper auto-detects language, but we could pass it as a parameter
        // in the future. For now this is a no-op to match STTService API.
        this._language = lang;
    }

    /**
     * Request microphone permission
     * @returns {Promise<boolean>}
     */
    async requestPermission() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach(track => track.stop());
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Unload the model to free memory
     */
    unloadModel() {
        if (this._worker) {
            this._worker.postMessage({ type: 'unload' });
            this._isReady = false;
        }
    }

    /**
     * Destroy the service and release all resources
     */
    destroy() {
        this.abortListening();
        if (this._worker) {
            this._worker.terminate();
            this._worker = null;
        }
        this._isReady = false;
        this._isLoading = false;
    }

    // ========== Private Methods ==========

    /**
     * Start monitoring for silence
     * @param {() => void} onSilence - Called when silence is detected
     */
    _startSilenceDetection(onSilence) {
        const bufferLength = this._analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        let silenceStart = null;
        let hasSpeech = false;

        const checkSilence = () => {
            if (!this._isListening) return;

            this._analyser.getByteFrequencyData(dataArray);

            // Calculate average volume
            let sum = 0;
            for (let i = 0; i < bufferLength; i++) {
                sum += dataArray[i];
            }
            const average = sum / bufferLength;

            // Threshold for "speech" vs "silence"
            const SPEECH_THRESHOLD = 10;

            if (average > SPEECH_THRESHOLD) {
                hasSpeech = true;
                silenceStart = null;
            } else if (hasSpeech) {
                // We had speech, now it's silent
                if (silenceStart === null) {
                    silenceStart = Date.now();
                } else if (Date.now() - silenceStart >= this._silenceTimeout) {
                    // Silence threshold reached
                    onSilence();
                    return;
                }
            } else {
                // No speech yet - use a longer initial timeout
                if (silenceStart === null) {
                    silenceStart = Date.now();
                } else if (Date.now() - silenceStart >= this._silenceTimeout * 2) {
                    // Waited too long with no speech at all
                    onSilence();
                    return;
                }
            }

            this._silenceRAF = requestAnimationFrame(checkSilence);
        };

        this._silenceRAF = requestAnimationFrame(checkSilence);
    }

    /**
     * Stop recording and return the audio as a Float32Array
     * @returns {Promise<Float32Array>}
     */
    async _stopRecording() {
        this._isListening = false;

        // Concatenate audio chunks
        const totalLength = this._audioChunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const audioData = new Float32Array(totalLength);
        let offset = 0;
        for (const chunk of this._audioChunks) {
            audioData.set(chunk, offset);
            offset += chunk.length;
        }
        this._audioChunks = [];

        // Cleanup recording resources
        this._cleanup();

        return audioData;
    }

    /**
     * Cleanup recording resources
     */
    _cleanup() {
        if (this._processor) {
            this._processor.disconnect();
            this._processor = null;
        }
        if (this._analyser) {
            this._analyser.disconnect();
            this._analyser = null;
        }
        if (this._audioContext) {
            this._audioContext.close().catch(() => {});
            this._audioContext = null;
        }
        if (this._mediaStream) {
            this._mediaStream.getTracks().forEach(track => track.stop());
            this._mediaStream = null;
        }
    }
}
