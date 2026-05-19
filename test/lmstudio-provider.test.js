import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    LMStudioProvider,
    DEFAULT_LMSTUDIO_ENDPOINT,
    DEFAULT_LMSTUDIO_CHAT_MODEL
} from '../js/services/lmstudio-provider.js';
import {
    EmbeddingProvider,
    DEFAULT_LMSTUDIO_EMBEDDING_MODEL
} from '../js/services/embedding-provider.js';

describe('LMStudioProvider — defaults', () => {
    it('uses the LM Studio defaults out of the box', () => {
        const p = new LMStudioProvider();
        expect(p.getEndpoint()).toBe(DEFAULT_LMSTUDIO_ENDPOINT);
        expect(p.getEndpoint()).toBe('http://127.0.0.1:1234');
        expect(p.getModel()).toBe(DEFAULT_LMSTUDIO_CHAT_MODEL);
        expect(p.getModel()).toBe('qwen/qwen3.5-35b-a3b');
    });

    it('ignores empty values in setEndpoint/setModel', () => {
        const p = new LMStudioProvider('http://example.test:1234', 'model-a');
        p.setEndpoint('');
        p.setModel('');
        expect(p.getEndpoint()).toBe('http://example.test:1234');
        expect(p.getModel()).toBe('model-a');
    });
});

describe('LMStudioProvider — chat completions', () => {
    let originalFetch;
    beforeEach(() => { originalFetch = globalThis.fetch; });
    afterEach(() => { globalThis.fetch = originalFetch; });

    it('POSTs to <endpoint>/v1/chat/completions with no Authorization header', async () => {
        const p = new LMStudioProvider('http://127.0.0.1:1234/', 'qwen/qwen3.5-35b-a3b');
        const fetchSpy = vi.fn(async () => ({
            ok: true,
            json: async () => ({ choices: [{ message: { content: 'hello' } }] })
        }));
        globalThis.fetch = fetchSpy;

        const out = await p.askQuestion(['ctx'], 'Q?', { title: 'Book', author: 'X' });
        expect(out).toBe('hello');

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, init] = fetchSpy.mock.calls[0];
        // Trailing slash on endpoint must not produce a double slash before /v1
        expect(url).toBe('http://127.0.0.1:1234/v1/chat/completions');
        expect(init.method).toBe('POST');
        expect(init.headers['Content-Type']).toBe('application/json');
        expect(init.headers.Authorization).toBeUndefined();
        const body = JSON.parse(init.body);
        expect(body.model).toBe('qwen/qwen3.5-35b-a3b');
        expect(Array.isArray(body.messages)).toBe(true);
        expect(body.messages[0].role).toBe('system');
        expect(body.messages[1].role).toBe('user');
    });

    it('surfaces a friendly error when the server is unreachable', async () => {
        const p = new LMStudioProvider('http://127.0.0.1:1234');
        globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
        await expect(p.askQuestion(['ctx'], 'Q?')).rejects.toThrow(/Cannot reach LM Studio/);
    });

    it('surfaces a descriptive error on non-2xx responses', async () => {
        const p = new LMStudioProvider();
        globalThis.fetch = vi.fn(async () => ({
            ok: false,
            status: 404,
            statusText: 'Not Found',
            text: async () => 'model not loaded'
        }));
        await expect(p.askQuestion(['ctx'], 'Q?')).rejects.toThrow(/LM Studio error 404/);
    });

    it('complete() round-trips a raw prompt', async () => {
        const p = new LMStudioProvider();
        globalThis.fetch = vi.fn(async () => ({
            ok: true,
            json: async () => ({ choices: [{ message: { content: 'raw response' } }] })
        }));
        const out = await p.complete({ prompt: 'hello world' });
        expect(out).toBe('raw response');
    });
});

describe('LMStudioProvider — testConnection', () => {
    let originalFetch;
    beforeEach(() => { originalFetch = globalThis.fetch; });
    afterEach(() => { globalThis.fetch = originalFetch; });

    it('returns ok with a model count on a healthy server', async () => {
        const p = new LMStudioProvider();
        globalThis.fetch = vi.fn(async () => ({
            ok: true,
            json: async () => ({ data: [{ id: 'qwen/qwen3.5-35b-a3b' }, { id: 'other' }] })
        }));
        const r = await p.testConnection();
        expect(r.ok).toBe(true);
        expect(r.modelCount).toBe(2);
        expect(r.models).toContain('qwen/qwen3.5-35b-a3b');
    });

    it('returns ok=false with an error string when fetch rejects', async () => {
        const p = new LMStudioProvider();
        globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
        const r = await p.testConnection();
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/ECONNREFUSED/);
    });
});

describe('EmbeddingProvider — LM Studio source', () => {
    let originalFetch;
    beforeEach(() => { originalFetch = globalThis.fetch; });
    afterEach(() => { globalThis.fetch = originalFetch; });

    it('default LM Studio embedding model matches the documented identifier', () => {
        expect(DEFAULT_LMSTUDIO_EMBEDDING_MODEL).toBe('text-embedding-bge-large-en-v1.5');
    });

    it('POSTs to <endpoint>/v1/embeddings with the configured model and no auth header', async () => {
        const ep = new EmbeddingProvider();
        ep.setSource('lmstudio');
        ep.setLmstudioEndpoint('http://127.0.0.1:1234');
        ep.setLmstudioModel('text-embedding-bge-large-en-v1.5');

        const fetchSpy = vi.fn(async () => ({
            ok: true,
            json: async () => ({
                data: [
                    { index: 0, embedding: [3, 4] },
                    { index: 1, embedding: [0, 1] }
                ]
            })
        }));
        globalThis.fetch = fetchSpy;

        const out = await ep.embed(['alpha', 'beta']);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, init] = fetchSpy.mock.calls[0];
        expect(url).toBe('http://127.0.0.1:1234/v1/embeddings');
        expect(init.method).toBe('POST');
        expect(init.headers.Authorization).toBeUndefined();
        const body = JSON.parse(init.body);
        expect(body.model).toBe('text-embedding-bge-large-en-v1.5');
        expect(body.input).toEqual(['alpha', 'beta']);

        // L2-normalised
        expect(out[0]).toBeInstanceOf(Float32Array);
        expect(out[0][0]).toBeCloseTo(0.6, 5);
        expect(out[0][1]).toBeCloseTo(0.8, 5);
    });

    it('isReady() is true for the lmstudio source as long as an endpoint is set', () => {
        const ep = new EmbeddingProvider();
        ep.setSource('lmstudio');
        // Default endpoint is set in the constructor, so this is true out of the box.
        expect(ep.isReady()).toBe(true);
    });

    it('load() is a no-op for the lmstudio source (no worker)', async () => {
        const ep = new EmbeddingProvider();
        ep.setSource('lmstudio');
        await ep.load();
        // No worker should have been instantiated
        expect(ep._worker).toBeNull();
    });

    it('reorders rows by index and reports server failure descriptively', async () => {
        const ep = new EmbeddingProvider();
        ep.setSource('lmstudio');
        globalThis.fetch = vi.fn(async () => ({
            ok: true,
            json: async () => ({
                data: [
                    { index: 1, embedding: [0, 1] },
                    { index: 0, embedding: [1, 0] }
                ]
            })
        }));
        const out = await ep.embed(['a', 'b']);
        expect(Array.from(out[0])).toEqual([1, 0]);
        expect(Array.from(out[1])).toEqual([0, 1]);

        globalThis.fetch = vi.fn(async () => ({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            text: async () => 'model crashed'
        }));
        await expect(ep.embed(['x'])).rejects.toThrow(/LM Studio embedding failed/);
    });
});
