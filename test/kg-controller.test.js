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

    it('batches embed: one embed() call for the whole chapter, with unique names deduped across chunks', async () => {
        // Every chunk returns the same two entities. With chunkSize=2,overlap=1
        // on a 3-sentence chapter we get 2 overlapping chunks, so the same
        // names appear twice. embed() must still be called only once with
        // unique names.
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

        expect(embeddingProvider.embed).toHaveBeenCalledTimes(1);
        const [argTexts] = embeddingProvider.embed.mock.calls[0];
        // Sorted to make the assertion order-independent
        expect(argTexts.slice().sort()).toEqual(['Arthur', 'sword']);
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
