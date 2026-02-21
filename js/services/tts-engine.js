/**
 * TTS Engine Service
 * Handles text-to-speech using Kokoro (ONNX), Kokoro FastAPI, or Web Speech API fallback
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
 * @property {string} device - Device used (webgpu/wasm/fastapi)
 */

/** @typedef {'kokoro-fastapi'|'kokoro-js'|'web-speech'} TTSBackend */

/**
 * Default Kokoro FastAPI base URL
 */
const DEFAULT_FASTAPI_URL = 'http://localhost:8880';

/**
 * TTS Engine class
 * Uses Kokoro FastAPI, Kokoro TTS (ONNX), or Web Speech API
 */
export class TTSEngine {
    constructor() {
        this._kokoro = null;
        this._isReady = false;
        this._isLoading = false;
        this._useKokoro = true;
        this._currentVoice = 'af_heart'; // Default Kokoro voice
        this._speed = 1.0; // TTS generation speed (0.5-2.0)
        this._audioContext = null;
        this._onProgress = null;
        this._device = 'wasm'; // Current device: 'webgpu', 'wasm', or 'fastapi'
        this._dtype = 'fp32'; // Current dtype: 'fp32', 'fp16', 'q8', 'q4', 'q4f16'
        this._preferredDtype = 'auto'; // User preference: 'auto', 'fp32', 'fp16', 'q8', 'q4', 'q4f16'
        this._sampleRate = 24000;

        // TTS Backend: 'kokoro-fastapi', 'kokoro-js', or 'web-speech'
        /** @type {TTSBackend} */
        this._backend = 'kokoro-js';
        this._fastApiUrl = DEFAULT_FASTAPI_URL;
        this._fastApiAvailable = false;

        // Benchmarking
        this._benchmarkResults = [];
        this._benchmarkEnabled = false;

        // Synthesis queue - Kokoro can only handle one request at a time
        this._synthesisQueue = [];
        this._isSynthesizing = false;

        // Current audio source for stopping playback
        this._currentSource = null;

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
     * Check if Kokoro FastAPI server is available
     * @param {string} [url] - Base URL to check (defaults to stored URL)
     * @returns {Promise<boolean>}
     */
    async isKokoroFastAPIAvailable(url) {
        const baseUrl = url || this._fastApiUrl;
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 2000);
            const response = await fetch(`${baseUrl}/v1/models`, {
                signal: controller.signal
            });
            clearTimeout(timeout);
            this._fastApiAvailable = response.ok;
            return response.ok;
        } catch (e) {
            this._fastApiAvailable = false;
            return false;
        }
    }

    /**
     * Get Kokoro FastAPI availability (last check result)
     * @returns {boolean}
     */
    isFastAPIAvailable() {
        return this._fastApiAvailable;
    }

    /**
     * Set Kokoro FastAPI base URL
     * @param {string} url
     */
    setFastApiUrl(url) {
        this._fastApiUrl = url || DEFAULT_FASTAPI_URL;
    }

    /**
     * Get Kokoro FastAPI base URL
     * @returns {string}
     */
    getFastApiUrl() {
        return this._fastApiUrl;
    }

    /**
     * Get current backend
     * @returns {TTSBackend}
     */
    getBackend() {
        return this._backend;
    }

    /**
     * Set preferred dtype for Kokoro.js model loading.
     * 'auto' selects fp32 for WebGPU and q8 for WASM.
     * @param {string} dtype - 'auto', 'fp32', 'fp16', 'q8', 'q4', 'q4f16'
     */
    setPreferredDtype(dtype) {
        this._preferredDtype = dtype || 'auto';
    }

    /**
     * Get preferred dtype setting
     * @returns {string}
     */
    getPreferredDtype() {
        return this._preferredDtype;
    }

    /**
     * Set TTS backend. If the engine is already initialized, this will
     * trigger a re-initialization.
     * @param {TTSBackend} backend
     * @param {Object} [options]
     * @param {string} [options.dtype] - Override dtype for reinitialization
     * @returns {Promise<void>}
     */
    async setBackend(backend, options = {}) {
        const dtypeChanged = options.dtype !== undefined && options.dtype !== this._preferredDtype;
        if (dtypeChanged) {
            this._preferredDtype = options.dtype;
        }

        if (backend === this._backend && this._isReady && !dtypeChanged) return;

        this._backend = backend;

        // Reset state so re-initialization happens
        this._isReady = false;
        this._isLoading = false;
        this._kokoro = null;

        // Re-initialize with the new backend
        await this.initialize({ backend });
    }

    /**
     * Initialize the TTS engine
     * @param {Object} [options]
     * @param {string} [options.device] - 'webgpu', 'wasm', or 'auto'
     * @param {string} [options.dtype] - 'fp32', 'fp16', 'q8', 'q4'
     * @param {TTSBackend} [options.backend] - Force a specific backend
     * @returns {Promise<boolean>} True if Kokoro loaded (JS or FastAPI), false if using fallback
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

        // If a specific backend is requested, use it
        if (options.backend) {
            this._backend = options.backend;
        }

        // Handle FastAPI backend
        if (this._backend === 'kokoro-fastapi') {
            try {
                this._reportProgress({ status: 'Connecting to Kokoro FastAPI...' });
                const available = await this.isKokoroFastAPIAvailable();
                if (available) {
                    this._useKokoro = true;
                    this._device = 'fastapi';
                    this._isReady = true;
                    this._isLoading = false;

                    // Ensure we have an AudioContext for decoding
                    if (!this._audioContext) {
                        this._audioContext = new (window.AudioContext || window.webkitAudioContext)();
                    }

                    this._reportProgress({ status: 'TTS ready (Kokoro FastAPI)', progress: 100 });
                    console.log(`Kokoro FastAPI TTS initialized: ${this._fastApiUrl}`);
                    return true;
                } else {
                    console.warn('Kokoro FastAPI not available, falling back to kokoro-js');
                    this._backend = 'kokoro-js';
                    // Fall through to kokoro-js initialization
                }
            } catch (error) {
                console.warn('Kokoro FastAPI check failed:', error);
                this._backend = 'kokoro-js';
            }
        }

        // Handle web-speech backend
        if (this._backend === 'web-speech') {
            if (this._webSpeechSupported) {
                this._useKokoro = false;
                this._device = 'web-speech';
                this._isReady = true;
                this._isLoading = false;
                this._reportProgress({ status: 'TTS ready (Browser)' });
                console.log('Using Web Speech API backend');
                return false;
            } else {
                console.warn('Web Speech not supported, falling back to kokoro-js');
                this._backend = 'kokoro-js';
            }
        }

        // kokoro-js backend
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

        // Determine dtype based on device and user preference
        // WebGPU works well with fp32, WASM benefits from quantization (q8)
        let dtype = options.dtype;
        if (!dtype) {
            if (this._preferredDtype && this._preferredDtype !== 'auto') {
                dtype = this._preferredDtype;
            } else {
                dtype = device === 'webgpu' ? 'fp32' : 'q8';
            }
        }

        this._device = device;
        this._dtype = dtype;

        // Warn about known broken dtype+device combinations
        // As of Feb 2026, ONNX Runtime Web's WebGPU EP has an unresolved numerical
        // overflow bug that causes fp16/q4/q4f16 to produce NaN/garbled audio.
        // q8 on WebGPU is also known to produce garbled speech.
        if (device === 'webgpu' && !['fp32', 'auto'].includes(dtype)) {
            const msg = `Warning: "${dtype}" on WebGPU may produce garbled or metallic audio ` +
                `due to a known ONNX Runtime overflow bug. ` +
                `Only fp32 is known to work correctly on WebGPU.`;
            console.warn(msg);
            this._reportProgress({ status: `Loading (${device}, ${dtype}) — quality may be degraded` });
        }

        try {
            this._reportProgress({ status: `Loading TTS engine (${device})...` });

            // Try to load Kokoro
            await this._initializeKokoro(device, dtype);
            this._useKokoro = true;
            this._backend = 'kokoro-js';
            this._isReady = true;
            this._reportProgress({ status: `TTS ready (${device}, ${dtype})`, progress: 100 });
            console.log(`Kokoro TTS initialized: device=${device}, dtype=${dtype}`);
            return true;

        } catch (error) {
            console.warn('Kokoro TTS failed to load, using Web Speech fallback:', error);

            if (this._webSpeechSupported) {
                this._useKokoro = false;
                this._backend = 'web-speech';
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

        if (this._backend === 'kokoro-fastapi') {
            // FastAPI can handle concurrent requests, but we still queue
            // to maintain ordering and avoid overwhelming the server
            return this._queueSynthesis(text, options);
        } else if (this._useKokoro) {
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
            let buffer;
            if (this._backend === 'kokoro-fastapi') {
                buffer = await this._synthesizeKokoroFastAPI(text, options);
            } else {
                buffer = await this._synthesizeKokoro(text, options);
            }
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
        const speed = options.speed || this._speed;

        // Split long sentences to prevent TTS errors
        // Kokoro has issues with very long sentences (>500 chars)
        const chunks = splitLongSentence(text, 500);

        // If sentence was split, synthesize each chunk and concatenate
        if (chunks.length > 1) {
            console.log(`Splitting long sentence (${text.length} chars) into ${chunks.length} chunks`);
            return await this._synthesizeChunks(chunks, voice, speed);
        }

        const startTime = performance.now();

        // Generate audio using Kokoro with speed parameter
        const audio = await this._kokoro.generate(text, { voice, speed });

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
     * @param {number} speed - TTS speed
     * @returns {Promise<AudioBuffer>}
     */
    async _synthesizeChunks(chunks, voice, speed) {
        // Synthesize each chunk
        const audioBuffers = [];
        let totalLength = 0;
        let sampleRate = this._sampleRate;

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            console.log(`  Chunk ${i + 1}/${chunks.length}: "${chunk.substring(0, 50)}..."`);

            const audio = await this._kokoro.generate(chunk, { voice, speed });
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
     * Synthesize using Kokoro FastAPI
     * @param {string} text
     * @param {TTSOptions} options
     * @returns {Promise<AudioBuffer>}
     */
    async _synthesizeKokoroFastAPI(text, options) {
        const voice = options.voice || this._currentVoice;
        const speed = options.speed || this._speed;

        const startTime = performance.now();

        const response = await fetch(`${this._fastApiUrl}/v1/audio/speech`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'kokoro',
                input: text,
                voice: voice,
                speed: speed,
                response_format: 'wav'
            })
        });

        if (!response.ok) {
            throw new Error(`Kokoro FastAPI error: ${response.status} ${response.statusText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const synthesisTime = performance.now() - startTime;

        // Decode WAV to AudioBuffer
        if (!this._audioContext) {
            this._audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        const audioBuffer = await this._audioContext.decodeAudioData(arrayBuffer);

        // Record benchmark if enabled
        if (this._benchmarkEnabled) {
            const audioDurationMs = audioBuffer.duration * 1000;
            const rtf = synthesisTime / audioDurationMs;
            const result = {
                text: text.slice(0, 50) + (text.length > 50 ? '...' : ''),
                textLength: text.length,
                synthesisTimeMs: Math.round(synthesisTime),
                audioDurationMs: Math.round(audioDurationMs),
                rtf: Math.round(rtf * 1000) / 1000,
                device: 'fastapi'
            };
            this._benchmarkResults.push(result);
            console.log(`TTS Benchmark (FastAPI): ${result.synthesisTimeMs}ms for ${result.audioDurationMs}ms audio (RTF: ${result.rtf})`);
        }

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
     * Run a benchmark test
     * @param {string[]} testSentences - Sentences to test
     * @returns {Promise<{results: BenchmarkResult[], averageRTF: number, device: string, dtype: string}>}
     */
    async runBenchmark(testSentences) {
        if (!this._isReady) {
            await this.initialize();
        }

        if (!this._useKokoro && this._backend !== 'kokoro-fastapi') {
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
     * @param {number} [speed=1.0] - Only used for Web Speech fallback
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

        // Note: Speed is applied at TTS generation time via Kokoro's speed parameter
        // We don't modify playbackRate here to avoid pitch distortion
        return new Promise((resolve, reject) => {
            const source = this._audioContext.createBufferSource();
            source.buffer = buffer;
            source.connect(this._audioContext.destination);

            // Store current source for stopping
            this._currentSource = source;

            source.onended = () => {
                this._currentSource = null;
                resolve();
            };
            source.onerror = (e) => {
                this._currentSource = null;
                reject(e);
            };

            source.start();
        });
    }

    /**
     * Stop current audio playback
     */
    stopAudio() {
        if (this._currentSource) {
            try {
                this._currentSource.stop();
            } catch (e) {
                // Source may already be stopped
            }
            this._currentSource = null;
        }
        // Also stop Web Speech if it's playing
        this.stopWebSpeech();
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
     * @returns {Array<{id: string, name: string, disabled?: boolean}>}
     */
    getAvailableVoices() {
        if (this._useKokoro) {
            // Non-English voices require the FastAPI backend
            const needsFastAPI = this._backend !== 'kokoro-fastapi';

            // Kokoro voices - organized by accent and gender
            return [
                // American Female
                { id: 'af_alloy', name: 'Alloy (American Female)' },
                { id: 'af_aoede', name: 'Aoede (American Female)' },
                { id: 'af_bella', name: 'Bella (American Female)' },
                { id: 'af_heart', name: 'Heart (American Female)' },
                { id: 'af_jessica', name: 'Jessica (American Female)' },
                { id: 'af_kore', name: 'Kore (American Female)' },
                { id: 'af_nicole', name: 'Nicole (American Female)' },
                { id: 'af_nova', name: 'Nova (American Female)' },
                { id: 'af_river', name: 'River (American Female)' },
                { id: 'af_sarah', name: 'Sarah (American Female)' },
                { id: 'af_sky', name: 'Sky (American Female)' },

                // American Male
                { id: 'am_adam', name: 'Adam (American Male)' },
                { id: 'am_echo', name: 'Echo (American Male)' },
                { id: 'am_eric', name: 'Eric (American Male)' },
                { id: 'am_fenrir', name: 'Fenrir (American Male)' },
                { id: 'am_liam', name: 'Liam (American Male)' },
                { id: 'am_michael', name: 'Michael (American Male)' },
                { id: 'am_onyx', name: 'Onyx (American Male)' },
                { id: 'am_puck', name: 'Puck (American Male)' },

                // British Female
                { id: 'bf_alice', name: 'Alice (British Female)' },
                { id: 'bf_emma', name: 'Emma (British Female)' },
                { id: 'bf_isabella', name: 'Isabella (British Female)' },
                { id: 'bf_lily', name: 'Lily (British Female)' },

                // British Male
                { id: 'bm_daniel', name: 'Daniel (British Male)' },
                { id: 'bm_fable', name: 'Fable (British Male)' },
                { id: 'bm_george', name: 'George (British Male)' },
                { id: 'bm_lewis', name: 'Lewis (British Male)' },

                // Japanese (FastAPI only)
                { id: 'jf_alpha', name: 'Alpha (Japanese Female)', disabled: needsFastAPI },
                { id: 'jf_gongitsune', name: 'Gongitsune (Japanese Female)', disabled: needsFastAPI },
                { id: 'jf_nezumi', name: 'Nezumi (Japanese Female)', disabled: needsFastAPI },
                { id: 'jm_kumo', name: 'Kumo (Japanese Male)', disabled: needsFastAPI },

                // Chinese Mandarin (FastAPI only)
                { id: 'zf_xiaobei', name: 'Xiaobei (Chinese Female)', disabled: needsFastAPI },
                { id: 'zf_xiaoni', name: 'Xiaoni (Chinese Female)', disabled: needsFastAPI },
                { id: 'zf_xiaoxuan', name: 'Xiaoxuan (Chinese Female)', disabled: needsFastAPI },
                { id: 'zm_yunjian', name: 'Yunjian (Chinese Male)', disabled: needsFastAPI },
                { id: 'zm_yunxi', name: 'Yunxi (Chinese Male)', disabled: needsFastAPI },
                { id: 'zm_yunyang', name: 'Yunyang (Chinese Male)', disabled: needsFastAPI },

                // French (FastAPI only)
                { id: 'ff_siwis', name: 'Siwis (French Female)', disabled: needsFastAPI },

                // Hindi (FastAPI only)
                { id: 'hf_alpha', name: 'Alpha (Hindi Female)', disabled: needsFastAPI },
                { id: 'hf_beta', name: 'Beta (Hindi Female)', disabled: needsFastAPI },
                { id: 'hm_omega', name: 'Omega (Hindi Male)', disabled: needsFastAPI },
                { id: 'hm_psi', name: 'Psi (Hindi Male)', disabled: needsFastAPI },

                // Italian (FastAPI only)
                { id: 'if_sara', name: 'Sara (Italian Female)', disabled: needsFastAPI },
                { id: 'im_nicola', name: 'Nicola (Italian Male)', disabled: needsFastAPI },

                // Portuguese Brazilian (FastAPI only)
                { id: 'pf_dora', name: 'Dora (Portuguese Female)', disabled: needsFastAPI },
                { id: 'pm_alex', name: 'Alex (Portuguese Male)', disabled: needsFastAPI },
                { id: 'pm_santa', name: 'Santa (Portuguese Male)', disabled: needsFastAPI },

                // Spanish (FastAPI only)
                { id: 'sf_dalia', name: 'Dalia (Spanish Female)', disabled: needsFastAPI },
                { id: 'sm_agustin', name: 'Agustin (Spanish Male)', disabled: needsFastAPI }
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
     * Language code to Kokoro voice prefix mapping.
     * Returns the first available Kokoro voice for a language.
     * Falls back to null if no Kokoro voice is available (use Web Speech API).
     * @param {string} langCode - ISO 639-1 language code (e.g. 'ja', 'zh', 'fr')
     * @returns {string|null} Kokoro voice ID, or null if unsupported
     */
    getVoiceForLanguage(langCode) {
        const prefixMap = {
            'en': 'af_', // American English by default
            'ja': 'jf_',
            'zh': 'zf_',
            'fr': 'ff_',
            'hi': 'hf_',
            'it': 'if_',
            'pt': 'pf_',
            'es': 'sf_',
        };

        const prefix = prefixMap[langCode];
        if (!prefix) return null;

        // Find the first voice matching this prefix
        const voices = this.getAvailableVoices();
        const match = voices.find(v => v.id.startsWith(prefix));
        return match ? match.id : null;
    }

    /**
     * Set current voice
     * @param {string} voiceId
     */
    setVoice(voiceId) {
        this._currentVoice = voiceId;
    }

    /**
     * Set TTS generation speed
     * @param {number} speed - 0.5 to 2.0
     */
    setSpeed(speed) {
        this._speed = Math.max(0.5, Math.min(2.0, speed));
    }

    /**
     * Get current speed
     * @returns {number}
     */
    getSpeed() {
        return this._speed;
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
        this._isLoading = false;
    }
}

// Export singleton instance
export const ttsEngine = new TTSEngine();
