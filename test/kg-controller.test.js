import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../js/services/llm-client.js', () => {
    const complete = vi.fn();
    const setBackend = vi.fn();
    const getBackend = vi.fn(() => 'openrouter');
    const getProvider = vi.fn(() => ({
        parseJSON: (s) => JSON.parse(s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim())
    }));
    return { llmClient: { complete, setBackend, getBackend, getProvider } };
});

// Deterministic per-string unit embedding so distinct entity names produce
// distinct embeddings (otherwise cosine resolution would merge them).
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
    // Default load() implementation: emit one progress event then resolve
    inst.load.mockImplementation(async () => {
        inst.onProgress?.({
            status: 'Downloading model.onnx',
            file: 'model.onnx',
            loaded: 5,
            total: 10,
            progress: 50
        });
    });
    return { embeddingProvider: inst };
});

import { KGController, KG_STATE } from '../js/controllers/kg-controller.js';
import { storage } from '../js/services/storage.js';
import { llmClient } from '../js/services/llm-client.js';
import { embeddingProvider } from '../js/services/embedding-provider.js';

const makeBook = () => ({
    id: 'b1',
    chapters: [
        { sentences: ['Arthur drew the sword.', 'It glowed.', 'He smiled.'] }
    ]
});

const baseSettings = {
    kgExtractionBackend: 'openrouter',
    kgChunkSize: 2,
    kgChunkOverlap: 1,
    // Pin existing per-chunk-behaviour tests to K=1 so they keep modelling
    // one LLM call per chunk. The batched path has its own specs further down.
    kgChunksPerRequest: 1,
    kgSimilarityThreshold: 0.5
};

beforeEach(async () => {
    await storage.init();
    llmClient.complete.mockReset();
    llmClient.setBackend.mockReset();
    llmClient.getBackend.mockReset();
    llmClient.getBackend.mockReturnValue('openrouter');
    embeddingProvider.embed.mockClear();
    embeddingProvider.load.mockClear();
    embeddingProvider.setSource.mockClear();
    embeddingProvider.setCloudModel.mockClear();
    embeddingProvider.setLocalModel.mockClear();
    embeddingProvider.setApiKey.mockClear();
});

