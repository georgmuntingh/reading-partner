/**
 * MediaPipe LLM Provider
 * Implements the LLMProvider interface using @mediapipe/tasks-genai
 * (LlmInference with WebGPU) running in a Web Worker.
 *
 * Model: Gemma3-1B-IT with default 4-bit (int4) quantization
 * Source: litert-community/Gemma3-1B-IT on HuggingFace (gated)
 *
 * The model is ~600 MB and is cached in the browser's Origin Private
 * File System (OPFS) after the first download, enabling offline use.
 */

import { LLMProvider } from './llm-provider.js';

// The single supported model — Gemma3-1B-IT int4 as a MediaPipe .task bundle
export const MEDIAPIPE_LLM_MODEL = {
    id: 'gemma3-1b-it-int4',
    name: 'Gemma3 1B IT (int4, WebGPU)',
    size: '~600 MB',
    url: 'https://huggingface.co/litert-community/Gemma3-1B-IT/resolve/main/gemma3-1b-it-int4.task',
    requiresToken: true,
    description:
        'Google Gemma 3 1B Instruct, 4-bit quantized for on-device WebGPU inference via MediaPipe.'
};

export class MediaPipeLLMProvider extends LLMProvider {
    constructor() {
        super();
        this._worker = null;
        this._isReady = false;
        this._isLoading = false;
        this._hfToken = null;

        /** @type {((progress: Object) => void) | null} */
        this.onModelProgress = null;
    }

    // ========== Model Management ==========

    setHfToken(token) {
        this._hfToken = token || null;
    }

    getHfToken() {
        return this._hfToken;
    }

    isModelReady() {
        return this._isReady;
    }

    isModelLoading() {
        return this._isLoading;
    }

    async isAvailable() {
        return this._isReady;
    }

    /**
     * Check whether the model is already cached in OPFS (no download needed).
     * @returns {Promise<boolean>}
     */
    async isModelCached() {
        return new Promise((resolve) => {
            const worker = this._getOrCreateWorker();

            const handler = (event) => {
                if (event.data.type === 'cache_status') {
                    worker.removeEventListener('message', handler);
                    resolve(event.data.cached);
                }
            };
            worker.addEventListener('message', handler);
            worker.postMessage({ type: 'check_cache' });
        });
    }

    /**
     * Load the model (downloading from HuggingFace if not cached).
     * @returns {Promise<void>}
     */
    async loadModel() {
        if (this._isReady) return;
        if (this._isLoading) {
            return new Promise((resolve, reject) => {
                const check = setInterval(() => {
                    if (this._isReady) { clearInterval(check); resolve(); }
                    else if (!this._isLoading) { clearInterval(check); reject(new Error('Model loading failed')); }
                }, 100);
            });
        }

        this._isLoading = true;

        return new Promise((resolve, reject) => {
            const worker = this._getOrCreateWorker();

            const handler = (event) => {
                const { type, ...data } = event.data;

                if (type === 'loading') {
                    this.onModelProgress?.(data.progress);
                } else if (type === 'ready') {
                    worker.removeEventListener('message', handler);
                    this._isReady = true;
                    this._isLoading = false;
                    resolve();
                } else if (type === 'error' && this._isLoading) {
                    worker.removeEventListener('message', handler);
                    this._isLoading = false;
                    reject(new Error(data.error));
                }
            };

            worker.addEventListener('message', handler);

            worker.postMessage({
                type: 'load',
                modelUrl: MEDIAPIPE_LLM_MODEL.url,
                hfToken: this._hfToken
            });
        });
    }

    /**
     * Destroy the LlmInference instance to free GPU memory.
     */
    unloadModel() {
        if (this._worker) {
            this._worker.postMessage({ type: 'unload' });
            this._isReady = false;
        }
    }

    /**
     * Terminate the worker entirely.
     */
    destroy() {
        if (this._worker) {
            this._worker.terminate();
            this._worker = null;
        }
        this._isReady = false;
        this._isLoading = false;
    }

