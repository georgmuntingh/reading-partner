/**
 * LM Studio LLM Provider
 *
 * Implements the LLMProvider interface against a local LM Studio server
 * (https://lmstudio.ai). LM Studio exposes an OpenAI-compatible REST API at
 * `${endpoint}/v1/chat/completions`, so the wire format mirrors the
 * OpenRouter provider. Differences:
 *   - No `Authorization` header (LM Studio doesn't require an API key by
 *     default; if the user enables one in their server they can extend
 *     this later)
 *   - Endpoint and model id are user-supplied free-text strings
 *   - On mobile the default 127.0.0.1 won't reach a server on a different
 *     machine, so the user has to enter a LAN address
 */

import { LLMProvider } from './llm-provider.js';

export const DEFAULT_LMSTUDIO_ENDPOINT = 'http://127.0.0.1:1234';
export const DEFAULT_LMSTUDIO_CHAT_MODEL = 'qwen/qwen3.5-35b-a3b';

function joinUrl(base, path) {
    const b = String(base || '').replace(/\/+$/, '');
    const p = String(path || '').replace(/^\/+/, '');
    return `${b}/${p}`;
}

export class LMStudioProvider extends LLMProvider {
    constructor(endpoint = DEFAULT_LMSTUDIO_ENDPOINT, model = DEFAULT_LMSTUDIO_CHAT_MODEL) {
        super();
        this._endpoint = endpoint;
        this._model = model;
        this._abortController = null;
        this._available = false;
        this._chatModels = [];
        this._embeddingModels = [];
    }

    setEndpoint(url) {
        if (url) this._endpoint = url;
    }

    getEndpoint() {
        return this._endpoint;
    }

    setModel(model) {
        if (model) this._model = model;
    }

    getModel() {
        return this._model;
    }

    /** Whether the most recent discovery attempt succeeded. */
    isAvailableSync() {
        return this._available;
    }

    /** Chat-capable model IDs from the most recent discovery (loaded + downloaded). */
    getChatModels() {
        return this._chatModels.slice();
    }

    /** Embedding-capable model IDs from the most recent discovery. */
    getEmbeddingModels() {
        return this._embeddingModels.slice();
    }

    async isAvailable() {
        try {
            const res = await fetch(joinUrl(this._endpoint, '/v1/models'), { method: 'GET' });
            return res.ok;
        } catch {
            return false;
        }
    }

    /**
     * Probe the configured server and return a categorised list of models.
     *
     * LM Studio's `/api/v0/models` endpoint includes a `type` field
     * ("llm" / "vlm" / "embeddings") which lets us route models to the
     * right dropdown. If that endpoint isn't reachable (older LM Studio
     * builds, or another OpenAI-compatible server) we fall back to the
     * OpenAI-compatible `/v1/models` and present the full list to both
     * dropdowns.
     *
     * @param {{ timeoutMs?: number }} [options]
     * @returns {Promise<{ ok: boolean, available: boolean, chatModels: string[], embeddingModels: string[], error?: string }>}
     */
    async discoverModels({ timeoutMs = 2000 } = {}) {
        const result = await this._discover(timeoutMs);
        this._available = result.ok;
        this._chatModels = result.chatModels;
        this._embeddingModels = result.embeddingModels;
        return result;
    }

    async _discover(timeoutMs) {
        const empty = { ok: false, available: false, chatModels: [], embeddingModels: [] };

        // Try LM Studio's typed endpoint first.
        try {
            const data = await this._fetchJSON('/api/v0/models', timeoutMs);
            if (Array.isArray(data?.data) && data.data.length > 0) {
                const chat = [];
                const emb = [];
                for (const m of data.data) {
                    const id = m?.id;
                    if (!id) continue;
                    const type = String(m?.type || '').toLowerCase();
                    if (type === 'embeddings' || type === 'embedding') {
                        emb.push(id);
                    } else {
                        // 'llm', 'vlm', or unknown — treat as chat-capable
                        chat.push(id);
                    }
                }
                return { ok: true, available: true, chatModels: chat, embeddingModels: emb };
            }
        } catch {
            // Fall through to /v1/models
        }

        // OpenAI-compatible fallback. Without `type` we can't categorise, so
        // the same list goes to both dropdowns and the user picks.
        try {
            const data = await this._fetchJSON('/v1/models', timeoutMs);
            if (!Array.isArray(data?.data)) return empty;
            const ids = data.data.map((m) => m?.id).filter(Boolean);
            return { ok: true, available: true, chatModels: ids, embeddingModels: ids };
        } catch (err) {
            return { ...empty, error: err?.message || String(err) };
        }
    }