describe('KGController.buildChapterGraph', () => {
    it('happy path: extracts, embeds, resolves, persists nodes + edges, sets kgProcessed', async () => {
        llmClient.complete.mockResolvedValue(JSON.stringify({
            entities: [
                { name: 'Arthur', type: 'PERSON', aliases: [], bloom: 'Remember' },
                { name: 'sword', type: 'OBJECT', aliases: [], bloom: 'Remember' }
            ],
            relations: [{ source: 'Arthur', target: 'sword', relation: 'drew' }]
        }));
        const book = makeBook();
        await storage.saveBook(book); // so saveBook(kgProcessed) call has a row to update
        const ctrl = new KGController({ getSettings: () => baseSettings, getBook: () => book });
        await ctrl.buildChapterGraph(0);

        const nodes = await storage.getKGNodesForBook('b1');
        const edges = await storage.getKGEdgesForBook('b1');
        expect(nodes.map((n) => n.canonicalName).sort()).toEqual(['Arthur', 'sword']);
        expect(edges).toHaveLength(1);
        expect(edges[0].relation).toBe('drew');
        expect(book.chapters[0].kgProcessed).toBe(true);
        expect(ctrl.state).toBe(KG_STATE.DONE);
    });

    it('forwards embedding-download progress events with stage="embed-load"', async () => {
        llmClient.complete.mockResolvedValue('{"entities":[],"relations":[]}');
        const events = [];
        const book = makeBook();
        await storage.saveBook(book);
        const ctrl = new KGController({ getSettings: () => baseSettings, getBook: () => book });
        ctrl.onProgress = (p) => events.push(p);
        await ctrl.buildChapterGraph(0);
        const embedLoad = events.find((e) => e.stage === 'embed-load');
        expect(embedLoad).toMatchObject({
            stage: 'embed-load',
            file: 'model.onnx',
            loaded: 5,
            total: 10
        });
    });

    it('emits stage="extract" progress per chunk', async () => {
        llmClient.complete.mockResolvedValue('{"entities":[],"relations":[]}');
        const events = [];
        const book = makeBook();
        await storage.saveBook(book);
        const ctrl = new KGController({ getSettings: () => baseSettings, getBook: () => book });
        ctrl.onProgress = (p) => events.push(p);
        await ctrl.buildChapterGraph(0);
        const extractEvents = events.filter((e) => e.stage === 'extract');
        expect(extractEvents.length).toBeGreaterThan(0);
        expect(extractEvents[0]).toMatchObject({ stage: 'extract', current: 1 });
        expect(extractEvents[0].total).toBe(extractEvents.length);
    });

    it('skips a malformed chunk and continues with the next one', async () => {
        llmClient.complete
            .mockResolvedValueOnce('not json{{')
            .mockResolvedValueOnce(JSON.stringify({
                entities: [{ name: 'Arthur', type: 'PERSON', aliases: [], bloom: 'Remember' }],
                relations: []
            }))
            .mockResolvedValue('{"entities":[],"relations":[]}');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const book = makeBook();
        await storage.saveBook(book);
        const ctrl = new KGController({ getSettings: () => baseSettings, getBook: () => book });
        await ctrl.buildChapterGraph(0);
        expect(ctrl.state).toBe(KG_STATE.DONE);
        const nodes = await storage.getKGNodesForBook('b1');
        expect(nodes.map((n) => n.canonicalName)).toContain('Arthur');
        warn.mockRestore();
    });

    it('dedupes a relation that recurs across overlapping chunks into a single edge', async () => {
        llmClient.complete.mockResolvedValue(JSON.stringify({
            entities: [
                { name: 'Arthur', type: 'PERSON', aliases: [], bloom: 'Remember' },
                { name: 'sword', type: 'OBJECT', aliases: [], bloom: 'Remember' }
            ],
            relations: [{ source: 'Arthur', target: 'sword', relation: 'drew' }]
        }));
        const book = makeBook();
        await storage.saveBook(book);
        const ctrl = new KGController({ getSettings: () => baseSettings, getBook: () => book });
        await ctrl.buildChapterGraph(0);
        const edges = await storage.getKGEdgesForBook('b1');
        expect(edges).toHaveLength(1);
    });

    it('switches to the configured extraction backend and restores it afterwards', async () => {
        llmClient.getBackend.mockReturnValue('openrouter');
        llmClient.complete.mockResolvedValue('{"entities":[],"relations":[]}');
        const book = makeBook();
        await storage.saveBook(book);
        const ctrl = new KGController({
            getSettings: () => ({ ...baseSettings, kgExtractionBackend: 'local' }),
            getBook: () => book
        });
        await ctrl.buildChapterGraph(0);
        expect(llmClient.setBackend).toHaveBeenNthCalledWith(1, 'local');
        expect(llmClient.setBackend).toHaveBeenLastCalledWith('openrouter');
    });

    it('does not call setBackend when target backend equals current backend', async () => {
        llmClient.getBackend.mockReturnValue('openrouter');
        llmClient.complete.mockResolvedValue('{"entities":[],"relations":[]}');
        const book = makeBook();
        await storage.saveBook(book);
        const ctrl = new KGController({
            getSettings: () => ({ ...baseSettings, kgExtractionBackend: 'openrouter' }),
            getBook: () => book
        });
        await ctrl.buildChapterGraph(0);
        expect(llmClient.setBackend).not.toHaveBeenCalled();
    });

    it('rejects when called concurrently while another build is running', async () => {
        // First call: pending forever on the first complete()
        llmClient.complete.mockImplementation(() => new Promise(() => {}));
        const book = makeBook();
        await storage.saveBook(book);
        const ctrl = new KGController({ getSettings: () => baseSettings, getBook: () => book });
        // Start first build (do not await — it'll never resolve in this test)
        ctrl.buildChapterGraph(0).catch(() => {});
        // Allow microtasks to flip state to RUNNING
        await Promise.resolve();
        await Promise.resolve();
        await expect(ctrl.buildChapterGraph(0)).rejects.toThrow(/in progress/);
    });

    it('returns early without changing state when chapter has no sentences', async () => {
        const book = { id: 'b1', chapters: [{ sentences: [] }] };
        const ctrl = new KGController({ getSettings: () => baseSettings, getBook: () => book });
        await ctrl.buildChapterGraph(0);
        expect(ctrl.state).toBe(KG_STATE.IDLE);
        expect(llmClient.complete).not.toHaveBeenCalled();
    });

    it('skips when chapter is already kgProcessed and emits a skipped progress event', async () => {
        const events = [];
        const book = {
            id: 'b1',
            chapters: [{ sentences: ['x.', 'y.', 'z.'], kgProcessed: true }]
        };
        await storage.saveBook(book);
        const ctrl = new KGController({ getSettings: () => baseSettings, getBook: () => book });
        ctrl.onProgress = (p) => events.push(p);
        await ctrl.buildChapterGraph(0);

        expect(llmClient.complete).not.toHaveBeenCalled();
        expect(ctrl.state).toBe(KG_STATE.DONE);
        const done = events.find((e) => e.stage === 'done');
        expect(done).toMatchObject({ stage: 'done', skipped: true, chapterIndex: 0 });
    });

    it('force=true overrides kgProcessed and runs the pipeline anyway', async () => {
        llmClient.complete.mockResolvedValue('{"entities":[],"relations":[]}');
        const book = {
            id: 'b1',
            chapters: [{ sentences: ['x.', 'y.', 'z.'], kgProcessed: true }]
        };
        await storage.saveBook(book);
        const ctrl = new KGController({ getSettings: () => baseSettings, getBook: () => book });
        await ctrl.buildChapterGraph(0, { force: true });
        expect(llmClient.complete).toHaveBeenCalled();
        expect(ctrl.state).toBe(KG_STATE.DONE);
    });

    it('configures embeddingProvider with cloud source + cloud model + api key when source=openrouter', async () => {
        llmClient.complete.mockResolvedValue('{"entities":[],"relations":[]}');
        const book = makeBook();
        await storage.saveBook(book);
        const settings = {
            ...baseSettings,
            kgEmbeddingSource: 'openrouter',
            kgCloudEmbeddingModel: 'qwen/qwen3-embedding-4b',
            apiKey: 'sk-fake'
        };
        const ctrl = new KGController({ getSettings: () => settings, getBook: () => book });
        await ctrl.buildChapterGraph(0);
        expect(embeddingProvider.setSource).toHaveBeenCalledWith('openrouter');
        expect(embeddingProvider.setCloudModel).toHaveBeenCalledWith('qwen/qwen3-embedding-4b');
        expect(embeddingProvider.setApiKey).toHaveBeenCalledWith('sk-fake');
        expect(embeddingProvider.setLocalModel).not.toHaveBeenCalled();
    });

    it('configures embeddingProvider with local source + local model when source=local', async () => {
        llmClient.complete.mockResolvedValue('{"entities":[],"relations":[]}');
        const book = makeBook();
        await storage.saveBook(book);
        const settings = {
            ...baseSettings,
            kgEmbeddingSource: 'local',
            kgLocalEmbeddingModel: 'Xenova/bge-small-en-v1.5'
        };
        const ctrl = new KGController({ getSettings: () => settings, getBook: () => book });
        await ctrl.buildChapterGraph(0);
        expect(embeddingProvider.setSource).toHaveBeenCalledWith('local');
        expect(embeddingProvider.setLocalModel).toHaveBeenCalledWith('Xenova/bge-small-en-v1.5');
        expect(embeddingProvider.setCloudModel).not.toHaveBeenCalled();
        expect(embeddingProvider.setApiKey).not.toHaveBeenCalled();
    });

    it('embed: one call per chunk-batch with within-batch unique names (cross-batch dedup is the resolver\'s job)', async () => {
        // With kgChunksPerRequest=1, each chunk is its own batch — so
        // embed() runs once per batch and the resolver dedupes the
        // cross-batch overlap via similarity / exact-name. With a larger
        // kgChunksPerRequest (verified in the test below), all the
        // chunks fold into one batch and one embed call.
        llmClient.complete.mockResolvedValue(JSON.stringify({
            entities: [
                { name: 'Arthur', type: 'PERSON', aliases: [], bloom: 'Remember' },
                { name: 'sword', type: 'OBJECT', aliases: [], bloom: 'Remember' }
            ],
            relations: [{ source: 'Arthur', target: 'sword', relation: 'drew' }]
        }));
        const book = makeBook();
        await storage.saveBook(book);
        const ctrl = new KGController({ getSettings: () => baseSettings, getBook: () => book });
        await ctrl.buildChapterGraph(0);

        // 3-sentence chapter, chunkSize=2 + overlap=1 → 2 chunks, K=1 → 2 batches.
        expect(embeddingProvider.embed).toHaveBeenCalledTimes(2);
        for (const [argTexts] of embeddingProvider.embed.mock.calls) {
            expect(argTexts.slice().sort()).toEqual(['Arthur', 'sword']);
        }
    });

    it('emits stage="embed" with the unique-name count, plus stage="resolve" per chunk', async () => {
        llmClient.complete.mockResolvedValue(JSON.stringify({
            entities: [
                { name: 'Arthur', type: 'PERSON', aliases: [], bloom: 'Remember' },
                { name: 'sword', type: 'OBJECT', aliases: [], bloom: 'Remember' }
            ],
            relations: []
        }));
        const events = [];
        const book = makeBook();
        await storage.saveBook(book);
        const ctrl = new KGController({ getSettings: () => baseSettings, getBook: () => book });
        ctrl.onProgress = (p) => events.push(p);
        await ctrl.buildChapterGraph(0);

        const embed = events.find((e) => e.stage === 'embed');
        expect(embed).toMatchObject({ stage: 'embed', count: 2 });

        const resolveEvents = events.filter((e) => e.stage === 'resolve');
        expect(resolveEvents.length).toBeGreaterThan(0);
        expect(resolveEvents[0]).toMatchObject({ stage: 'resolve', current: 1 });
        expect(resolveEvents[resolveEvents.length - 1].current).toBe(resolveEvents.length);
    });

    it('with kgChunksPerRequest=4 sends 4 chunks per LLM call (1 batched extraction call for 4 chunks)', async () => {
        // 8 sentences with chunkSize=2, overlap=1 → 7 chunks.
        // K=4 → ceil(7/4) = 2 extraction LLM calls.
        const longBook = {
            id: 'b1',
            chapters: [{
                sentences: ['s1.', 's2.', 's3.', 's4.', 's5.', 's6.', 's7.', 's8.']
            }]
        };
        await storage.saveBook(longBook);
        const batchSettings = { ...baseSettings, kgChunksPerRequest: 4 };

        // First batch (4 chunks) → return passages array of length 4
        // Second batch (3 chunks) → return passages array of length 3
        const passagesOf = (n) => JSON.stringify({
            passages: Array.from({ length: n }, () => ({
                entities: [{ name: 'X', type: 'OTHER', aliases: [], bloom: 'Remember' }],
                relations: []
            }))
        });
        llmClient.complete
            .mockResolvedValueOnce(passagesOf(4))
            .mockResolvedValueOnce(passagesOf(3));

        const ctrl = new KGController({ getSettings: () => batchSettings, getBook: () => longBook });
        await ctrl.buildChapterGraph(0);

        expect(llmClient.complete).toHaveBeenCalledTimes(2);
        expect(llmClient.complete.mock.calls[0][0].prompt).toContain('--- Passage 1 ---');
        expect(llmClient.complete.mock.calls[0][0].prompt).toContain('--- Passage 4 ---');
        expect(llmClient.complete.mock.calls[1][0].prompt).toContain('--- Passage 3 ---');
        expect(ctrl.state).toBe(KG_STATE.DONE);
    });

    it('emits batched stage="extract" progress with batchSize=K', async () => {
        const longBook = {
            id: 'b1',
            chapters: [{
                sentences: ['s1.', 's2.', 's3.', 's4.', 's5.', 's6.']
            }]
        };
        await storage.saveBook(longBook);
        const batchSettings = { ...baseSettings, kgChunksPerRequest: 4 };
        const passagesOf = (n) => JSON.stringify({
            passages: Array.from({ length: n }, () => ({ entities: [], relations: [] }))
        });
        llmClient.complete.mockResolvedValue(passagesOf(4));
        const events = [];
        const ctrl = new KGController({ getSettings: () => batchSettings, getBook: () => longBook });
        ctrl.onProgress = (p) => events.push(p);
        await ctrl.buildChapterGraph(0);

        const extractEvents = events.filter((e) => e.stage === 'extract');
        expect(extractEvents.length).toBeGreaterThanOrEqual(1);
        expect(extractEvents[0]).toMatchObject({
            stage: 'extract',
            current: 1,
            batchSize: expect.any(Number)
        });
        // Each event's batchSize must be <= K
        for (const e of extractEvents) {
            expect(e.batchSize).toBeLessThanOrEqual(4);
        }
    });

    it('one bad batch loses K chunks but the rest of the chapter still completes', async () => {
        const longBook = {
            id: 'b1',
            chapters: [{
                sentences: ['s1.', 's2.', 's3.', 's4.', 's5.', 's6.', 's7.']
            }]
        };
        await storage.saveBook(longBook);
        const batchSettings = { ...baseSettings, kgChunksPerRequest: 4 };
        const passagesOf = (n) => JSON.stringify({
            passages: Array.from({ length: n }, () => ({
                entities: [{ name: 'Y', type: 'OTHER', aliases: [], bloom: 'Remember' }],
                relations: []
            }))
        });
        // First batch: malformed JSON; second batch: valid
        llmClient.complete
            .mockResolvedValueOnce('not even json')
            .mockResolvedValueOnce(passagesOf(2));   // however many chunks land here

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const ctrl = new KGController({ getSettings: () => batchSettings, getBook: () => longBook });
        await ctrl.buildChapterGraph(0);
        expect(ctrl.state).toBe(KG_STATE.DONE);
        // Y must be in the graph (from the surviving batch)
        const nodes = await storage.getKGNodesForBook('b1');
        expect(nodes.map((n) => n.canonicalName)).toContain('Y');
        warn.mockRestore();
    });

    it('stores only sentence indices whose text actually mentions the entity (not the whole chunk)', async () => {
        // 6 sentences; only some mention "Arthur" / "sword". With a 6-sentence
        // chunk, the naive implementation saved [0..5] for both entities; the
        // fix should narrow each entity's context to the matching sentences.
        const book = {
            id: 'b1',
            chapters: [{
                sentences: [
                    'Arthur drew the sword.',          // 0 — Arthur + sword
                    'A bird flew overhead.',            // 1 — neither
                    'The crowd gasped in surprise.',    // 2 — neither
                    'Arthur smiled at his companions.', // 3 — Arthur
                    'The sword glowed bright.',         // 4 — sword
                    'Night fell over the field.'        // 5 — neither
                ]
            }]
        };
        await storage.saveBook(book);
        llmClient.complete.mockResolvedValue(JSON.stringify({
            entities: [
                { name: 'Arthur', type: 'PERSON', aliases: [], bloom: 'Remember' },
                { name: 'sword',  type: 'OBJECT', aliases: [], bloom: 'Remember' }
            ],
            relations: [{ source: 'Arthur', target: 'sword', relation: 'drew' }]
        }));
        const settings = { ...baseSettings, kgChunkSize: 6, kgChunkOverlap: 0 };
        const ctrl = new KGController({ getSettings: () => settings, getBook: () => book });
        await ctrl.buildChapterGraph(0);

        const nodes = await storage.getKGNodesForBook('b1');
        const arthur = nodes.find((n) => n.canonicalName === 'Arthur');
        const sword = nodes.find((n) => n.canonicalName === 'sword');
        // Arthur appears in sentences 0 and 3; sword in 0 and 4. The
        // sentence indices stored must match the actual mentions only.
        expect(arthur.contexts[0].sentenceIndices.sort()).toEqual([0, 3]);
        expect(sword.contexts[0].sentenceIndices.sort()).toEqual([0, 4]);

        // The edge "drew" prefers sentences mentioning BOTH endpoints.
        const edges = await storage.getKGEdgesForBook('b1');
        expect(edges).toHaveLength(1);
        expect(edges[0].contexts[0].sentenceIndices).toEqual([0]);
    });

    it('persists the extractor-supplied definition on new nodes (no separate lookup needed)', async () => {
        llmClient.complete.mockResolvedValue(JSON.stringify({
            entities: [
                {
                    name: 'Arthur', type: 'PERSON', aliases: [], bloom: 'Remember',
                    definition: 'Legendary king of the Britons.'
                },
                {
                    name: 'sword', type: 'OBJECT', aliases: [], bloom: 'Remember',
                    definition: 'A long-bladed weapon.'
                }
            ],
            relations: []
        }));
        const lookupDefinition = vi.fn();
        const book = makeBook();
        await storage.saveBook(book);
        const ctrl = new KGController({
            getSettings: () => baseSettings,
            getBook: () => book,
            lookupDefinition
        });
        await ctrl.buildChapterGraph(0);

        const nodes = await storage.getKGNodesForBook('b1');
        const arthur = nodes.find((n) => n.canonicalName === 'Arthur');
        const sword = nodes.find((n) => n.canonicalName === 'sword');
        expect(arthur.definition).toBe('Legendary king of the Britons.');
        expect(sword.definition).toBe('A long-bladed weapon.');
        // The post-pass fallback must NOT fire when definitions are
        // already provided in-band.
        expect(lookupDefinition).not.toHaveBeenCalled();
    });

    it('falls back to lookupDefinition only for nodes whose extractor returned no definition', async () => {
        llmClient.complete.mockResolvedValue(JSON.stringify({
            entities: [
                { name: 'Arthur', type: 'PERSON', aliases: [], bloom: 'Remember', definition: 'King of the Britons.' },
                { name: 'sword',  type: 'OBJECT', aliases: [], bloom: 'Remember' }   // ← no definition
            ],
            relations: []
        }));
        const lookupDefinition = vi.fn(async () => ({ definition: 'A long-bladed weapon.' }));
        const book = makeBook();
        await storage.saveBook(book);
        const ctrl = new KGController({
            getSettings: () => baseSettings,
            getBook: () => book,
            lookupDefinition
        });
        await ctrl.buildChapterGraph(0);

        expect(lookupDefinition).toHaveBeenCalledTimes(1);
        expect(lookupDefinition).toHaveBeenCalledWith('sword');

        const nodes = await storage.getKGNodesForBook('b1');
        expect(nodes.find((n) => n.canonicalName === 'Arthur').definition)
            .toBe('King of the Britons.');
        expect(nodes.find((n) => n.canonicalName === 'sword').definition)
            .toBe('A long-bladed weapon.');
    });

    it('prefetches a definition for each newly-created node via lookupDefinition and persists it', async () => {
        llmClient.complete.mockResolvedValue(JSON.stringify({
            entities: [
                { name: 'Arthur', type: 'PERSON', aliases: [], bloom: 'Remember' },
                { name: 'sword', type: 'OBJECT', aliases: [], bloom: 'Remember' }
            ],
            relations: []
        }));
        const lookupDefinition = vi.fn(async (phrase) => ({
            definition: `Definition of ${phrase}.`
        }));
        const book = makeBook();
        await storage.saveBook(book);
        const ctrl = new KGController({
            getSettings: () => baseSettings,
            getBook: () => book,
            lookupDefinition
        });
        await ctrl.buildChapterGraph(0);

        expect(lookupDefinition).toHaveBeenCalledTimes(2);
        const names = new Set(lookupDefinition.mock.calls.map((c) => c[0]));
        expect(names).toEqual(new Set(['Arthur', 'sword']));

        const nodes = await storage.getKGNodesForBook('b1');
        const arthur = nodes.find((n) => n.canonicalName === 'Arthur');
        const sword = nodes.find((n) => n.canonicalName === 'sword');
        // Definitions are stored as plain strings (the post-pass flattens
        // the lookupService `{definition,...}` shape into a string).
        expect(arthur.definition).toBe('Definition of Arthur.');
        expect(sword.definition).toBe('Definition of sword.');
    });

    it('failing definition lookups are logged + skipped without aborting the build', async () => {
        llmClient.complete.mockResolvedValue(JSON.stringify({
            entities: [
                { name: 'Arthur', type: 'PERSON', aliases: [], bloom: 'Remember' }
            ],
            relations: []
        }));
        const lookupDefinition = vi.fn().mockRejectedValue(new Error('rate limit'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const book = makeBook();
        await storage.saveBook(book);
        const ctrl = new KGController({
            getSettings: () => baseSettings,
            getBook: () => book,
            lookupDefinition
        });
        await ctrl.buildChapterGraph(0);
        expect(ctrl.state).toBe(KG_STATE.DONE);
        const nodes = await storage.getKGNodesForBook('b1');
        expect(nodes).toHaveLength(1);
        // Resolver initialises definition to '' on creation. The post-pass
        // failed, so it stays empty rather than being overwritten.
        expect(nodes[0].definition || '').toBe('');
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    it('only newly-created nodes get a definition fetch (merges with existing nodes do not)', async () => {
        // Seed an existing node so the second observation merges instead
        // of creating.
        const existing = {
            id: 'kgnode_pre', bookId: 'b1', canonicalName: 'Arthur', aliases: [],
            type: 'PERSON', bloom: 'Remember',
            embedding: new Float32Array([1, 0, 0, 0]),
            mergeCount: 1, relevanceScore: null,
            contexts: [{ chapterIndex: 0, sentenceIndices: [0] }],
            firstSeenChapter: 0,
            srs: { ease: 2.5, interval: 0, repetitions: 0, dueAt: 0, lastReviewedAt: null },
            createdAt: 0, updatedAt: 0
        };
        await storage.saveKGNode(existing);

        llmClient.complete.mockResolvedValue(JSON.stringify({
            entities: [
                { name: 'Arthur', type: 'PERSON', aliases: [], bloom: 'Remember' },
                { name: 'sword',  type: 'OBJECT', aliases: [], bloom: 'Remember' }
            ],
            relations: []
        }));
        const lookupDefinition = vi.fn(async (p) => ({ definition: `def(${p})` }));
        const book = makeBook();
        await storage.saveBook(book);
        const ctrl = new KGController({
            getSettings: () => baseSettings,
            getBook: () => book,
            lookupDefinition
        });
        await ctrl.buildChapterGraph(0);

        // sword is new → looked up; Arthur merged → not looked up.
        const calls = lookupDefinition.mock.calls.map((c) => c[0]);
        expect(calls).toEqual(['sword']);
    });

    it('aborts the build with ERROR state when batch embedding fails', async () => {
        llmClient.complete.mockResolvedValue(JSON.stringify({
            entities: [{ name: 'Arthur', type: 'PERSON', aliases: [], bloom: 'Remember' }],
            relations: []
        }));
        embeddingProvider.embed.mockRejectedValueOnce(new Error('cloud blew up'));
        const book = makeBook();
        await storage.saveBook(book);
        const ctrl = new KGController({ getSettings: () => baseSettings, getBook: () => book });
        await expect(ctrl.buildChapterGraph(0)).rejects.toThrow('cloud blew up');
        expect(ctrl.state).toBe(KG_STATE.ERROR);
        // chapter must NOT have been marked processed — user can retry
        expect(book.chapters[0].kgProcessed).toBeUndefined();
    });
});
