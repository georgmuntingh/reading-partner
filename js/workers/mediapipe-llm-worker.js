/**
 * MediaPipe LLM Classic Worker
 * Runs LLM inference using @mediapipe/tasks-genai with WebGPU.
 * Streams generated tokens back to the main thread via postMessage.
 *
 * IMPORTANT: This is a CLASSIC (non-module) web worker. It must not use
 * ES module syntax (no import/export statements). MediaPipe internally calls
 * importScripts() for WASM loading, which is only available in classic workers —
 * module workers ({ type: 'module' }) are NOT compatible.
 *
 * Model: Gemma3-1B-IT with default 4-bit (int4) quantization
 * Source: litert-community/Gemma3-1B-IT on HuggingFace (gated)
 * URL: https://huggingface.co/litert-community/Gemma3-1B-IT/resolve/main/gemma3-1b-it-int4.task
 *
 * Model caching: uses the Origin Private File System (OPFS) so the
 * ~600 MB model file is only downloaded once and reused across sessions.
 *
 * NOTE: As of mid-2025 there is a known issue with gemma3-1b-it-int4.task
 * sometimes failing to load in certain browser/driver combinations. If loading
 * fails, check the browser DevTools console and ensure your GPU drivers are up
 * to date, or try a different Chromium-based browser version.
 */

// ========== Load MediaPipe from CDN ==========
// genai_bundle.cjs is a UMD bundle that exposes FilesetResolver and
// LlmInference on the global self object when loaded via importScripts.
importScripts('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-genai/genai_bundle.cjs');

// ========== Worker State ==========

var llmInference = null;
var isLoading = false;
var isGenerating = false;
var shouldAbort = false;

var OPFS_MODEL_FILENAME = 'mediapipe-gemma3-1b-it-int4.task';
var DEFAULT_MODEL_URL =
    'https://huggingface.co/litert-community/Gemma3-1B-IT/resolve/main/gemma3-1b-it-int4.task';
var MEDIAPIPE_WASM_URL =
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-genai/wasm';

// ========== OPFS Helpers ==========

function isModelCached() {
    return navigator.storage.getDirectory().then(function(root) {
        return root.getFileHandle(OPFS_MODEL_FILENAME).then(function() {
            return true;
        }).catch(function() {
            return false;
        });
    }).catch(function() {
        return false;
    });
}

function readModelFromOPFS() {
    return navigator.storage.getDirectory().then(function(root) {
        return root.getFileHandle(OPFS_MODEL_FILENAME);
    }).then(function(fileHandle) {
        return fileHandle.getFile();
    }).then(function(file) {
        return file.arrayBuffer();
    });
}

function writeModelToOPFS(buffer) {
    return navigator.storage.getDirectory().then(function(root) {
        return root.getFileHandle(OPFS_MODEL_FILENAME, { create: true });
    }).then(function(fileHandle) {
        return fileHandle.createWritable();
    }).then(function(writable) {
        return writable.write(buffer).then(function() {
            return writable.close();
        });
    });
}

function deleteModelFromOPFS() {
    return navigator.storage.getDirectory().then(function(root) {
        return root.removeEntry(OPFS_MODEL_FILENAME);
    }).catch(function() {
        // Ignore if not found
    });
}

// ========== Model Download ==========

function downloadModel(url, hfToken) {
    var headers = {};
    if (hfToken) headers['Authorization'] = 'Bearer ' + hfToken;

    return fetch(url, { headers: headers }).then(function(response) {
        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                throw new Error(
                    'Access denied (HTTP ' + response.status + '). ' +
                    'The Gemma3-1B-IT model is gated — you must accept the Gemma licence at ' +
                    'huggingface.co/litert-community/Gemma3-1B-IT and provide a valid ' +
                    'HuggingFace access token in the MediaPipe LLM settings.'
                );
            }
            throw new Error('Download failed: HTTP ' + response.status + ' ' + response.statusText);
        }

        var contentLength = parseInt(response.headers.get('Content-Length') || '0', 10);
        var reader = response.body.getReader();
        var chunks = [];
        var loaded = 0;

        self.postMessage({
            type: 'loading',
            progress: { status: 'Downloading model...', loaded: 0, total: contentLength, progress: 0 }
        });

        function read() {
            return reader.read().then(function(result) {
                if (result.done) return;
                chunks.push(result.value);
                loaded += result.value.length;
                var progress = contentLength > 0 ? (loaded / contentLength) * 100 : 0;
                self.postMessage({
                    type: 'loading',
                    progress: {
                        status: 'Downloading model... ' + Math.round(progress) + '%',
                        loaded: loaded,
                        total: contentLength,
                        progress: progress
                    }
                });
                return read();
            });
        }

        return read().then(function() {
            var totalLength = chunks.reduce(function(sum, c) { return sum + c.length; }, 0);
            var result = new Uint8Array(totalLength);
            var offset = 0;
            chunks.forEach(function(chunk) {
                result.set(chunk, offset);
                offset += chunk.length;
            });
            return result.buffer;
        });
    });
}

// ========== Gemma Chat Template ==========

/**
 * Format chat messages into a Gemma-3 prompt string.
 * Gemma-3 uses:
 *   <start_of_turn>system\n{system}<end_of_turn>\n
 *   <start_of_turn>user\n{user}<end_of_turn>\n
 *   <start_of_turn>model\n
 */
