/**
 * OpenRouter LLM Provider
 * Implements the LLMProvider interface for the OpenRouter cloud API.
 * Extracted from the original LLMClient.
 */

import { LLMProvider } from './llm-provider.js';

export const OPENROUTER_MODELS = {
    free: [
        { id: 'openai/gpt-oss-120b:free', name: 'GPT OSS 120B (Free)' },
        { id: 'google/gemma-3-27b-it:free', name: 'Gemma 3 27B (Free)' },
        { id: 'nvidia/nemotron-3-nano-30b-a3b:free', name: 'Nemotron 3 Nano 30B (Free)' },
        { id: 'xiaomi/mimo-v2-flash:free', name: 'MiMo V2 Flash (Free)' },
        { id: 'z-ai/glm-4.5-air:free', name: 'GLM 4.5 Air (Free)' },
    ],
    paid: [
        { id: 'google/gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite' },
        { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini' },
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

export const DEFAULT_MODEL = 'google/gemini-2.5-flash-lite';

export class OpenRouterProvider extends LLMProvider {
    constructor(apiKey = null, model = DEFAULT_MODEL) {
        super();
        this._apiKey = apiKey;
        this._model = model;
        this._endpoint = 'https://openrouter.ai/api/v1/chat/completions';
        this._abortController = null;
    }

    setApiKey(key) {
        this._apiKey = key;
    }

    getApiKey() {
        return this._apiKey;
    }

    hasApiKey() {
        return Boolean(this._apiKey && this._apiKey.trim());
    }

    setModel(model) {
        this._model = model;
    }

    getModel() {
        return this._model;
    }

    getAvailableModels() {
        return OPENROUTER_MODELS;
    }

    async isAvailable() {
        return this.hasApiKey();
    }

    abort() {
        if (this._abortController) {
            this._abortController.abort();
            this._abortController = null;
        }
    }

    // ========== Core API Call ==========

    async _apiCall(messages, options = {}) {
        if (!this._apiKey) throw new Error('API key not set');

        const { maxTokens = 500, temperature = 0.7, stream = false } = options;
        this._abortController = new AbortController();

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
                    messages,
                    max_tokens: maxTokens,
                    temperature,
                    stream
                }),
                signal: this._abortController.signal
            });
        } catch (error) {
            if (error.name === 'AbortError') throw new Error('Request aborted');
            throw error;
        }

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error?.message || `API error: ${response.status}`);
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
                        if (data === '[DONE]') continue;

                        try {
                            const parsed = JSON.parse(data);
                            const content = parsed.choices?.[0]?.delta?.content;

                            if (content) {
                                fullResponse += content;
                                sentenceBuffer += content;
                                onChunk?.(content);

                                const sentences = this._extractCompleteSentences(sentenceBuffer);
                                if (sentences.complete.length > 0) {
                                    for (const sentence of sentences.complete) {
                                        onSentence?.(sentence);
                                    }
                                    sentenceBuffer = sentences.remaining;
                                }
                            }
                        } catch {
                            // Ignore parse errors for incomplete JSON
                        }
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
        const systemPrompt = this._buildSystemPrompt(bookMeta);
        const userMessage = this._buildUserMessage(contextSentences, question, bookMeta);

        const response = await this._apiCall(
            [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage }
            ],
            { maxTokens: 500, temperature: 0.7 }
        );

        const data = await response.json();
        return data.choices[0].message.content;
    }

    async askQuestionStreaming(contextSentences, question, onChunk, onSentence, bookMeta) {
        const systemPrompt = this._buildSystemPrompt(bookMeta);
        const userMessage = this._buildUserMessage(contextSentences, question, bookMeta);

        const response = await this._apiCall(
            [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage }
            ],
            { maxTokens: 500, temperature: 0.7, stream: true }
        );

        return this._streamResponse(response, onChunk, onSentence);
    }

    async lookupWord(options) {
        if (!this._apiKey) throw new Error('API key not set');

        const { phrase, sentenceContext, targetLanguage = 'auto', bookMeta } = options;
        this._abortController = new AbortController();

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
  "pronunciation": "pronunciation guide (IPA or romanization for non-Latin scripts, e.g. furigana for Japanese)",
  "definition": "clear, concise definition in the source language",
  "translation": "translation into the target language, or null if source=target",
  "exampleSentence": "a short example sentence using the phrase, or null",
  "domain": "specialized domain if applicable (e.g. biomedical, legal, computing), or null",
  "notes": "any additional useful context (etymology, usage notes, cultural context), or null"
}

