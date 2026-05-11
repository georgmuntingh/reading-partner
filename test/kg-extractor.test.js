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

import { chunkSentences, extractFromChunk, extractFromChunkBatch, KG_EXTRACTION_SYSTEM_PROMPT, KG_BATCH_EXTRACTION_SYSTEM_PROMPT } from '../js/services/kg-extractor.js';
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

describe('extractFromChunkBatch', () => {
    let warnSpy;
    beforeEach(() => {
        llmClient.complete.mockReset();
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    it('returns [] for empty input without calling the LLM', async () => {
        const out = await extractFromChunkBatch([]);
        expect(out).toEqual([]);
        expect(llmClient.complete).not.toHaveBeenCalled();
    });

    it('K=1 falls back to the single-passage prompt (not the batch prompt)', async () => {
        llmClient.complete.mockResolvedValueOnce(JSON.stringify({
            entities: [{ name: 'Arthur', type: 'PERSON', aliases: [], bloom: 'Remember' }],
            relations: []
        }));
        const out = await extractFromChunkBatch(['Arthur drew the sword.']);
        expect(out).toHaveLength(1);
        expect(out[0].entities[0].name).toBe('Arthur');
        // System prompt should be the single-chunk one
        expect(llmClient.complete.mock.calls[0][0].system).toBe(KG_EXTRACTION_SYSTEM_PROMPT);
    });

    it('K>=2 uses the batch prompt and unpacks the passages array in order', async () => {
        llmClient.complete.mockResolvedValueOnce(JSON.stringify({
            passages: [
                { entities: [{ name: 'Arthur', type: 'PERSON', aliases: [], bloom: 'Remember' }], relations: [] },
                { entities: [{ name: 'Excalibur', type: 'OBJECT', aliases: [], bloom: 'Remember' }], relations: [] },
                { entities: [], relations: [] }
            ]
        }));
        const out = await extractFromChunkBatch(['A.', 'B.', 'C.']);
        expect(llmClient.complete).toHaveBeenCalledTimes(1);
        expect(llmClient.complete.mock.calls[0][0].system).toBe(KG_BATCH_EXTRACTION_SYSTEM_PROMPT);
        expect(llmClient.complete.mock.calls[0][0].prompt).toContain('--- Passage 1 ---');
        expect(llmClient.complete.mock.calls[0][0].prompt).toContain('--- Passage 3 ---');
        expect(out).toHaveLength(3);
        expect(out[0].entities[0].name).toBe('Arthur');
        expect(out[1].entities[0].name).toBe('Excalibur');
        expect(out[2].entities).toEqual([]);
    });

    it('returns one null per input chunk when the batch JSON is malformed', async () => {
        llmClient.complete.mockResolvedValueOnce('not even json');
        const out = await extractFromChunkBatch(['A.', 'B.']);
        expect(out).toEqual([null, null]);
        expect(warnSpy).toHaveBeenCalled();
    });

    it('returns one null per input chunk when the network call fails', async () => {
        llmClient.complete.mockRejectedValueOnce(new Error('network down'));
        const out = await extractFromChunkBatch(['A.', 'B.', 'C.']);
        expect(out).toEqual([null, null, null]);
        expect(warnSpy).toHaveBeenCalled();
    });

    it('pads with null when the model returns fewer passages than requested', async () => {
        llmClient.complete.mockResolvedValueOnce(JSON.stringify({
            passages: [
                { entities: [{ name: 'A', type: 'OTHER', aliases: [], bloom: 'Remember' }], relations: [] }
                // missing entries for inputs 2 and 3
            ]
        }));
        const out = await extractFromChunkBatch(['A.', 'B.', 'C.']);
        expect(out[0].entities[0].name).toBe('A');
        expect(out[1]).toBeNull();
        expect(out[2]).toBeNull();
    });

    it('caps maxTokens at maxTokensCap regardless of batch size', async () => {
        llmClient.complete.mockResolvedValueOnce(JSON.stringify({ passages: [{ entities: [], relations: [] }] }));
        await extractFromChunkBatch(['A.', 'B.', 'C.', 'D.', 'E.', 'F.', 'G.', 'H.', 'I.', 'J.', 'K.', 'L.'], { maxTokensPerChunk: 1000, maxTokensCap: 4000 });
        expect(llmClient.complete.mock.calls[0][0].maxTokens).toBe(4000);
    });
});
