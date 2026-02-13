/**
 * Lookup Service
 * Orchestrates word/phrase dictionary lookups via LLM, with caching and TTS pronunciation
 */

import { llmClient } from './llm-client.js';
import { storage } from './storage.js';
import { ttsEngine } from './tts-engine.js';

export class LookupService {
    constructor() {
        this._targetLanguage = 'auto';
        this._abortController = null;
    }

    /**
     * Set the target language for translations
     * @param {string} language - 'auto' or a language name like 'English', 'Norwegian', etc.
     */
    setTargetLanguage(language) {
        this._targetLanguage = language;
    }

    /**
     * Get the current target language
     * @returns {string}
     */
    getTargetLanguage() {
        return this._targetLanguage;
    }

    /**
     * Look up a word or phrase. Checks cache first, then queries LLM.
     * @param {Object} options
     * @param {string} options.phrase - The word/phrase to look up
     * @param {string} options.sentenceContext - Surrounding sentence for context
     * @param {string} options.bookId - Current book ID
     * @param {number} options.chapterIndex - Current chapter index
     * @param {number} options.sentenceIndex - Current sentence index
     * @param {{ title?: string, author?: string }} [options.bookMeta] - Book metadata
     * @returns {Promise<Object>} The lookup entry (with id, result, etc.)
     */
    async lookup(options) {
        const { phrase, sentenceContext, bookId, chapterIndex, sentenceIndex, bookMeta } = options;

        // Check cache: same phrase in same book
        const cached = await this._findCachedLookup(bookId, phrase);
        if (cached) {
            // Update timestamp so it appears as most recent
            cached.timestamp = Date.now();
            await storage.saveLookup(cached);
            return cached;
        }

        // Query LLM
        const result = await llmClient.lookupWord({
            phrase,
            sentenceContext,
            targetLanguage: this._targetLanguage,
            bookMeta
        });

        // Build lookup entry
        const entry = {
            id: `lookup_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            bookId,
            chapterIndex,
            sentenceIndex,
            phrase: phrase.trim(),
            context: sentenceContext,
            result,
            timestamp: Date.now()
        };

        // Persist
        await storage.saveLookup(entry);

        return entry;
    }

    /**
     * Pronounce a phrase using TTS with language-appropriate voice
     * @param {string} phrase - Text to pronounce
     * @param {string} langCode - ISO 639-1 language code
     */
    async pronounce(phrase, langCode) {
        const kokoroVoice = ttsEngine.getVoiceForLanguage(langCode);

        if (kokoroVoice && ttsEngine._useKokoro) {
            // Use Kokoro with language-appropriate voice
            const audio = await ttsEngine.synthesize(phrase, {
                voice: kokoroVoice,
                speed: 0.9 // Slightly slower for clarity
            });
            await ttsEngine.playAudio(audio);
        } else if ('speechSynthesis' in window) {
            // Fallback to Web Speech API for unsupported languages
            const utterance = new SpeechSynthesisUtterance(phrase);
            utterance.lang = langCode;
            utterance.rate = 0.9;

            // Try to find a matching voice
            const voices = speechSynthesis.getVoices();
            const match = voices.find(v => v.lang.startsWith(langCode));
            if (match) utterance.voice = match;

            speechSynthesis.speak(utterance);
        }
    }

    /**
     * Get all lookups for the current book
     * @param {string} bookId
     * @returns {Promise<Object[]>}
     */
    async getBookLookups(bookId) {
        return storage.getLookups(bookId);
    }

    /**
     * Get all lookups across all books
     * @returns {Promise<Object[]>}
     */
    async getAllLookups() {
        return storage.getAllLookups();
    }

    /**
     * Delete a lookup entry
     * @param {string} id
     * @returns {Promise<void>}
     */
    async deleteLookup(id) {
        return storage.deleteLookup(id);
    }

    /**
     * Find a cached lookup for the same phrase in the same book
     * @param {string} bookId
     * @param {string} phrase
     * @returns {Promise<Object|null>}
     */
    async _findCachedLookup(bookId, phrase) {
        const lookups = await storage.getLookups(bookId);
        const normalized = phrase.trim().toLowerCase();
        return lookups.find(l => l.phrase.toLowerCase() === normalized) || null;
    }

    /**
     * Abort any in-progress lookup
     */
    abort() {
        llmClient.abort();
    }
}

// Export singleton
export const lookupService = new LookupService();
