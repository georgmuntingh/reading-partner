/**
 * LLM Web Worker
 * Runs local LLM inference (SmolLM2, etc.) in a dedicated worker thread.
 * Streams generated tokens back to the main thread via postMessage.
 */

// Model state
let generator = null;
let tokenizer = null;
let isLoading = false;
let isGenerating = false;
let shouldAbort = false;
let currentChatOptions = null;

// Forward unhandled WebGPU device-lost rejections as worker errors
self.addEventListener('unhandledrejection', (event) => {
    const msg = event.reason?.message ?? String(event.reason);
    if (msg.includes('Device') && msg.includes('lost') || msg.includes('mapAsync')) {
        self.postMessage({
            type: 'error',
            error: 'GPU device lost — your GPU may have run out of memory or timed out. Try a smaller model or restart the browser.'
        });
    }
});

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
    const hasWebGPU = await detectWebGPU();
    return hasWebGPU ? 'webgpu' : 'wasm';
}

/**
 * Stateful streaming filter: strips <think>…</think> blocks from token chunks.
 * state = { inThink: boolean, buf: string }
 * Returns the portion that should be emitted to the user.
 */
function filterThink(text, state) {
    let s = state.buf + text;
    state.buf = '';
    let out = '';
    while (s.length > 0) {
        if (state.inThink) {
            const end = s.indexOf('</think>');
            if (end === -1) {
                // Buffer the tail in case '</think>' straddles a chunk boundary
                const keep = Math.min(s.length, 7);
                state.buf = s.slice(s.length - keep);
                s = '';
            } else {
                state.inThink = false;
                // Skip '</think>' and any immediately following newline
                s = s.slice(end + 8).replace(/^\n/, '');
            }
        } else {
            const start = s.indexOf('<think>');
            if (start === -1) {
                // Buffer the tail in case '<think>' straddles a chunk boundary
                const keep = Math.min(s.length, 6);
                out += s.slice(0, s.length - keep);
                state.buf = s.slice(s.length - keep);
                s = '';
            } else {
                out += s.slice(0, start);
                state.inThink = true;
                s = s.slice(start + 7);
            }
        }
    }
    return out;
}

/** Flush any buffered non-think content at end of generation. */
function flushThinkFilter(state) {
    if (state.inThink) { state.buf = ''; return ''; }
    const out = state.buf;
    state.buf = '';
    return out;
}

/**
 * Load the LLM model
 */
async function loadModel(config) {
    if (isLoading) return;
    isLoading = true;

    const {
        model = 'HuggingFaceTB/SmolLM2-360M-Instruct',
        device: requestedDevice = 'auto',
        dtype = 'q4f16',
        chatOptions = null
    } = config;
    currentChatOptions = chatOptions;

    try {
        self.postMessage({ type: 'loading', progress: { status: 'Loading transformers.js library...' } });

        const transformers = await import(
            'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3'
        );

        // Disable local model check
        transformers.env.allowLocalModels = false;

        const device = await resolveDevice(requestedDevice);

        self.postMessage({
            type: 'loading',
            progress: { status: `Loading LLM model (${device}, ${dtype})...` }
        });

        // Load tokenizer separately for chat template support
        tokenizer = await transformers.AutoTokenizer.from_pretrained(model, {
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
        });

        // Load the model
        generator = await transformers.AutoModelForCausalLM.from_pretrained(model, {
            device,
            dtype,
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
        });

        isLoading = false;

        self.postMessage({
            type: 'ready',
            info: { model, device, dtype }
        });

    } catch (error) {
        isLoading = false;
        let msg = error.message ?? String(error);
        if (msg.includes('Aborted')) {
            msg = `Model session failed to start (dtype "${dtype}" may not be supported on this GPU). Try a different model.`;
        } else if (msg.includes('Device') && msg.includes('lost') || msg.includes('mapAsync')) {
            msg = 'GPU device lost while loading the model — your GPU may have run out of memory. Try a smaller model.';
        }
        self.postMessage({ type: 'error', error: msg });
    }
}

/**
 * Generate text from a chat messages array
 */
