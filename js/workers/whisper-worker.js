/**
 * Whisper Web Worker
 * Runs Whisper STT inference in a dedicated worker thread
 * to avoid blocking the main UI thread.
 */

// Model state
let pipeline = null;
let transcriber = null;
let isLoading = false;
let inferenceCount = 0;

// Reinitialize pipeline every N inferences to work around memory leak
// (https://github.com/huggingface/transformers.js/issues/860)
const MAX_INFERENCES_BEFORE_REINIT = 20;

/**
 * Detect WebGPU availability inside the worker
 */
async function detectWebGPU() {
    if (typeof navigator === 'undefined' || !navigator.gpu) return false;
    try {
        const adapter = await navigator.gpu.requestAdapter();
        return adapter !== null;
    } catch {
        return false;
    }
}

/**
 * Resolve the device to use
 */
async function resolveDevice(requestedDevice) {
    if (requestedDevice === 'webgpu') return 'webgpu';
    if (requestedDevice === 'wasm') return 'wasm';
    // auto
    const hasWebGPU = await detectWebGPU();
    return hasWebGPU ? 'webgpu' : 'wasm';
}

/**
 * Load the Whisper model
 */
async function loadModel(config) {
    if (isLoading) return;
    isLoading = true;

    const {
        model = 'onnx-community/whisper-tiny.en',
        device: requestedDevice = 'auto',
        dtype = null
    } = config;

    try {
        self.postMessage({ type: 'loading', progress: { status: 'Loading transformers.js library...' } });

        // Dynamic import of transformers.js from CDN
        const { pipeline: createPipeline, env } = await import(
            'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3'
        );

        // Disable local model check - we always download from HF Hub
        env.allowLocalModels = false;

        const device = await resolveDevice(requestedDevice);

        self.postMessage({
            type: 'loading',
            progress: { status: `Loading Whisper model (${device})...` }
        });

        // Dtype configuration: encoder must stay fp32 for accuracy,
        // decoder can be quantized. Using q4 on decoder with webgpu
        // avoids the q8 decoder bug (issue #1317).
        const dtypeConfig = dtype || {
            encoder_model: 'fp32',
            decoder_model_merged: 'q4'
        };

        transcriber = await createPipeline(
            'automatic-speech-recognition',
            model,
            {
                device,
                dtype: dtypeConfig,
                // Report download progress
                progress_callback: (progress) => {
                    if (progress.status === 'progress') {
                        self.postMessage({
                            type: 'loading',
                            progress: {
                                status: `Downloading ${progress.file}`,
                                file: progress.file,
                                loaded: progress.loaded,
                                total: progress.total,
                                progress: progress.progress
                            }
                        });
                    }
                }
            }
        );

        inferenceCount = 0;
        isLoading = false;

        self.postMessage({
            type: 'ready',
            info: { model, device, dtype: dtypeConfig }
        });

    } catch (error) {
        isLoading = false;
        self.postMessage({ type: 'error', error: error.message });
    }
}

/**
 * Transcribe audio data
 */
async function transcribe(audioData) {
    if (!transcriber) {
        self.postMessage({ type: 'error', error: 'Model not loaded' });
        return;
    }

    try {
        self.postMessage({ type: 'transcribing' });

        const result = await transcriber(audioData, {
            chunk_length_s: 30,
            stride_length_s: 5,
            return_timestamps: false
        });

        inferenceCount++;

        self.postMessage({
            type: 'result',
            text: result.text.trim()
        });

        // Check if we need to reinitialize to work around memory leak
        if (inferenceCount >= MAX_INFERENCES_BEFORE_REINIT) {
            console.log(`[whisper-worker] Reinitializing after ${inferenceCount} inferences (memory leak workaround)`);
            // We don't reinit here - just flag it. The service can decide.
            self.postMessage({ type: 'reinit_recommended' });
        }

    } catch (error) {
        self.postMessage({ type: 'error', error: error.message });
    }
}

/**
 * Unload the model to free memory
 */
function unload() {
    transcriber = null;
    inferenceCount = 0;
    self.postMessage({ type: 'unloaded' });
}

// Message handler
self.onmessage = async (event) => {
    const { type, ...data } = event.data;

    switch (type) {
        case 'load':
            await loadModel(data);
            break;
        case 'transcribe':
            await transcribe(data.audio);
            break;
        case 'unload':
            unload();
            break;
        default:
            console.warn(`[whisper-worker] Unknown message type: ${type}`);
    }
};
