/**
 * LLM Client for OpenRouter
 * Handles streaming chat completions for Q&A mode
 */

// Popular OpenRouter models - free models first, then paid
export const OPENROUTER_MODELS = {
    free: [
        { id: 'openai/gpt-oss-120b:free', name: 'GPT OSS 120B (Free)' },
        { id: 'google/gemma-3-27b-it:free', name: 'Gemma 3 27B (Free)' },
        { id: 'nvidia/nemotron-3-nano-30b-a3b:free', name: 'Nemotron 3 Nano 30B (Free)' },
        { id: 'xiaomi/mimo-v2-flash:free', name: 'MiMo V2 Flash (Free)' },
        { id: 'z-ai/glm-4.5-air:free', name: 'GLM 4.5 Air (Free)' },
    ],
    paid: [
        { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' },
        { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
        { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
        { id: 'anthropic/claude-opus-4', name: 'Claude Opus 4' },
        { id: 'openai/gpt-4o', name: 'GPT-4o' },
        { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' },
        { id: 'deepseek/deepseek-chat', name: 'DeepSeek V3' },
        { id: 'meta-llama/llama-3.1-405b-instruct', name: 'Llama 3.1 405B' },
    ]
};

export const DEFAULT_MODEL = 'openai/gpt-oss-120b:free';

export class LLMClient {
    constructor(apiKey = null, model = DEFAULT_MODEL) {
        this._apiKey = apiKey;
        this._model = model;
        this._endpoint = 'https://openrouter.ai/api/v1/chat/completions';
        this._abortController = null;
    }

    /**
     * Set the API key
     * @param {string} key
     */
    setApiKey(key) {
        this._apiKey = key;
    }

    /**
     * Get the API key
     * @returns {string|null}
     */
    getApiKey() {
        return this._apiKey;
    }

    /**
     * Check if API key is set
     * @returns {boolean}
     */
    hasApiKey() {
        return Boolean(this._apiKey && this._apiKey.trim());
    }

    /**
     * Set the model
     * @param {string} model
     */
    setModel(model) {
        this._model = model;
    }

    /**
     * Get the current model
     * @returns {string}
     */
    getModel() {
        return this._model;
    }

    /**
     * Get all available models
     * @returns {{ free: Array, paid: Array }}
     */
    getAvailableModels() {
        return OPENROUTER_MODELS;
    }

    /**
     * Build system prompt with optional book metadata
     * @param {{ title?: string, author?: string }} [bookMeta]
     * @returns {string}
     */
    _buildSystemPrompt(bookMeta) {
        let prompt = `You are a helpful reading assistant. The user is reading a book`;
        if (bookMeta?.title) {
            prompt += ` titled "${bookMeta.title}"`;
            if (bookMeta.author) {
                prompt += ` by ${bookMeta.author}`;
            }
        }
        prompt += ` and has a question about it. Answer based on the provided context. Be concise and helpful. If the answer cannot be found in the context, say so.`;
        return prompt;
    }

    /**
     * Build user message with context
     * @param {string[]} contextSentences
     * @param {string} question
     * @param {{ title?: string, author?: string }} [bookMeta]
     * @returns {string}
     */
    _buildUserMessage(contextSentences, question, bookMeta) {
        const contextText = contextSentences.join(' ');
        let message = '';
        if (bookMeta?.title) {
            message += `Book: ${bookMeta.title}`;
            if (bookMeta.author) {
                message += ` by ${bookMeta.author}`;
            }
            message += '\n\n';
        }
        message += `Context from the book:\n"${contextText}"\n\nQuestion: ${question}`;
        return message;
    }

    /**
     * Ask a question with context (non-streaming)
     * @param {string[]} contextSentences - Sentences for context
     * @param {string} question - User's question
     * @param {{ title?: string, author?: string }} [bookMeta] - Book metadata
     * @returns {Promise<string>} LLM response
     */
    async askQuestion(contextSentences, question, bookMeta) {
        if (!this._apiKey) {
            throw new Error('API key not set');
        }

        const systemPrompt = this._buildSystemPrompt(bookMeta);
        const userMessage = this._buildUserMessage(contextSentences, question, bookMeta);

        const response = await fetch(this._endpoint, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this._apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': window.location.origin,
                'X-Title': 'Reading Partner'
            },
            body: JSON.stringify({
                model: this._model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userMessage }
                ],
                max_tokens: 500,
                temperature: 0.7
            })
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error?.message || `API error: ${response.status}`);
        }

        const data = await response.json();
        return data.choices[0].message.content;
    }

    /**
     * Ask a question with streaming response
     * @param {string[]} contextSentences - Sentences for context
     * @param {string} question - User's question
     * @param {(chunk: string) => void} onChunk - Callback for each text chunk
     * @param {(sentence: string) => void} onSentence - Callback when a complete sentence is detected
     * @param {{ title?: string, author?: string }} [bookMeta] - Book metadata
     * @returns {Promise<string>} Full response when complete
     */
    async askQuestionStreaming(contextSentences, question, onChunk, onSentence, bookMeta) {
        if (!this._apiKey) {
            throw new Error('API key not set');
        }

        // Create abort controller for cancellation
        this._abortController = new AbortController();

        const systemPrompt = this._buildSystemPrompt(bookMeta);
        const userMessage = this._buildUserMessage(contextSentences, question, bookMeta);

        let response;
        try {
            response = await fetch(this._endpoint, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this._apiKey}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': window.location.origin,
                    'X-Title': 'Reading Partner'
                },
                body: JSON.stringify({
                    model: this._model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userMessage }
                    ],
                    max_tokens: 500,
                    temperature: 0.7,
                    stream: true
                }),
                signal: this._abortController.signal
            });
        } catch (error) {
            if (error.name === 'AbortError') {
                throw new Error('Request aborted');
            }
            throw error;
        }

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error?.message || `API error: ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullResponse = '';
        let sentenceBuffer = '';

        try {
            while (true) {
                const { done, value } = await reader.read();

                if (done) {
                    // Flush any remaining content as final sentence
                    if (sentenceBuffer.trim()) {
                        onSentence?.(sentenceBuffer.trim());
                    }
                    break;
                }

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n');

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6);
                        if (data === '[DONE]') {
                            continue;
                        }

                        try {
                            const parsed = JSON.parse(data);
                            const content = parsed.choices?.[0]?.delta?.content;

                            if (content) {
                                fullResponse += content;
                                sentenceBuffer += content;
                                onChunk?.(content);

                                // Check for complete sentences
                                const sentences = this._extractCompleteSentences(sentenceBuffer);
                                if (sentences.complete.length > 0) {
                                    for (const sentence of sentences.complete) {
                                        onSentence?.(sentence);
                                    }
                                    sentenceBuffer = sentences.remaining;
                                }
                            }
                        } catch (e) {
                            // Ignore parse errors for incomplete JSON
                        }
                    }
                }
            }
        } catch (error) {
            if (error.name === 'AbortError') {
                // Return what we have so far
                return fullResponse;
            }
            throw error;
        } finally {
            this._abortController = null;
        }

        return fullResponse;
    }

    /**
     * Extract complete sentences from a buffer
     * @param {string} text
     * @returns {{ complete: string[], remaining: string }}
     */
    _extractCompleteSentences(text) {
        const complete = [];
        let remaining = text;

        // Pattern for sentence endings
        const sentenceEndPattern = /[.!?]+[\s"')\]]*(?=\s|$)/g;
        let match;
        let lastEnd = 0;

        while ((match = sentenceEndPattern.exec(text)) !== null) {
            const sentenceEnd = match.index + match[0].length;
            const sentence = text.slice(lastEnd, sentenceEnd).trim();
            if (sentence) {
                complete.push(sentence);
            }
            lastEnd = sentenceEnd;
        }

        remaining = text.slice(lastEnd);
        return { complete, remaining };
    }

    /**
     * Abort the current streaming request
     */
    abort() {
        if (this._abortController) {
            this._abortController.abort();
            this._abortController = null;
        }
    }

    /**
     * Validate an API key by making a test request
     * @param {string} apiKey
     * @returns {Promise<boolean>}
     */
    async validateApiKey(apiKey) {
        try {
            const response = await fetch(this._endpoint, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': window.location.origin,
                    'X-Title': 'Reading Partner'
                },
                body: JSON.stringify({
                    model: DEFAULT_MODEL,
                    messages: [
                        { role: 'user', content: 'Hi' }
                    ],
                    max_tokens: 1
                })
            });

            return response.ok;
        } catch (error) {
            console.error('API key validation failed:', error);
            return false;
        }
    }
}

// Export singleton instance
export const llmClient = new LLMClient();
