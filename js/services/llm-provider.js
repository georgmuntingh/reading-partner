/**
 * LLM Provider Base Class
 * Defines the interface that all LLM providers (OpenRouter, Local) must implement.
 */

export class LLMProvider {
    /**
     * Ask a question with context (non-streaming)
     * @param {string[]} contextSentences
     * @param {string} question
     * @param {{ title?: string, author?: string }} [bookMeta]
     * @returns {Promise<string>}
     */
    async askQuestion(contextSentences, question, bookMeta) {
        throw new Error('Not implemented');
    }

    /**
     * Ask a question with streaming response
     * @param {string[]} contextSentences
     * @param {string} question
     * @param {(chunk: string) => void} onChunk
     * @param {(sentence: string) => void} onSentence
     * @param {{ title?: string, author?: string }} [bookMeta]
     * @returns {Promise<string>}
     */
    async askQuestionStreaming(contextSentences, question, onChunk, onSentence, bookMeta) {
        throw new Error('Not implemented');
    }

    /**
     * Look up a word or phrase
     * @param {Object} options
     * @returns {Promise<Object>}
     */
    async lookupWord(options) {
        throw new Error('Not implemented');
    }

    /**
     * Generate a quiz question
     * @param {Object} options
     * @returns {Promise<Object>}
     */
    async generateQuizQuestion(options) {
        throw new Error('Not implemented');
    }

    /**
     * Stream a quiz chat response
     * @param {Object[]} messages
     * @param {(chunk: string) => void} onChunk
     * @param {(sentence: string) => void} onSentence
     * @returns {Promise<string>}
     */
    async streamQuizChat(messages, onChunk, onSentence) {
        throw new Error('Not implemented');
    }

    /**
     * Generate text content
     * @param {Object} options
     * @returns {Promise<{ title: string, content: string }>}
     */
    async generateText(options) {
        throw new Error('Not implemented');
    }

    /**
     * Validate that this provider is ready to use
     * @returns {Promise<boolean>}
     */
    async isAvailable() {
        throw new Error('Not implemented');
    }

    /**
     * Abort the current request
     */
    abort() {
        // Override in subclass
    }

    /**
     * Extract complete sentences from a text buffer.
     * Shared utility used by both providers.
     * @param {string} text
     * @returns {{ complete: string[], remaining: string }}
     */
    _extractCompleteSentences(text) {
        const complete = [];
        let remaining = text;

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
     * Parse JSON from LLM response, stripping markdown fences if present
     * @param {string} text
     * @returns {Object}
     */
    _parseJSON(text) {
        let cleaned = text.trim();
        cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
        cleaned = cleaned.trim();

        try {
            return JSON.parse(cleaned);
        } catch {
            // Try to extract JSON from surrounding text
            const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[0]);
            }
            throw new Error(`Failed to parse JSON from response`);
        }
    }
}
