import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../js/services/llm-client.js', () => {
    const complete = vi.fn();
    const getProvider = vi.fn(() => ({
        parseJSON: (text) => {
            const cleaned = text.trim()
                .replace(/^```(?:json)?\s*/i, '')
                .replace(/\s*```$/i, '')
                .trim();
            return JSON.parse(cleaned);
        }
    }));
    return {
        llmClient: { complete, getProvider }
    };
});

import { chunkSentences, extractFromChunk, KG_EXTRACTION_SYSTEM_PROMPT } from '../js/services/kg-extractor.js';
import { llmClient } from '../js/services/llm-client.js';

const sentencesOfLength = (n) => Array.from({ length: n }, (_, i) => `S${i}.`);

describe('chunkSentences', () => {
    it('produces non-overlapping chunks when overlap=0', () => {
        const chunks = chunkSentences(sentencesOfLength(10), 4, 0);
        expect(chunks.map((c) => c.sentenceIndices)).toEqual([
            [0, 1, 2, 3],
            [4, 5, 6, 7],
            [8, 9]
        ]);
    });

    it('produces overlapping chunks with the requested overlap', () => {
        const chunks = chunkSentences(sentencesOfLength(10), 4, 2);
        // step = 4 - 2 = 2
        expect(chunks[0].sentenceIndices).toEqual([0, 1, 2, 3]);
        expect(chunks[1].sentenceIndices).toEqual([2, 3, 4, 5]);
        expect(chunks[2].sentenceIndices).toEqual([4, 5, 6, 7]);
        expect(chunks[3].sentenceIndices).toEqual([6, 7, 8, 9]);
    });

    it('does not loop forever when overlap >= chunkSize (clamps step to 1)', () => {
        const chunks = chunkSentences(sentencesOfLength(5), 3, 5);
        // Each chunk should advance the start by at least 1
        const starts = chunks.map((c) => c.sentenceIndices[0]);
        expect(new Set(starts).size).toBe(starts.length);
        expect(chunks.length).toBeLessThanOrEqual(5);
    });

    it('returns an empty array for empty input', () => {
        expect(chunkSentences([], 4, 2)).toEqual([]);
    });

    it('treats invalid input (null/undefined) as empty', () => {
        expect(chunkSentences(null, 4, 2)).toEqual([]);
        expect(chunkSentences(undefined, 4, 2)).toEqual([]);
    });

    it('handles input shorter than chunkSize as a single chunk', () => {
        const chunks = chunkSentences(sentencesOfLength(2), 6, 2);
        expect(chunks).toHaveLength(1);
        expect(chunks[0].sentenceIndices).toEqual([0, 1]);
        expect(chunks[0].text).toBe('S0. S1.');
    });

    it('joins sentences with a single space in chunk.text', () => {
        const chunks = chunkSentences(['Alpha.', 'Beta.', 'Gamma.'], 3, 0);
        expect(chunks[0].text).toBe('Alpha. Beta. Gamma.');
    });
});

describe('extractFromChunk', () => {
    let warnSpy;
    beforeEach(() => {
        llmClient.complete.mockReset();
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    it('parses valid JSON and returns normalized {entities, relations}', async () => {
        llmClient.complete.mockResolvedValueOnce(JSON.stringify({
            entities: [{ name: 'Arthur', type: 'PERSON', aliases: [], bloom: 'Remember' }],
            relations: []
        }));
        const out = await extractFromChunk('Arthur drew the sword.');
        expect(out.entities[0].name).toBe('Arthur');
        expect(out.relations).toEqual([]);
    });

    it('passes the KG system prompt and user passage to llmClient.complete', async () => {
        llmClient.complete.mockResolvedValueOnce('{"entities":[],"relations":[]}');
        await extractFromChunk('hello world');
        expect(llmClient.complete).toHaveBeenCalledTimes(1);
        const args = llmClient.complete.mock.calls[0][0];
        expect(args.system).toBe(KG_EXTRACTION_SYSTEM_PROMPT);
        expect(args.prompt).toContain('hello world');
        expect(args.maxTokens).toBe(800);
        expect(args.temperature).toBe(0.1);
    });

    it('returns null on malformed JSON instead of throwing', async () => {
        llmClient.complete.mockResolvedValueOnce('not json{{');
        const out = await extractFromChunk('text');
        expect(out).toBeNull();
        expect(warnSpy).toHaveBeenCalled();
    });

    it('returns null when llmClient.complete rejects', async () => {
        llmClient.complete.mockRejectedValueOnce(new Error('network'));
        const out = await extractFromChunk('text');
        expect(out).toBeNull();
        expect(warnSpy).toHaveBeenCalled();
    });

    it('coerces missing arrays so callers always see arrays', async () => {
        llmClient.complete.mockResolvedValueOnce('{}');
        const out = await extractFromChunk('text');
        expect(out).toEqual({ entities: [], relations: [] });
    });

    it('returns null when JSON is non-object (e.g. a primitive)', async () => {
        llmClient.complete.mockResolvedValueOnce('"just a string"');
        const out = await extractFromChunk('text');
        expect(out).toBeNull();
    });
});
