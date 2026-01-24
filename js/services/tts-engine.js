/**
 * TTS Engine Service
 * Handles text-to-speech using Kokoro (ONNX) with Web Speech API fallback
 * Supports WebGPU for GPU acceleration
 */

import { splitLongSentence } from '../utils/sentence-splitter.js';

/**
 * @typedef {Object} TTSOptions
 * @property {string} [voice] - Voice ID
 * @property {number} [speed] - Playback speed (0.5-2.0)
 */

/**
 * @typedef {Object} BenchmarkResult
 * @property {string} text - Input text
 * @property {number} textLength - Character count
 * @property {number} synthesisTimeMs - Time to synthesize (ms)
 * @property {number} audioDurationMs - Duration of generated audio (ms)
 * @property {number} rtf - Real-time factor (synthesis time / audio duration)
 * @property {string} device - Device used (webgpu/wasm)
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
        this._device = 'wasm'; // Current device: 'webgpu' or 'wasm'
        this._dtype = 'fp32'; // Current dtype: 'fp32', 'fp16', 'q8', 'q4'
        this._sampleRate = 24000;

        // Benchmarking
        this._benchmarkResults = [];
        this._benchmarkEnabled = false;

        // Synthesis queue - Kokoro can only handle one request at a time
        this._synthesisQueue = [];
        this._isSynthesizing = false;

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
     * Check if WebGPU is available
     * @returns {Promise<boolean>}
     */
    async isWebGPUAvailable() {
        if (!navigator.gpu) {
            return false;
        }
        try {
            const adapter = await navigator.gpu.requestAdapter();
            return adapter !== null;
        } catch (e) {
            return false;
        }
    }

    /**
     * Initialize the TTS engine
     * @param {Object} [options]
     * @param {string} [options.device] - 'webgpu', 'wasm', or 'auto'
     * @param {string} [options.dtype] - 'fp32', 'fp16', 'q8', 'q4'
     * @returns {Promise<boolean>} True if Kokoro loaded, false if using fallback
     */
    async initialize(options = {}) {
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

        // Determine device
        let device = options.device || 'auto';
        if (device === 'auto') {
            const hasWebGPU = await this.isWebGPUAvailable();
            device = hasWebGPU ? 'webgpu' : 'wasm';
            console.log(`Auto-detected device: ${device} (WebGPU ${hasWebGPU ? 'available' : 'not available'})`);

            // Show WebGPU warning if not available
            if (!hasWebGPU) {
                this._showWebGPUWarning();
            }
        }

        // Determine dtype based on device
        // WebGPU works well with fp32/fp16, WASM benefits from quantization
        let dtype = options.dtype;
        if (!dtype) {
            dtype = device === 'webgpu' ? 'fp32' : 'q8';
        }

        this._device = device;
        this._dtype = dtype;

        try {
            this._reportProgress({ status: `Loading TTS engine (${device})...` });

            // Try to load Kokoro
            await this._initializeKokoro(device, dtype);
            this._useKokoro = true;
            this._isReady = true;
            this._reportProgress({ status: `TTS ready (${device}, ${dtype})`, progress: 100 });
            console.log(`Kokoro TTS initialized: device=${device}, dtype=${dtype}`);
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
     * @param {string} device - 'webgpu' or 'wasm'
     * @param {string} dtype - Model precision
     */
    async _initializeKokoro(device, dtype) {
        // Dynamic import of Kokoro from ESM CDN
        this._reportProgress({ status: 'Loading Kokoro library...', progress: 10 });

        // Import the KokoroTTS library
        const { KokoroTTS } = await import('https://cdn.jsdelivr.net/npm/kokoro-js@1.1.0/+esm');

        this._reportProgress({ status: `Initializing model (${device}, ${dtype})...`, progress: 30 });

        // Create Kokoro instance - this will download the model
        this._kokoro = await KokoroTTS.from_pretrained(
            'onnx-community/Kokoro-82M-v1.0-ONNX',
            {
                dtype: dtype,
                device: device
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
     * Show WebGPU not available warning
     */
    _showWebGPUWarning() {
        const message = 'No WebGPU enabled. For better performance, launch Google Chrome with:\n\n' +
            'google-chrome --enable-unsafe-webgpu --ozone-platform=x11 --use-angle=vulkan --enable-features=Vulkan,VulkanFromANGLE';

        console.warn('WebGPU not available. Using WASM backend (slower).');
        console.info(message);

        // Show visual warning
        const warningDiv = document.createElement('div');
        warningDiv.id = 'webgpu-warning';
        warningDiv.style.cssText = `
            position: fixed;
            bottom: 80px;
            left: 50%;
            transform: translateX(-50%);
            max-width: 90vw;
            padding: 12px 16px;
            background: #fef3c7;
            border: 1px solid #f59e0b;
            border-radius: 8px;
            font-size: 13px;
            color: #92400e;
            z-index: 1000;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        `;
        warningDiv.innerHTML = `
            <div style="display: flex; align-items: flex-start; gap: 10px;">
                <span style="font-size: 18px;">⚠️</span>
                <div>
                    <strong>WebGPU not enabled</strong><br>
                    <span style="font-size: 12px;">Using slower WASM backend. For better performance, launch Chrome with:</span><br>
                    <code style="font-size: 11px; background: #fde68a; padding: 2px 4px; border-radius: 3px; word-break: break-all;">
                        google-chrome --enable-unsafe-webgpu --ozone-platform=x11 --use-angle=vulkan --enable-features=Vulkan,VulkanFromANGLE
                    </code>
                </div>
                <button onclick="this.parentElement.parentElement.remove()" style="background: none; border: none; cursor: pointer; font-size: 16px; padding: 0; margin-left: auto;">×</button>
            </div>
        `;
        document.body.appendChild(warningDiv);

        // Auto-hide after 15 seconds
        setTimeout(() => {
            warningDiv?.remove();
        }, 15000);
    }

    /**
     * Enable/disable benchmarking
     * @param {boolean} enabled
     */
    setBenchmarkEnabled(enabled) {
        this._benchmarkEnabled = enabled;
        if (!enabled) {
            this._benchmarkResults = [];
        }
    }

    /**
     * Get benchmark results
     * @returns {BenchmarkResult[]}
     */
    getBenchmarkResults() {
        return [...this._benchmarkResults];
    }

    /**
     * Get average RTF from benchmarks
     * @returns {number|null}
     */
    getAverageRTF() {
        if (this._benchmarkResults.length === 0) return null;
        const sum = this._benchmarkResults.reduce((acc, r) => acc + r.rtf, 0);
        return sum / this._benchmarkResults.length;
    }

    /**
     * Clear benchmark results
     */
    clearBenchmarks() {
        this._benchmarkResults = [];
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
            // Queue the request - Kokoro can only handle one at a time
            return this._queueSynthesis(text, options);
        } else {
            return this._synthesizeWebSpeech(text, options);
        }
    }

    /**
     * Queue a synthesis request to prevent concurrent ONNX sessions
     * @param {string} text
     * @param {TTSOptions} options
     * @returns {Promise<AudioBuffer>}
     */
    _queueSynthesis(text, options) {
        return new Promise((resolve, reject) => {
            this._synthesisQueue.push({ text, options, resolve, reject });
            this._processQueue();
        });
    }

    /**
     * Process the synthesis queue sequentially
     */
    async _processQueue() {
        if (this._isSynthesizing || this._synthesisQueue.length === 0) {
            return;
        }

        this._isSynthesizing = true;
        const { text, options, resolve, reject } = this._synthesisQueue.shift();

        try {
            const buffer = await this._synthesizeKokoro(text, options);
            resolve(buffer);
        } catch (error) {
            reject(error);
        } finally {
            this._isSynthesizing = false;
            // Process next item in queue
            this._processQueue();
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

        // Split long sentences to prevent TTS errors
        // Kokoro has issues with very long sentences (>500 chars)
        const chunks = splitLongSentence(text, 500);

        // If sentence was split, synthesize each chunk and concatenate
        if (chunks.length > 1) {
            console.log(`Splitting long sentence (${text.length} chars) into ${chunks.length} chunks`);
            return await this._synthesizeChunks(chunks, voice);
        }

        const startTime = performance.now();

        // Generate audio using Kokoro
        const audio = await this._kokoro.generate(text, { voice });

        const synthesisTime = performance.now() - startTime;

        // Convert to AudioBuffer
        // Kokoro returns audio data that we need to convert
        const audioData = audio.audio;
        const sampleRate = audio.sampling_rate || this._sampleRate;

        // Create AudioBuffer
        const audioBuffer = this._audioContext.createBuffer(
            1, // mono
            audioData.length,
            sampleRate
        );

        // Copy data to buffer
        audioBuffer.getChannelData(0).set(audioData);

        // Calculate audio duration in ms
        const audioDurationMs = (audioData.length / sampleRate) * 1000;

        // Record benchmark if enabled
        if (this._benchmarkEnabled) {
            const rtf = synthesisTime / audioDurationMs;
            const result = {
                text: text.slice(0, 50) + (text.length > 50 ? '...' : ''),
                textLength: text.length,
                synthesisTimeMs: Math.round(synthesisTime),
                audioDurationMs: Math.round(audioDurationMs),
                rtf: Math.round(rtf * 1000) / 1000, // 3 decimal places
                device: this._device
            };
            this._benchmarkResults.push(result);
            console.log(`TTS Benchmark: ${result.synthesisTimeMs}ms for ${result.audioDurationMs}ms audio (RTF: ${result.rtf})`);
        }

        return audioBuffer;
    }

    /**
     * Synthesize multiple chunks and concatenate them
     * @param {string[]} chunks - Text chunks to synthesize
     * @param {string} voice - Voice ID
     * @returns {Promise<AudioBuffer>}
     */
    async _synthesizeChunks(chunks, voice) {
        // Synthesize each chunk
        const audioBuffers = [];
        let totalLength = 0;
        let sampleRate = this._sampleRate;

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            console.log(`  Chunk ${i + 1}/${chunks.length}: "${chunk.substring(0, 50)}..."`);

            const audio = await this._kokoro.generate(chunk, { voice });
            const audioData = audio.audio;
            sampleRate = audio.sampling_rate || this._sampleRate;

            const buffer = this._audioContext.createBuffer(1, audioData.length, sampleRate);
            buffer.getChannelData(0).set(audioData);

            audioBuffers.push(buffer);
            totalLength += audioData.length;
        }

        // Concatenate all buffers
        const concatenated = this._audioContext.createBuffer(1, totalLength, sampleRate);
        const output = concatenated.getChannelData(0);

        let offset = 0;
        for (const buffer of audioBuffers) {
            const data = buffer.getChannelData(0);
            output.set(data, offset);
            offset += data.length;
        }

        console.log(`Concatenated ${chunks.length} chunks into ${totalLength} samples`);
        return concatenated;
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
     * Run a benchmark test
     * @param {string[]} testSentences - Sentences to test
     * @returns {Promise<{results: BenchmarkResult[], averageRTF: number, device: string, dtype: string}>}
     */
    async runBenchmark(testSentences) {
        if (!this._isReady) {
            await this.initialize();
        }

        if (!this._useKokoro) {
            throw new Error('Benchmarking only available with Kokoro TTS');
        }

        const wasEnabled = this._benchmarkEnabled;
        this._benchmarkEnabled = true;
        const startIdx = this._benchmarkResults.length;

        console.log(`Running benchmark on ${testSentences.length} sentences...`);

        for (const sentence of testSentences) {
            await this.synthesize(sentence);
        }

        const results = this._benchmarkResults.slice(startIdx);
        const averageRTF = results.reduce((acc, r) => acc + r.rtf, 0) / results.length;

        this._benchmarkEnabled = wasEnabled;

        const summary = {
            results,
            averageRTF: Math.round(averageRTF * 1000) / 1000,
            device: this._device,
            dtype: this._dtype,
            totalSynthesisTime: results.reduce((acc, r) => acc + r.synthesisTimeMs, 0),
            totalAudioTime: results.reduce((acc, r) => acc + r.audioDurationMs, 0)
        };

        console.log('Benchmark Summary:', summary);
        return summary;
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
     * Get current device
     * @returns {string}
     */
    getDevice() {
        return this._device;
    }

    /**
     * Get current dtype
     * @returns {string}
     */
    getDtype() {
        return this._dtype;
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
