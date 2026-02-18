/**
 * Local LLM Provider
 * Implements the LLMProvider interface using a local transformers.js model
 * running in a Web Worker.
 */

import { LLMProvider } from './llm-provider.js';

// Available local models
export const LOCAL_LLM_MODELS = [
    { id: 'HuggingFaceTB/SmolLM2-360M-Instruct', name: 'SmolLM2 360M (Recommended)', size: '~250 MB', dtype: 'q4f16' },
    { id: 'HuggingFaceTB/SmolLM2-135M-Instruct', name: 'SmolLM2 135M (Faster)', size: '~100 MB', dtype: 'q4f16' },
    { id: 'HuggingFaceTB/SmolLM2-1.7B-Instruct', name: 'SmolLM2 1.7B (Better Quality)', size: '~925 MB', dtype: 'q4f16' },
    { id: 'onnx-community/Qwen3-0.6B-ONNX', name: 'Qwen3 0.6B (q8)', size: '~600 MB', dtype: 'q8' },
    { id: 'onnx-community/Qwen3-1.7B-ONNX', name: 'Qwen3 1.7B (q4)', size: '~850 MB', dtype: 'q4' },
    { id: 'onnx-community/Qwen3-4B-ONNX', name: 'Qwen3 4B (q4)', size: '~2 GB', dtype: 'q4' },
];

export const DEFAULT_LOCAL_MODEL = 'HuggingFaceTB/SmolLM2-360M-Instruct';

export class LocalLLMProvider extends LLMProvider {
    constructor() {
        super();
        this._worker = null;
        this._isReady = false;
        this._isLoading = false;
        this._model = DEFAULT_LOCAL_MODEL;
        this._device = 'auto';
        this._dtype = 'q4f16';

        // Model loading progress callback
        this.onModelProgress = null;
    }

    // ========== Model Management ==========

    setModel(modelId) {
        if (modelId !== this._model) {
            this._model = modelId;
            // Update dtype based on model's preferred quantization
            const modelDef = LOCAL_LLM_MODELS.find(m => m.id === modelId);
            if (modelDef?.dtype) this._dtype = modelDef.dtype;
            if (this._isReady) {
                this._isReady = false;
                this._worker?.postMessage({ type: 'unload' });
            }
        }
    }

    getModel() {
        return this._model;
    }

    setDevice(device) {
        this._device = device;
    }

    getAvailableModels() {
        return LOCAL_LLM_MODELS;
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
     * Load the model in the worker
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
            this._worker = new Worker(
                new URL('../workers/llm-worker.js', import.meta.url),
                { type: 'module' }
            );

            this._worker.onmessage = (event) => {
                const { type, ...data } = event.data;
                if (type === 'loading') {
                    this.onModelProgress?.(data.progress);
                } else if (type === 'ready') {
                    this._isReady = true;
                    this._isLoading = false;
                    resolve();
                } else if (type === 'error' && this._isLoading) {
                    this._isLoading = false;
                    reject(new Error(data.error));
                }
            };

            this._worker.onerror = (error) => {
                this._isLoading = false;
                reject(new Error(`Worker error: ${error.message}`));
            };

            this._worker.postMessage({
                type: 'load',
                model: this._model,
                device: this._device,
                dtype: this._dtype
            });
        });
    }

    /**
     * Unload the model from memory
     */
    unloadModel() {
        if (this._worker) {
            this._worker.postMessage({ type: 'unload' });
            this._isReady = false;
        }
    }

    /**
     * Destroy the worker
     */
    destroy() {
        if (this._worker) {
            this._worker.terminate();
            this._worker = null;
        }
        this._isReady = false;
        this._isLoading = false;
    }

    abort() {
        this._worker?.postMessage({ type: 'abort' });
    }

    // ========== Internal: Generate with streaming ==========

    /**
     * Send messages to the worker and collect streamed tokens
     * @param {Object[]} messages - Chat messages [{role, content}]
     * @param {Object} options - Generation options
     * @param {(chunk: string) => void} [onChunk]
     * @param {(sentence: string) => void} [onSentence]
     * @returns {Promise<string>} Full generated text
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

                        // Extract complete sentences for TTS
                        if (onSentence) {
                            const sentences = this._extractCompleteSentences(sentenceBuffer);
                            if (sentences.complete.length > 0) {
                                for (const sentence of sentences.complete) {
                                    onSentence(sentence);
                                }
                                sentenceBuffer = sentences.remaining;
                            }
                        }
                        break;
                    }
                    case 'complete':
                        this._worker.removeEventListener('message', handler);
                        // Flush remaining sentence buffer
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

            this._worker.addEventListener('message', handler);

            this._worker.postMessage({
                type: 'generate',
                messages,
                max_new_tokens: options.maxTokens || 512,
                temperature: options.temperature || 0.7,
                do_sample: options.temperature > 0,
                ...options
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

    _buildUserMessage(contextSentences, question, bookMeta) {
        const contextText = contextSentences.join(' ');
        return `Context: "${contextText}"\n\nQuestion: ${question}`;
    }

    async askQuestion(contextSentences, question, bookMeta) {
        const messages = [
            { role: 'system', content: this._buildSystemPrompt(bookMeta) },
            { role: 'user', content: this._buildUserMessage(contextSentences, question, bookMeta) }
        ];
        return this._generate(messages, { maxTokens: 256, temperature: 0.7 });
    }

    async askQuestionStreaming(contextSentences, question, onChunk, onSentence, bookMeta) {
        const messages = [
            { role: 'system', content: this._buildSystemPrompt(bookMeta) },
            { role: 'user', content: this._buildUserMessage(contextSentences, question, bookMeta) }
        ];
        return this._generate(messages, { maxTokens: 256, temperature: 0.7 }, onChunk, onSentence);
    }

    async lookupWord(options) {
        const { phrase, sentenceContext, targetLanguage = 'auto', bookMeta } = options;

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

        const response = await this._generate(messages, { maxTokens: 256, temperature: 0.3 });

        const parsed = this._parseJSON(response);
        if (!parsed.phrase || !parsed.definition) {
            throw new Error('Missing required fields (phrase, definition)');
        }
        return parsed;
    }

    async generateQuizQuestion(options) {
        const {
            contextSentences,
            bookMeta,
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

        const response = await this._generate(messages, { maxTokens: 300, temperature: 0.8 });

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
        return this._generate(messages, { maxTokens: 256, temperature: 0.7 }, onChunk, onSentence);
    }

    async generateText(options) {
        const { description, language, length, format, genre } = options;

        const wordCounts = { short: '~300', medium: '~1000', long: '~3000' };
        const targetWords = wordCounts[length] || wordCounts.medium;
        const maxTokens = length === 'long' ? 4000 : length === 'medium' ? 2000 : 800;

        let genreStr = genre && genre !== 'none' ? ` in the style of ${genre}` : '';

        const systemPrompt = `Generate a ${format} text in ${language}, ${targetWords} words${genreStr}. Respond with ONLY valid JSON:
{"title":"title in ${language}","content":"the full ${format} content"}`;

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Write about: ${description}` }
        ];

        const response = await this._generate(messages, { maxTokens, temperature: 0.8 });

        const parsed = this._parseJSON(response);
        if (!parsed.title || !parsed.content) {
            throw new Error('Missing required fields (title, content)');
        }
        return { title: parsed.title, content: parsed.content };
    }
}