    /**
     * Delete the cached model file from OPFS to reclaim disk space.
     * @returns {Promise<void>}
     */
    async clearModelCache() {
        return new Promise((resolve) => {
            const worker = this._getOrCreateWorker();
            const handler = (event) => {
                if (event.data.type === 'cache_cleared') {
                    worker.removeEventListener('message', handler);
                    resolve();
                }
            };
            worker.addEventListener('message', handler);
            worker.postMessage({ type: 'clear_cache' });
        });
    }

    /**
     * Signal the worker to stop forwarding tokens after the current one.
     * MediaPipe does not support true mid-stream cancellation; tokens are
     * drained silently and the generate promise resolves as 'aborted'.
     */
    abort() {
        this._worker?.postMessage({ type: 'abort' });
    }

    // ========== Private: Worker ==========

    _getOrCreateWorker() {
        if (!this._worker) {
            // IMPORTANT: MediaPipe's genai_bundle.cjs internally calls importScripts()
            // for WASM loading. importScripts() is only available in classic (non-module)
            // workers. Do NOT pass { type: 'module' } here.
            this._worker = new Worker(
                new URL('../workers/mediapipe-llm-worker.js', import.meta.url)
            );

            this._worker.onerror = (error) => {
                this._isLoading = false;
                console.error('[MediaPipeLLMProvider] Worker error:', error.message);
            };
        }
        return this._worker;
    }

    // ========== Private: Generation ==========

    /**
     * Send messages to the worker and collect streamed tokens.
     * @param {Object[]} messages  [{role, content}]
     * @param {Object} [options]
     * @param {(chunk: string) => void} [onChunk]
     * @param {(sentence: string) => void} [onSentence]
     * @returns {Promise<string>}
     */
    async _generate(messages, options = {}, onChunk, onSentence) {
        if (!this._isReady) {
            await this.loadModel();
        }

        return new Promise((resolve, reject) => {
            let fullText = '';
            let sentenceBuffer = '';

            const handler = (event) => {
                const { type, ...data } = event.data;

                switch (type) {
                    case 'token': {
                        fullText += data.token;
                        sentenceBuffer += data.token;
                        onChunk?.(data.token);

                        if (onSentence) {
                            const { complete, remaining } = this._extractCompleteSentences(sentenceBuffer);
                            for (const sentence of complete) onSentence(sentence);
                            sentenceBuffer = remaining;
                        }
                        break;
                    }
                    case 'complete':
                        this._worker.removeEventListener('message', handler);
                        if (onSentence && sentenceBuffer.trim()) {
                            onSentence(sentenceBuffer.trim());
                        }
                        resolve(data.text || fullText);
                        break;
                    case 'aborted':
                        this._worker.removeEventListener('message', handler);
                        resolve(data.text || fullText);
                        break;
                    case 'error':
                        this._worker.removeEventListener('message', handler);
                        reject(new Error(data.error));
                        break;
                }
            };

            this._getOrCreateWorker().addEventListener('message', handler);

            this._worker.postMessage({
                type: 'generate',
                messages
            });
        });
    }

    // ========== LLMProvider Interface ==========

    _buildSystemPrompt(bookMeta) {
        let prompt = `You are a helpful reading assistant.`;
        if (bookMeta?.title) {
            prompt += ` The user is reading "${bookMeta.title}"`;
            if (bookMeta.author) prompt += ` by ${bookMeta.author}`;
            prompt += `.`;
        }
        prompt += ` Answer based on the provided context. Be concise.`;
        return prompt;
    }

    _buildUserMessage(contextSentences, question) {
        const contextText = contextSentences.join(' ');
        return `Context: "${contextText}"\n\nQuestion: ${question}`;
    }

    async askQuestion(contextSentences, question, bookMeta) {
        const messages = [
            { role: 'system', content: this._buildSystemPrompt(bookMeta) },
            { role: 'user', content: this._buildUserMessage(contextSentences, question) }
        ];
        return this._generate(messages);
    }