function formatGemmaPrompt(messages) {
    var prompt = '';
    messages.forEach(function(msg) {
        if (msg.role === 'system') {
            prompt += '<start_of_turn>system\n' + msg.content + '<end_of_turn>\n';
        } else if (msg.role === 'user') {
            prompt += '<start_of_turn>user\n' + msg.content + '<end_of_turn>\n';
        } else if (msg.role === 'assistant') {
            prompt += '<start_of_turn>model\n' + msg.content + '<end_of_turn>\n';
        }
    });
    prompt += '<start_of_turn>model\n';
    return prompt;
}

// ========== Model Load ==========

function loadModel(config) {
    if (isLoading) return;
    isLoading = true;

    var modelUrl = config.modelUrl || DEFAULT_MODEL_URL;
    var hfToken = config.hfToken || null;
    var maxTokens = config.maxTokens || 1024;
    var topK = config.topK || 40;
    var temperature = config.temperature || 0.8;
    var randomSeed = config.randomSeed || 101;

    self.postMessage({ type: 'loading', progress: { status: 'Initializing WebGPU runtime...' } });

    // FilesetResolver and LlmInference are on the global scope from importScripts
    var FilesetResolver = self.FilesetResolver;
    var LlmInference = self.LlmInference;

    if (!FilesetResolver || !LlmInference) {
        isLoading = false;
        self.postMessage({ type: 'error', error: 'MediaPipe genai_bundle failed to load. Check your network connection.' });
        return;
    }

    FilesetResolver.forGenAiTasks(MEDIAPIPE_WASM_URL).then(function(genai) {
        return isModelCached().then(function(cached) {
            if (cached) {
                self.postMessage({ type: 'loading', progress: { status: 'Loading cached model from storage...' } });
                return readModelFromOPFS();
            } else {
                self.postMessage({ type: 'loading', progress: { status: 'Downloading model from HuggingFace...' } });
                return downloadModel(modelUrl, hfToken).then(function(buffer) {
                    self.postMessage({ type: 'loading', progress: { status: 'Caching model to local storage...' } });
                    return writeModelToOPFS(buffer).then(function() { return buffer; });
                });
            }
        }).then(function(modelBuffer) {
            self.postMessage({ type: 'loading', progress: { status: 'Initializing LLM (compiling WebGPU shaders)...' } });
            return LlmInference.createFromModelBuffer(genai, modelBuffer, {
                maxTokens: maxTokens,
                topK: topK,
                temperature: temperature,
                randomSeed: randomSeed
            });
        });
    }).then(function(inference) {
        llmInference = inference;
        isLoading = false;
        self.postMessage({ type: 'ready', info: { model: 'gemma3-1b-it-int4', backend: 'mediapipe-webgpu' } });
    }).catch(function(error) {
        isLoading = false;
        // Clean up partial/corrupt cache on failure
        deleteModelFromOPFS().catch(function() {});
        var msg = error.message || String(error);
        if (msg.includes('WebGPU') || msg.toLowerCase().includes('gpu')) {
            msg = 'WebGPU error: ' + msg + '. Make sure you are using a Chromium-based browser with WebGPU enabled.';
        }
        self.postMessage({ type: 'error', error: msg });
    });
}

// ========== Generation ==========

function generate(config) {
    if (!llmInference) {
        self.postMessage({ type: 'error', error: 'Model not loaded' });
        return;
    }
    if (isGenerating) {
        self.postMessage({ type: 'error', error: 'Already generating' });
        return;
    }

    isGenerating = true;
    shouldAbort = false;

    var messages = config.messages;
    var prompt = formatGemmaPrompt(messages);
    var fullText = '';

    llmInference.generateResponse(prompt, function(partialResult, done) {
        if (shouldAbort) {
            if (done) {
                isGenerating = false;
                self.postMessage({ type: 'aborted', text: fullText });
            }
            return;
        }

        if (partialResult) {
            fullText += partialResult;
            self.postMessage({ type: 'token', token: partialResult });
        }

        if (done) {
            isGenerating = false;
            self.postMessage({ type: 'complete', text: fullText });
        }
    });
}

function abort() {
    shouldAbort = true;
}

function unload() {
    if (llmInference) {
        if (typeof llmInference.close === 'function') {
            llmInference.close();
        }
        llmInference = null;
    }
    isGenerating = false;
    shouldAbort = false;
    self.postMessage({ type: 'unloaded' });
}

function clearCache() {
    deleteModelFromOPFS().then(function() {
        self.postMessage({ type: 'cache_cleared' });
    });
}

function checkCache() {
    isModelCached().then(function(cached) {
        self.postMessage({ type: 'cache_status', cached: cached });
    });
}

// ========== Message Handler ==========

self.onmessage = function(event) {
    var type = event.data.type;
    var data = event.data;
    switch (type) {
        case 'load':
            loadModel(data);
            break;
        case 'generate':
            generate(data);
            break;
        case 'abort':
            abort();
            break;
        case 'unload':
            unload();
            break;
        case 'clear_cache':
            clearCache();
            break;
        case 'check_cache':
            checkCache();
            break;
        default:
            console.warn('[mediapipe-llm-worker] Unknown message type: ' + type);
    }
};
