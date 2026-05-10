/**
 * KG Extractor
 * Splits chapter text into overlapping sentence chunks and asks the active
 * LLM (via llmClient) to extract entities + relations + Bloom level as JSON.
 *
 * Fault-tolerant by design: a single hallucinated/empty/network-failed chunk
 * MUST NOT crash the chapter pipeline. extractFromChunk returns null on any
 * failure so the controller can log + skip and continue.
 */

import { llmClient } from './llm-client.js';

/**
 * Split a list of sentences into overlapping chunks.
 *
 * @param {string[]} sentences - The chapter's sentences in reading order
 * @param {number} chunkSize - Max sentences per chunk (>=1)
 * @param {number} overlap - Sentences shared between consecutive chunks (>=0)
 * @returns {{ text: string, sentenceIndices: number[] }[]}
 */
export function chunkSentences(sentences, chunkSize, overlap) {
    if (!Array.isArray(sentences) || sentences.length === 0) return [];
    const size = Math.max(1, Math.floor(chunkSize));
    const lap = Math.max(0, Math.floor(overlap));
    // Clamp step to at least 1 so we always make progress (covers overlap >= chunkSize)
    const step = Math.max(1, size - lap);

    const chunks = [];
    for (let start = 0; start < sentences.length; start += step) {
        const end = Math.min(start + size, sentences.length);
        const slice = sentences.slice(start, end);
        const indices = [];
        for (let i = start; i < end; i++) indices.push(i);
        chunks.push({ text: slice.join(' '), sentenceIndices: indices });
        if (end === sentences.length) break;
    }
    return chunks;
}

export const KG_EXTRACTION_SYSTEM_PROMPT = `You are an information-extraction system. Read the passage and return ONLY a JSON object of the form:
{
  "entities": [{ "name": string, "type": "PERSON"|"PLACE"|"OBJECT"|"EVENT"|"CONCEPT"|"OTHER", "aliases": string[], "bloom": "Remember"|"Understand"|"Apply"|"Analyze"|"Evaluate"|"Create" }],
  "relations": [{ "source": string, "target": string, "relation": string }]
}
- "name" must be the canonical surface form as it appears in the text.
- "bloom" is the Bloom's-taxonomy cognitive level a learner needs to engage with this entity.
- "source" and "target" in relations MUST exactly match an entity "name".
- Return strictly valid JSON, no prose, no markdown fences.`;

/**
 * Run the LLM extraction prompt on a single chunk of text.
 * Returns null on any failure (network error, malformed JSON, non-object).
 *
 * @param {string} chunkText
 * @param {Object} [opts]
 * @param {number} [opts.maxTokens=800]
 * @param {number} [opts.temperature=0.1]
 * @returns {Promise<{ entities: Object[], relations: Object[] } | null>}
 */
export async function extractFromChunk(chunkText, opts = {}) {
    const { maxTokens = 800, temperature = 0.1 } = opts;

    let raw;
    try {
        raw = await llmClient.complete({
            system: KG_EXTRACTION_SYSTEM_PROMPT,
            prompt: `Passage:\n${chunkText}`,
            maxTokens,
            temperature
        });
    } catch (err) {
        console.warn('[kg-extractor] LLM call failed:', err?.message ?? String(err));
        return null;
    }

    try {
        const provider = llmClient.getProvider();
        const parsed = provider.parseJSON(raw);
        if (!parsed || typeof parsed !== 'object') throw new Error('Non-object JSON');
        return {
            entities: Array.isArray(parsed.entities) ? parsed.entities : [],
            relations: Array.isArray(parsed.relations) ? parsed.relations : []
        };
    } catch (err) {
        console.warn(
            '[kg-extractor] Bad JSON, skipping chunk:',
            err?.message ?? String(err),
            'raw:',
            typeof raw === 'string' ? raw.slice(0, 200) : raw
        );
        return null;
    }
}