    async askQuestionStreaming(contextSentences, question, onChunk, onSentence, bookMeta, onProgress) {
        const messages = [
            { role: 'system', content: this._buildSystemPrompt(bookMeta) },
            { role: 'user', content: this._buildUserMessage(contextSentences, question) }
        ];
        return this._generate(messages, {}, onChunk, onSentence);
    }

    async lookupWord(options) {
        const { phrase, sentenceContext, targetLanguage = 'auto' } = options;

        const targetLangInstruction = targetLanguage === 'auto'
            ? `If the phrase is in a foreign language, translate to English. If it's in English, provide the definition in English.`
            : `Define/translate for a ${targetLanguage} speaker.`;

        const systemPrompt = `You are a dictionary assistant. ${targetLangInstruction}
Respond with ONLY valid JSON:
{"phrase":"the phrase","sourceLanguage":"language name","sourceLanguageCode":"code","partOfSpeech":"type or null","pronunciation":"guide or null","definition":"concise definition","translation":"translation or null","exampleSentence":"example or null","domain":"domain or null","notes":"notes or null"}`;

        let userMessage = `Look up: "${phrase}"`;
        if (sentenceContext) userMessage += `\nContext: "${sentenceContext}"`;

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage }
        ];

        const response = await this._generate(messages);

        const parsed = this._parseJSON(response);
        if (!parsed.phrase || !parsed.definition) {
            throw new Error('Missing required fields (phrase, definition)');
        }
        return parsed;
    }

    async generateQuizQuestion(options) {
        const {
            contextSentences,
            isMultipleChoice = true,
            questionTypes = ['factual'],
            previousQuestions = [],
            customSystemPrompt = ''
        } = options;

        const contextText = contextSentences.join(' ');
        const typesList = questionTypes.join(', ');

        let systemPrompt;
        if (customSystemPrompt) {
            systemPrompt = customSystemPrompt;
        } else if (isMultipleChoice) {
            systemPrompt = `Generate a ${typesList} quiz question about the text. Respond with ONLY valid JSON:
{"question":"question text","options":["A","B","C","D"],"correctIndex":0,"explanation":"why"}
Requirements: exactly 4 options, correctIndex 0-3.`;
        } else {
            systemPrompt = `Generate a ${typesList} open-ended question about the text. Respond with ONLY valid JSON:
{"question":"question text"}`;
        }

        if (previousQuestions.length > 0) {
            systemPrompt += `\nDo NOT repeat these questions: ${previousQuestions.map(q => q.question).join('; ')}`;
        }

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Text: "${contextText}"` }
        ];

        const response = await this._generate(messages);

        const parsed = this._parseJSON(response);
        if (!parsed.question) throw new Error('Missing question field');
        if (isMultipleChoice) {
            if (!Array.isArray(parsed.options) || parsed.options.length !== 4) {
                throw new Error('Invalid options (need exactly 4)');
            }
            if (typeof parsed.correctIndex !== 'number') {
                throw new Error('Missing correctIndex');
            }
            if (!parsed.explanation) parsed.explanation = 'No explanation provided.';
        }
        return parsed;
    }

    async streamQuizChat(messages, onChunk, onSentence) {
        return this._generate(messages, {}, onChunk, onSentence);
    }

    async generateText(options) {
        const { description, language, length, format, genre } = options;

        const wordCounts = { short: '~300', medium: '~1000', long: '~3000' };
        const targetWords = wordCounts[length] || wordCounts.medium;
        const maxTokens = length === 'long' ? 4000 : length === 'medium' ? 2000 : 800;

        const genreStr = genre && genre !== 'none' ? ` in the style of ${genre}` : '';

        const systemPrompt = `Generate a ${format} text in ${language}, ${targetWords} words${genreStr}. Respond with ONLY valid JSON:
{"title":"title in ${language}","content":"the full ${format} content"}`;

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Write about: ${description}` }
        ];

        const response = await this._generate(messages, { maxTokens });

        const parsed = this._parseJSON(response);
        if (!parsed.title || !parsed.content) {
            throw new Error('Missing required fields (title, content)');
        }
        return { title: parsed.title, content: parsed.content };
    }
}