Requirements:
- For Japanese/Chinese: include romanization (romaji/pinyin) in pronunciation
- For technical/biomedical terms: always fill the domain field and give a clear layperson explanation
- Keep definitions concise (1-2 sentences)
- If the phrase is idiomatic, explain the idiomatic meaning`;

        let userMessage = '';
        if (bookMeta?.title) {
            userMessage += `Book: ${bookMeta.title}`;
            if (bookMeta.author) userMessage += ` by ${bookMeta.author}`;
            userMessage += '\n\n';
        }
        userMessage += `Phrase to look up: "${phrase}"`;
        if (sentenceContext) {
            userMessage += `\n\nContext sentence: "${sentenceContext}"`;
        }

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
        if (!this._apiKey) throw new Error('API key not set');

        const {
            contextSentences,
            bookMeta,
            isMultipleChoice = true,
            questionTypes = ['factual'],
            previousQuestions = [],
            customSystemPrompt = ''
        } = options;

        this._abortController = new AbortController();
        const contextText = contextSentences.join(' ');
        const typesList = questionTypes.join(', ');

        let systemPrompt;
        if (customSystemPrompt) {
            systemPrompt = customSystemPrompt;
        } else {
            systemPrompt = `You are a quiz master for reading comprehension. Generate a single quiz question based on the provided book context.\n\nQuestion type(s) to choose from: ${typesList}.`;

            if (previousQuestions.length > 0) {
                systemPrompt += `\n\nIMPORTANT: The user has already been asked ${previousQuestions.length} question(s) in this session. You MUST generate a different question that does not repeat or closely paraphrase any previously asked question. Vary the topic, focus, and angle of your question.`;
            }

            if (isMultipleChoice) {
                systemPrompt += `\n\nRespond with ONLY a valid JSON object (no markdown fences, no extra text):\n{\n  "question": "the question text",\n  "options": ["option A", "option B", "option C", "option D"],\n  "correctIndex": 0,\n  "explanation": "brief explanation of the correct answer"\n}\n\nRequirements:\n- Exactly 4 options\n- correctIndex is 0-3 indicating the correct option\n- Make wrong options plausible but clearly incorrect\n- Keep the explanation concise (1-2 sentences)`;
            } else {
                systemPrompt += `\n\nRespond with ONLY a valid JSON object (no markdown fences, no extra text):\n{\n  "question": "the question text"\n}\n\nRequirements:\n- Ask an open-ended question that requires a thoughtful answer\n- The question should be answerable from the provided context`;
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
        const response = await this._apiCall(messages, {
            maxTokens: 500,
            temperature: 0.7,
            stream: true
        });
        return this._streamResponse(response, onChunk, onSentence);
    }

    async generateText(options) {
        if (!this._apiKey) throw new Error('API key not set');

        const { description, language, length, format, genre } = options;
        this._abortController = new AbortController();

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

        let formatInstruction;
        if (format === 'html') {
            formatInstruction = `Write the content as valid HTML (do NOT include <html>, <head>, or <body> tags — just the inner content starting with headings, paragraphs, etc.). You may use <ruby> tags for furigana where appropriate for Japanese text. Use semantic HTML elements like <h1>, <h2>, <p>, <ul>, <ol>, <blockquote>, etc.`;
        } else {
            formatInstruction = `Write the content in Markdown format. Use headings (#, ##), paragraphs, lists, blockquotes, and other Markdown formatting as appropriate.`;
        }

        const systemPrompt = `You are a creative text generator for a reading application. Generate a text based on the user's description.\n\n${formatInstruction}\n\nRequirements:\n- Write entirely in ${language}\n- Target length: ${targetWords} words${genreInstruction}\n- Use section headings to structure longer texts\n- The text should be well-written, engaging, and suitable for reading practice\n\nRespond with ONLY a valid JSON object (no markdown fences, no extra text):\n{\n  "title": "a concise, descriptive title for the text in ${language}",\n  "content": "the full ${format} content of the text"\n}`;

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
                    messages: [{ role: 'user', content: 'Hi' }],
                    max_tokens: 1
                })
            });
            return response.ok;
        } catch {
            return false;
        }
    }
}
