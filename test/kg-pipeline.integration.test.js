/**
 * KG pipeline integration tests
 *
 * These tests run KGController against fake-indexeddb storage and a mocked
 * llmClient/embeddingProvider. They cover the cross-module contracts that
 * unit tests can't observe end-to-end:
 *   - Phase 5 item 8: cross-chapter resolution (one node id, contexts grow)
 *   - Phase 5 item 9: rebuilding the same chapter does NOT double edges
 *   - Phase 5 item 10: bad-JSON resilience reaches DONE state with partial graph
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Per-string deterministic unit embedding (so distinct entity names → distinct
// embeddings, identical names → identical embeddings).
function fakeEmbedding(text) {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
    const v = Float32Array.from([
        Math.sin(h),
        Math.cos(h),
        Math.sin(h * 1.7),
        Math.cos(h * 2.3)
    ]);
    let n = 0;
    for (const x of v) n += x * x;
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= n;
    return v;
}

vi.mock('../js/services/llm-client.js', () => {
    const complete = vi.fn();
    const setBackend = vi.fn();
    const getBackend = vi.fn(() => 'openrouter');
    const getProvider = vi.fn(() => ({
        parseJSON: (s) => JSON.parse(
            s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
        )
    }));
    return { llmClient: { complete, setBackend, getBackend, getProvider } };
});

vi.mock('../js/services/embedding-provider.js', () => {
    const inst = {
        onProgress: null,
        load: vi.fn(),
        embed: vi.fn(async (texts) => texts.map((t) => fakeEmbedding(t))),
        setSource: vi.fn(),
        setModel: vi.fn(),
        setLocalModel: vi.fn(),
        setCloudModel: vi.fn(),
        setApiKey: vi.fn(),
        setCloudEndpoint: vi.fn(),
        setTransformersVersion: vi.fn(),
        unload: vi.fn(),
        isReady: vi.fn(() => true),
        getSource: vi.fn(() => 'openrouter')
    };
    inst.load.mockResolvedValue();
    return { embeddingProvider: inst };
});

import { KGController, KG_STATE } from '../js/controllers/kg-controller.js';
import { storage } from '../js/services/storage.js';
import { llmClient } from '../js/services/llm-client.js';
import { embeddingProvider } from '../js/services/embedding-provider.js';

const settings = {
    kgExtractionBackend: 'openrouter',
    kgChunkSize: 4,
    kgChunkOverlap: 1,
    kgSimilarityThreshold: 0.5
};

beforeEach(async () => {
    await storage.init();
    llmClient.complete.mockReset();
    llmClient.getBackend.mockReturnValue('openrouter');
    embeddingProvider.embed.mockClear();
});

describe('KG pipeline integration', () => {
    it('cross-chapter resolution: Arthur in ch0 and ch1 share one node id with growing aliases and contexts', async () => {
        // Per-call response: chapter index dictates which response is returned.
        const ch0 = JSON.stringify({
            entities: [
                { name: 'Arthur', type: 'PERSON', aliases: ['the king'], bloom: 'Remember' },
                { name: 'sword', type: 'OBJECT', aliases: [], bloom: 'Remember' }
            ],
            relations: [{ source: 'Arthur', target: 'sword', relation: 'drew' }]
        });
        const ch1 = JSON.stringify({
            entities: [
                { name: 'Arthur', type: 'PERSON', aliases: ['the boy king'], bloom: 'Understand' }
            ],
            relations: []
        });
        // First call(s) are for chapter 0; later ones for chapter 1.
        // Using mockImplementation so any number of chunks can be served.
        let call = 0;
        const responses = { 0: ch0, 1: ch1 };
        llmClient.complete.mockImplementation(async () => {
            // Keep returning the active-chapter response until the test re-points.
            const r = responses[chapterCursor];
            call++;
            return r;
        });

        let chapterCursor = 0;
        const book = {
            id: 'b1',
            chapters: [
                { sentences: ['Arthur drew the sword.', 'It glowed.', 'He smiled.'] },
                { sentences: ['Arthur returned home.', 'The crowd cheered.'] }
            ]
        };
        await storage.saveBook(book);
        const ctrl = new KGController({ getSettings: () => settings, getBook: () => book });

        chapterCursor = 0;
        await ctrl.buildChapterGraph(0);
        chapterCursor = 1;
        await ctrl.buildChapterGraph(1);

        const nodes = await storage.getKGNodesForBook('b1');
        const arthurNodes = nodes.filter((n) => n.canonicalName.toLowerCase() === 'arthur');
        expect(arthurNodes).toHaveLength(1);

        const arthur = arthurNodes[0];
        expect(arthur.contexts.map((c) => c.chapterIndex).sort()).toEqual([0, 1]);
        // Both alias batches should have accumulated; the canonical name itself never as alias
        expect(arthur.aliases).toEqual(expect.arrayContaining(['the king', 'the boy king']));
        expect(arthur.aliases).not.toContain('Arthur');

        // Both chapters should be marked processed
        expect(book.chapters[0].kgProcessed).toBe(true);
        expect(book.chapters[1].kgProcessed).toBe(true);
        expect(call).toBeGreaterThan(0);
    });

    it('clicking the build button on an already-processed chapter is a no-op (skip path)', async () => {
        llmClient.complete.mockResolvedValue(JSON.stringify({
            entities: [
                { name: 'Arthur', type: 'PERSON', aliases: [], bloom: 'Remember' },
                { name: 'sword', type: 'OBJECT', aliases: [], bloom: 'Remember' }
            ],
            relations: [{ source: 'Arthur', target: 'sword', relation: 'drew' }]
        }));
        const book = {
            id: 'b1',
            chapters: [{ sentences: ['Arthur drew the sword.', 'It glowed.', 'He smiled.'] }]
        };
        await storage.saveBook(book);
        const ctrl = new KGController({ getSettings: () => settings, getBook: () => book });

        await ctrl.buildChapterGraph(0);
        expect(book.chapters[0].kgProcessed).toBe(true);
        const completeCallsAfterFirst = llmClient.complete.mock.calls.length;

        // Second click should hit the skip-on-processed short-circuit.
        await ctrl.buildChapterGraph(0);
        expect(llmClient.complete.mock.calls.length).toBe(completeCallsAfterFirst);
    });

    it('force rebuild dedupes edges via the resolver (no doubling)', async () => {
        llmClient.complete.mockResolvedValue(JSON.stringify({
            entities: [
                { name: 'Arthur', type: 'PERSON', aliases: [], bloom: 'Remember' },
                { name: 'sword', type: 'OBJECT', aliases: [], bloom: 'Remember' }
            ],
            relations: [{ source: 'Arthur', target: 'sword', relation: 'drew' }]
        }));
        const book = {
            id: 'b1',
            chapters: [{ sentences: ['Arthur drew the sword.', 'It glowed.', 'He smiled.'] }]
        };
        await storage.saveBook(book);
        const ctrl = new KGController({ getSettings: () => settings, getBook: () => book });

        await ctrl.buildChapterGraph(0);
        const edgesAfterFirst = await storage.getKGEdgesForBook('b1');
        expect(edgesAfterFirst).toHaveLength(1);

        // Force rebuild: the resolver's edge dedup must keep the count at 1.
        await ctrl.buildChapterGraph(0, { force: true });
        const edgesAfterSecond = await storage.getKGEdgesForBook('b1');
        expect(edgesAfterSecond).toHaveLength(1);
        expect(edgesAfterSecond[0].id).toBe(edgesAfterFirst[0].id);

        // Nodes likewise stay at 2 (Arthur + sword), no duplicates
        const nodes = await storage.getKGNodesForBook('b1');
        expect(nodes).toHaveLength(2);
    });

    it('bad-JSON resilience: one malformed chunk does not crash the chapter; pipeline reaches DONE with partial graph', async () => {
        llmClient.complete
            .mockResolvedValueOnce('not valid json{{')   // chunk 0 dies
            .mockResolvedValue(JSON.stringify({          // every later chunk OK
                entities: [{ name: 'Arthur', type: 'PERSON', aliases: [], bloom: 'Remember' }],
                relations: []
            }));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const book = {
            id: 'b1',
            chapters: [{
                sentences: [
                    'Sentence one.', 'Sentence two.', 'Sentence three.',
                    'Sentence four.', 'Sentence five.', 'Sentence six.',
                    'Sentence seven.'
                ]
            }]
        };
        await storage.saveBook(book);
        const ctrl = new KGController({ getSettings: () => settings, getBook: () => book });
        await ctrl.buildChapterGraph(0);

        expect(ctrl.state).toBe(KG_STATE.DONE);
        const nodes = await storage.getKGNodesForBook('b1');
        // Partial graph should at least contain Arthur from a later chunk
        expect(nodes.map((n) => n.canonicalName)).toContain('Arthur');
        warn.mockRestore();
    });
});