    async _fetchJSON(path, timeoutMs) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(joinUrl(this._endpoint, path), {
                method: 'GET',
                signal: controller.signal
            });
            if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
            return await res.json();
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Ping the configured server. Used by the settings "Test connection"
     * button. Resolves with { ok, modelCount, error }.
     */
    async testConnection() {
        const r = await this.discoverModels();
        if (!r.ok) return { ok: false, error: r.error || 'Server unreachable' };
        const modelCount = r.chatModels.length + r.embeddingModels.length;
        return {
            ok: true,
            modelCount,
            chatModels: r.chatModels,
            embeddingModels: r.embeddingModels
        };
    }

    abort() {
        if (this._abortController) {
            this._abortController.abort();
            this._abortController = null;
        }
    }

    async _apiCall(messages, options = {}) {
        const { maxTokens = 500, temperature = 0.7, stream = false } = options;
        this._abortController = new AbortController();

        let response;
        try {
            response = await fetch(joinUrl(this._endpoint, '/v1/chat/completions'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this._model,
                    messages,
                    max_tokens: maxTokens,
                    temperature,
                    stream
                }),
                signal: this._abortController.signal
            });
        } catch (error) {
            if (error.name === 'AbortError') throw new Error('Request aborted');
            throw new Error(`Cannot reach LM Studio at ${this._endpoint}: ${error.message}`);
        }

        if (!response.ok) {
            const errBody = await response.text().catch(() => '');
            throw new Error(`LM Studio error ${response.status}: ${errBody || response.statusText}`);
        }

        return response;
    }

    async _streamResponse(response, onChunk, onSentence) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullResponse = '';
        let sentenceBuffer = '';

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    if (sentenceBuffer.trim()) onSentence?.(sentenceBuffer.trim());
                    break;
                }
                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n');

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const data = line.slice(6);
                    if (data === '[DONE]') continue;

                    try {
                        const parsed = JSON.parse(data);
                        const content = parsed.choices?.[0]?.delta?.content;
                        if (!content) continue;
                        fullResponse += content;
                        sentenceBuffer += content;
                        onChunk?.(content);

                        const sentences = this._extractCompleteSentences(sentenceBuffer);
                        if (sentences.complete.length > 0) {
                            for (const sentence of sentences.complete) onSentence?.(sentence);
                            sentenceBuffer = sentences.remaining;
                        }
                    } catch {
                        // Ignore incomplete JSON fragments
                    }
                }
            }
        } catch (error) {
            if (error.name === 'AbortError') return fullResponse;
            throw error;
        } finally {
            this._abortController = null;
        }
        return fullResponse;
    }

    // ========== LLMProvider Interface ==========

    _buildSystemPrompt(bookMeta) {
        let prompt = `You are a helpful reading assistant. The user is reading a book`;
        if (bookMeta?.title) {
            prompt += ` titled "${bookMeta.title}"`;
            if (bookMeta.author) prompt += ` by ${bookMeta.author}`;
        }
        prompt += ` and has a question about it. Answer based on the provided context. Be concise and helpful. If the answer cannot be found in the context, say so.`;
        return prompt;
    }

    _buildUserMessage(contextSentences, question, bookMeta) {
        const contextText = contextSentences.join(' ');
        let message = '';
        if (bookMeta?.title) {
            message += `Book: ${bookMeta.title}`;
            if (bookMeta.author) message += ` by ${bookMeta.author}`;
            message += '\n\n';
        }
        message += `Context from the book:\n"${contextText}"\n\nQuestion: ${question}`;
        return message;
    }

    async askQuestion(contextSentences, question, bookMeta) {
        const response = await this._apiCall(
            [
                { role: 'system', content: this._buildSystemPrompt(bookMeta) },
                { role: 'user', content: this._buildUserMessage(contextSentences, question, bookMeta) }
            ],
            { maxTokens: 500, temperature: 0.7 }
        );
        const data = await response.json();
        return data.choices?.[0]?.message?.content || '';
    }

    async askQuestionStreaming(contextSentences, question, onChunk, onSentence, bookMeta, _onProgress) {
        const response = await this._apiCall(
            [
                { role: 'system', content: this._buildSystemPrompt(bookMeta) },
                { role: 'user', content: this._buildUserMessage(contextSentences, question, bookMeta) }
            ],
            { maxTokens: 500, temperature: 0.7, stream: true }
        );
        return this._streamResponse(response, onChunk, onSentence);
    }

    async lookupWord(options) {
        const { phrase, sentenceContext, targetLanguage = 'auto', bookMeta } = options;

        const targetLangInstruction = targetLanguage === 'auto'
            ? `Determine the most helpful language for the user based on context. If the phrase is in a foreign language, translate to English. If it's in English, provide the definition in English.`
            : `Translate/define for a reader whose native language is ${targetLanguage}.`;

        const systemPrompt = `You are a multilingual dictionary and translation assistant for a reading app. The user has selected a word or phrase while reading.

${targetLangInstruction}

Respond with ONLY a valid JSON object (no markdown fences, no extra text):
{
  "phrase": "the exact phrase looked up",
  "sourceLanguage": "detected source language (e.g. English, Japanese, Norwegian)",
  "sourceLanguageCode": "ISO 639-1 code (e.g. en, ja, no, nl, zh, fr)",
  "partOfSpeech": "noun/verb/adjective/etc. or null if not applicable",
  "pronunciation": "pronunciation guide (IPA or romanization for non-Latin scripts)",
  "definition": "clear, concise definition in the source language",
  "translation": "translation into the target language, or null if source=target",
  "exampleSentence": "a short example sentence using the phrase, or null",
  "domain": "specialized domain if applicable, or null",
  "notes": "any additional useful context, or null"
}`;

        let userMessage = '';
        if (bookMeta?.title) {
            userMessage += `Book: ${bookMeta.title}`;
            if (bookMeta.author) userMessage += ` by ${bookMeta.author}`;
            userMessage += '\n\n';
        }
        userMessage += `Phrase to look up: "${phrase}"`;
        if (sentenceContext) userMessage += `\n\nContext sentence: "${sentenceContext}"`;

        const response = await this._apiCall(
            [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage }
            ],
            { maxTokens: 500, temperature: 0.3 }
        );
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '';

        const parsed = this._parseJSON(content);
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
        } else {
            systemPrompt = `You are a quiz master for reading comprehension. Generate a single quiz question based on the provided book context.\n\nQuestion type(s) to choose from: ${typesList}.`;
            if (previousQuestions.length > 0) {
                systemPrompt += `\n\nIMPORTANT: The user has already been asked ${previousQuestions.length} question(s) in this session. You MUST generate a different question that does not repeat or closely paraphrase any previously asked question.`;
            }
            if (isMultipleChoice) {
                systemPrompt += `\n\nRespond with ONLY a valid JSON object (no markdown fences, no extra text):\n{\n  "question": "the question text",\n  "options": ["option A", "option B", "option C", "option D"],\n  "correctIndex": 0,\n  "explanation": "brief explanation of the correct answer"\n}\n\nRequirements:\n- Exactly 4 options\n- correctIndex is 0-3 indicating the correct option`;
            } else {
                systemPrompt += `\n\nRespond with ONLY a valid JSON object (no markdown fences, no extra text):\n{\n  "question": "the question text"\n}`;
            }
        }

        let userMessage = '';
        if (bookMeta?.title) {
            userMessage += `Book: ${bookMeta.title}`;
            if (bookMeta.author) userMessage += ` by ${bookMeta.author}`;
            userMessage += '\n\n';
        }
        userMessage += `Context from the book:\n"${contextText}"`;
        if (previousQuestions.length > 0) {
            const prevList = previousQuestions.map(q => q.question).join('\n- ');
            userMessage += `\n\nPreviously asked questions (do NOT repeat these):\n- ${prevList}`;
        }

        const response = await this._apiCall(
            [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage }
            ],
            { maxTokens: 500, temperature: 0.8 }
        );
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '';

        const parsed = this._parseJSON(content);
        if (!parsed.question || typeof parsed.question !== 'string') {
            throw new Error('Missing or invalid question field');
        }
        if (isMultipleChoice) {
            if (!Array.isArray(parsed.options) || parsed.options.length !== 4) {
                throw new Error('Missing or invalid options (need exactly 4)');
            }
            if (typeof parsed.correctIndex !== 'number' || parsed.correctIndex < 0 || parsed.correctIndex > 3) {
                throw new Error('Missing or invalid correctIndex (need 0-3)');
            }
            if (!parsed.explanation) parsed.explanation = 'No explanation provided.';
        }
        return parsed;
    }

    async streamQuizChat(messages, onChunk, onSentence) {
        const response = await this._apiCall(messages, { maxTokens: 500, temperature: 0.7, stream: true });
        return this._streamResponse(response, onChunk, onSentence);
    }

    async generateText(options) {
        const { description, language, length, format, genre } = options;

        const wordCounts = { short: '~300', medium: '~1000', long: '~3000' };
        const targetWords = wordCounts[length] || wordCounts.medium;

        let genreInstruction = '';
        if (genre && genre !== 'none') {
            const genreLabels = {
                short_story: 'a short story', essay: 'an essay', news_article: 'a news article',
                childrens_story: "a children's story", technical: 'a technical document',
                blog_post: 'a blog post', letter: 'a letter', poem: 'a poem', dialogue: 'a dialogue'
            };
            genreInstruction = `\nThe genre/style should be: ${genreLabels[genre] || genre}.`;
        }

        const formatInstruction = format === 'html'
            ? `Write the content as valid HTML (do NOT include <html>, <head>, or <body> tags). Use semantic HTML elements like <h1>, <h2>, <p>, <ul>, <ol>, <blockquote>, etc.`
            : `Write the content in Markdown format.`;

        const systemPrompt = `You are a creative text generator for a reading application. Generate a text based on the user's description.\n\n${formatInstruction}\n\nRequirements:\n- Write entirely in ${language}\n- Target length: ${targetWords} words${genreInstruction}\n\nRespond with ONLY a valid JSON object (no markdown fences, no extra text):\n{\n  "title": "a concise, descriptive title in ${language}",\n  "content": "the full ${format} content"\n}`;

        const maxTokens = length === 'long' ? 8000 : length === 'medium' ? 4000 : 1500;

        const response = await this._apiCall(
            [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `Generate a text about: ${description}` }
            ],
            { maxTokens, temperature: 0.8 }
        );
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '';

        const parsed = this._parseJSON(content);
        if (!parsed.title || !parsed.content) {
            throw new Error('Missing required fields (title, content)');
        }
        return { title: parsed.title, content: parsed.content };
    }

    async complete({ prompt, system, maxTokens = 512, temperature = 0.2 } = {}) {
        if (!prompt) throw new Error('complete: prompt is required');
        const messages = [];
        if (system) messages.push({ role: 'system', content: system });
        messages.push({ role: 'user', content: prompt });
        const response = await this._apiCall(messages, { maxTokens, temperature });
        const data = await response.json();
        return data.choices?.[0]?.message?.content || '';
    }
}
