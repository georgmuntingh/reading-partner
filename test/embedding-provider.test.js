import { describe, it, expect, vi } from 'vitest';
import { EmbeddingProvider } from '../js/services/embedding-provider.js';

class MockWorker {
    constructor() {
        this.posted = [];
        this.transferLists = [];
        this.terminated = false;
        this.onmessage = null;
        this.onerror = null;
    }
    postMessage(msg, transfer) {
        this.posted.push(msg);
        this.transferLists.push(transfer || null);
    }
    terminate() {
        this.terminated = true;
    }
    // Simulate worker → main messages
    emit(data) {
        this.onmessage?.({ data });
    }
}

/**
 * Build an EmbeddingProvider with the worker pre-injected so we never call
 * the real `load()` (which would try to spawn a Worker from a CDN-imported
 * model). Pending-promise / dispatch wiring is identical to load().
 */
function makeProvider() {
    const ep = new EmbeddingProvider();
    const w = new MockWorker();
    ep._worker = w;
    ep._worker.onmessage = (e) => ep._dispatch(e.data);
    return { ep, w };
}

describe('EmbeddingProvider — message protocol', () => {
    it('forwards loading progress events to onProgress', () => {
        const { ep, w } = makeProvider();
        const onProgress = vi.fn();
        ep.onProgress = onProgress;
        const progress = {
            status: 'Downloading model.onnx',
            file: 'model.onnx',
            loaded: 10,
            total: 100,
            progress: 10
        };
        w.emit({ type: 'loading', progress });
        expect(onProgress).toHaveBeenCalledTimes(1);
        expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({
            file: 'model.onnx',
            loaded: 10,
            total: 100
        }));
    });

    it('does not throw if onProgress is not set', () => {
        const { w } = makeProvider();
        expect(() => w.emit({ type: 'loading', progress: { status: 'x' } })).not.toThrow();
    });

    it('embed() posts a {type:"embed", id, texts} message and tags it with a unique id', async () => {
        const { ep, w } = makeProvider();
        ep._ready = true;
        ep.embed(['a', 'b']);
        ep.embed(['c']);
        expect(w.posted).toHaveLength(2);
        expect(w.posted[0]).toMatchObject({ type: 'embed', texts: ['a', 'b'] });
        expect(w.posted[1]).toMatchObject({ type: 'embed', texts: ['c'] });
        expect(w.posted[0].id).toBeTruthy();
        expect(w.posted[1].id).toBeTruthy();
        expect(w.posted[0].id).not.toBe(w.posted[1].id);
    });

    it('resolves embed() promises by id correlation, even when results arrive out of order', async () => {
        const { ep, w } = makeProvider();
        ep._ready = true;
        const p1 = ep.embed(['a', 'b']);
        const p2 = ep.embed(['c']);
        const id1 = w.posted[0].id;
        const id2 = w.posted[1].id;

        // Resolve p2 first
        w.emit({ type: 'result', id: id2, embeddings: [Float32Array.from([1, 0])] });
        // Then p1
        w.emit({
            type: 'result',
            id: id1,
            embeddings: [Float32Array.from([0.5, 0.5]), Float32Array.from([0.7, 0.7])]
        });

        const r1 = await p1;
        const r2 = await p2;
        expect(r1).toHaveLength(2);
        expect(r2).toHaveLength(1);
        expect(Array.from(r2[0])).toEqual([1, 0]);
        expect(Array.from(r1[0])).toEqual([0.5, 0.5]);
    });

    it('rejects an in-flight embed() when the worker emits an error for that id', async () => {
        const { ep, w } = makeProvider();
        ep._ready = true;
        const p = ep.embed(['x']);
        const id = w.posted[0].id;
        w.emit({ type: 'error', id, error: 'pipeline failed' });
        await expect(p).rejects.toThrow('pipeline failed');
    });

    it('id-less error during load rejects the load promise', async () => {
        const ep = new EmbeddingProvider();
        const w = new MockWorker();
        ep._worker = w;
        ep._worker.onmessage = (e) => ep._dispatch(e.data);
        // Manually populate the load pending entry (mirrors load() internals)
        const loadPromise = new Promise((resolve, reject) => {
            ep._pending.set('__load__', { resolve, reject });
        });
        ep._readyPromise = loadPromise;
        w.emit({ type: 'error', error: 'failed to fetch model' });
        await expect(loadPromise).rejects.toThrow('failed to fetch model');
        expect(ep._ready).toBe(false);
    });

    it('ready event resolves the load promise and flips isReady() to true', async () => {
        const ep = new EmbeddingProvider();
        const w = new MockWorker();
        ep._worker = w;
        ep._worker.onmessage = (e) => ep._dispatch(e.data);
        const loadPromise = new Promise((resolve, reject) => {
            ep._pending.set('__load__', { resolve, reject });
        });
        ep._readyPromise = loadPromise;
        w.emit({ type: 'ready', info: { model: 'Xenova/all-MiniLM-L6-v2' } });
        await loadPromise;
        expect(ep.isReady()).toBe(true);
    });
});

describe('EmbeddingProvider — lifecycle', () => {
    it('embed() before load() lazily kicks off load()', async () => {
        const ep = new EmbeddingProvider();
        const w = new MockWorker();
        const loadSpy = vi.spyOn(ep, 'load').mockImplementation(async () => {
            ep._worker = w;
            ep._worker.onmessage = (e) => ep._dispatch(e.data);
            ep._ready = true;
        });

        const p = ep.embed(['x']);
        // Wait one microtask for embed() to call load() and post the embed message
        await Promise.resolve();
        await Promise.resolve();
        expect(loadSpy).toHaveBeenCalled();
        expect(w.posted[0]).toMatchObject({ type: 'embed', texts: ['x'] });

        // Resolve the embed promise so the test doesn't leak
        w.emit({ type: 'result', id: w.posted[0].id, embeddings: [Float32Array.from([1, 0])] });
        await p;
    });

    it('unload() rejects pending requests and terminates the worker', async () => {
        const { ep, w } = makeProvider();
        ep._ready = true;
        const p = ep.embed(['x']);
        ep.unload();
        await expect(p).rejects.toThrow(/unloaded/i);
        expect(w.terminated).toBe(true);
        expect(ep.isReady()).toBe(false);
    });
});