async function generate(config) {
    if (!generator || !tokenizer) {
        self.postMessage({ type: 'error', error: 'Model not loaded' });
        return;
    }

    if (isGenerating) {
        self.postMessage({ type: 'error', error: 'Already generating' });
        return;
    }

    isGenerating = true;
    shouldAbort = false;

    const {
        messages,
        max_new_tokens = 512,
        temperature = 0.7,
        do_sample = true,
        top_p = 0.9,
        repetition_penalty = 1.1
    } = config;

    try {
        // Extract noThink flag (worker-internal) before spreading into apply_chat_template
        const { noThink, ...templateOptions } = currentChatOptions || {};

        // Qwen3 soft-switch: append /no_think to the last user message so the
        // model skips its <think>…</think> reasoning chain entirely.
        let processedMessages = messages;
        if (noThink) {
            processedMessages = messages.map((m, i) =>
                (i === messages.length - 1 && m.role === 'user')
                    ? { ...m, content: m.content + '\n/no_think' }
                    : m
            );
        }

        // Apply chat template to convert messages to model input
        const inputIds = tokenizer.apply_chat_template(processedMessages, {
            add_generation_prompt: true,
            return_tensor: false,
            ...templateOptions
        });

        // Convert to tensor
        const { Tensor } = await import(
            'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3'
        );

        const inputTensor = new Tensor('int64', BigInt64Array.from(inputIds.map(BigInt)), [1, inputIds.length]);
        const attentionMask = new Tensor('int64', new BigInt64Array(inputIds.length).fill(1n), [1, inputIds.length]);

        // Generate with streaming via callback
        let generatedTokens = [];
        let fullText = '';
        // transformers.js put() receives the full cumulative token sequence
        // (input + all generated so far), so we track how many generated
        // tokens we have already decoded to extract only the new delta.
        let decodedGeneratedCount = 0;

        // Stateful filter that strips <think>…</think> from the stream
        const thinkState = { inThink: false, buf: '' };

        const outputs = await generator.generate({
            input_ids: inputTensor,
            attention_mask: attentionMask,
            max_new_tokens,
            temperature: do_sample ? temperature : 1.0,
            do_sample,
            top_p: do_sample ? top_p : undefined,
            repetition_penalty,
            // Streamer callback: called with the full accumulated sequence each time
            streamer: {
                put(tokenIds) {
                    if (shouldAbort) return;

                    // tokenIds is the full sequence: [input tokens..., generated tokens...]
                    const allTokens = Array.from(tokenIds.flat());

                    // Slice off the input prefix, then take only tokens not yet decoded
                    const generated = allTokens.slice(inputIds.length);
                    const newTokens = generated.slice(decodedGeneratedCount);
                    decodedGeneratedCount += newTokens.length;

                    if (newTokens.length === 0) return;

                    generatedTokens.push(...newTokens);

                    // Decode only the truly new tokens
                    const decoded = tokenizer.decode(newTokens, { skip_special_tokens: true });

                    if (decoded) {
                        const visible = filterThink(decoded, thinkState);
                        if (visible) {
                            fullText += visible;
                            self.postMessage({ type: 'token', token: visible });
                        }
                    }
                },
                end() {
                    // Flush any buffered non-think content at the end of generation
                    const tail = flushThinkFilter(thinkState);
                    if (tail) {
                        fullText += tail;
                        self.postMessage({ type: 'token', token: tail });
                    }
                }
            }
        });

        isGenerating = false;

        if (shouldAbort) {
            self.postMessage({ type: 'aborted', text: fullText });
        } else {
            // Decode the full output for accuracy (in case incremental decode had issues),
            // then strip any residual <think>…</think> blocks.
            const outputIds = outputs.tolist()[0];
            const newTokenIds = outputIds.slice(inputIds.length);
            fullText = tokenizer.decode(newTokenIds, { skip_special_tokens: true });
            fullText = fullText.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();

            self.postMessage({ type: 'complete', text: fullText });
        }

    } catch (error) {
        isGenerating = false;

        // If generation was aborted, don't report as error
        if (shouldAbort) {
            self.postMessage({ type: 'aborted', text: '' });
        } else {
            let msg = error.message ?? String(error);
            if (msg.includes('Device') && msg.includes('lost') || msg.includes('mapAsync')) {
                msg = 'GPU device lost during generation — your GPU may have run out of memory or timed out. Try a smaller model.';
            }
            self.postMessage({ type: 'error', error: msg });
        }
    }
}

/**
 * Abort current generation
 */
function abort() {
    shouldAbort = true;
}

/**
 * Unload the model to free memory
 */
function unload() {
    generator = null;
    tokenizer = null;
    isGenerating = false;
    shouldAbort = false;
    currentChatOptions = null;
    self.postMessage({ type: 'unloaded' });
}

// Message handler
self.onmessage = async (event) => {
    const { type, ...data } = event.data;

    switch (type) {
        case 'load':
            await loadModel(data);
            break;
        case 'generate':
            await generate(data);
            break;
        case 'abort':
            abort();
            break;
        case 'unload':
            unload();
            break;
        default:
            console.warn(`[llm-worker] Unknown message type: ${type}`);
    }
};
