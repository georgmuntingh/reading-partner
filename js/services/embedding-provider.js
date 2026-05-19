/**
 * Embedding Provider
 *
 * One singleton that supports two interchangeable backends:
 *   - 'openrouter' (cloud) — POSTs to an OpenAI-compatible /v1/embeddings
 *     endpoint (default openrouter.ai). Reuses the existing OpenRouter API
 *     key. No worker, no download.
 *   - 'local' — spawns embedding-worker.js, downloads a transformers.js
 *     feature-extraction model (default Xenova/all-MiniLM-L6-v2), and
 *     computes embeddings on-device.
 *
 * Public API:
 *   setSource(source), setApiKey(key), setCloudModel(id), setCloudEndpoint(url),
 *   setLocalModel(id) (alias setModel for backward compat), setTransformersVersion(v),
 *   load(), embed(texts), isReady(), unload(), onProgress.
 *
 * embed() always returns L2-normalised Float32Array[] so the resolver's
 * dot-product cosine works regardless of backend. The local worker already
 * normalises; the cloud path normalises after fetch.
 */

export const DEFAULT_LOCAL_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const DEFAULT_CLOUD_EMBEDDING_MODEL = 'openai/text-embedding-3-small';
export const DEFAULT_CLOUD_EMBEDDING_ENDPOINT = 'https://openrouter.ai/api/v1/embeddings';
export const DEFAULT_LMSTUDIO_EMBEDDING_ENDPOINT = 'http://127.0.0.1:1234';
export const DEFAULT_LMSTUDIO_EMBEDDING_MODEL = 'text-embedding-bge-large-en-v1.5';

/**
 * Max input strings per single call to the underlying backend. Inputs larger
 * than this are split into multiple sequential sub-requests and stitched
 * back together. Set well under OpenAI's 2048 cap and small enough that
 * transformers.js doesn't OOM on a typical GPU.
 */
export const EMBED_MAX_BATCH = 256;

export const CLOUD_EMBEDDING_MODELS = [
    { id: 'openai/text-embedding-3-small', name: 'OpenAI text-embedding-3-small' },
    { id: 'openai/text-embedding-3-large', name: 'OpenAI text-embedding-3-large' },
    { id: 'qwen/qwen3-embedding-4b', name: 'Qwen3-Embedding-4B' },
    { id: 'qwen/qwen3-embedding-8b', name: 'Qwen3-Embedding-8B' }
];

export const LOCAL_EMBEDDING_MODELS = [
    { id: 'Xenova/all-MiniLM-L6-v2', name: 'all-MiniLM-L6-v2 (384-d, ~25 MB)' },
    { id: 'Xenova/bge-small-en-v1.5', name: 'BGE-small EN v1.5 (384-d, ~33 MB)' },
    { id: 'Xenova/multilingual-e5-small', name: 'Multilingual E5 small (384-d, ~118 MB)' }
];

function normalize(v) {
    let n = 0;
    for (const x of v) n += x * x;
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= n;
    return v;
}

export class EmbeddingProvider {
    constructor() {
        this._source = 'openrouter';
        this._apiKey = null;
        this._cloudModel = DEFAULT_CLOUD_EMBEDDING_MODEL;
        this._cloudEndpoint = DEFAULT_CLOUD_EMBEDDING_ENDPOINT;

        this._lmstudioEndpoint = DEFAULT_LMSTUDIO_EMBEDDING_ENDPOINT;
        this._lmstudioModel = DEFAULT_LMSTUDIO_EMBEDDING_MODEL;

        this._localModel = DEFAULT_LOCAL_EMBEDDING_MODEL;
        this._transformersVersion = '3';

        // Local-source state
        this._worker = null;
        this._ready = false;
        this._readyPromise = null;
        this._pending = new Map();
        this._nextId = 1;

        this.onProgress = null;
    }

    /** @param {'openrouter'|'local'|'lmstudio'} source */
    setSource(source) {
        if (source && source !== this._source) {
            // If we'd already loaded the local worker, drop it on switch.
            if (this._source === 'local' && this._ready) {
                this._teardownLocal();
            }
            this._source = source;
        }
    }

    getSource() { return this._source; }

    setApiKey(key) { this._apiKey = key || null; }
    setCloudModel(id) { if (id) this._cloudModel = id; }
    setCloudEndpoint(url) { if (url) this._cloudEndpoint = url; }
    setLmstudioEndpoint(url) { if (url) this._lmstudioEndpoint = url; }
    setLmstudioModel(id) { if (id) this._lmstudioModel = id; }
    setLocalModel(id) { if (id) this._localModel = id; }
    /** @deprecated alias for setLocalModel */
    setModel(id) { this.setLocalModel(id); }
    setTransformersVersion(v) { if (v) this._transformersVersion = v; }

    /**
     * Cloud path is always "ready" (validated on first embed).
     * Local path loads the worker. Idempotent.
     */
    async load() {
        // Cloud and LM Studio sources require no preloading.
        if (this._source !== 'local') return;
        if (this._readyPromise) return this._readyPromise;

        this._worker = new Worker(
            new URL('../workers/embedding-worker.js', import.meta.url),
            { type: 'module' }
        );
        this._worker.onmessage = (event) => this._dispatch(event.data);
        this._worker.onerror = (event) => {
            const err = new Error(event.message || 'Embedding worker crashed');
            this._pending.get('__load__')?.reject(err);
            this._pending.delete('__load__');
            for (const [, { reject }] of this._pending) reject(err);
            this._pending.clear();
        };

        this._readyPromise = new Promise((resolve, reject) => {
            this._pending.set('__load__', { resolve, reject });
        });

        const payload = { type: 'load', transformersVersion: this._transformersVersion };
        if (this._localModel) payload.model = this._localModel;
        this._worker.postMessage(payload);

        return this._readyPromise;
    }

    /**
     * Generate one L2-normalised embedding per input string. Auto-loads the
     * local model on first call when source='local'; cloud path makes a
     * direct fetch.
     *
     * Inputs longer than EMBED_MAX_BATCH are automatically split into
     * multiple sequential sub-requests so callers can pass an entire
     * chapter's entities in one call without worrying about provider limits.
     *
     * @param {string[]} texts
     * @returns {Promise<Float32Array[]>}
     */
    async embed(texts) {
        if (!Array.isArray(texts) || texts.length === 0) {
            throw new Error('embed: texts must be a non-empty array');
        }
        if (texts.length <= EMBED_MAX_BATCH) {
            return this._embedRaw(texts);
        }
        const out = [];
        for (let i = 0; i < texts.length; i += EMBED_MAX_BATCH) {
            const slice = texts.slice(i, i + EMBED_MAX_BATCH);
            const part = await this._embedRaw(slice);
            for (const e of part) out.push(e);
        }
        return out;
    }

    _embedRaw(texts) {
        if (this._source === 'openrouter') return this._embedCloud(texts);
        if (this._source === 'lmstudio') return this._embedLmstudio(texts);
        return this._embedLocal(texts);
    }

    async _embedLmstudio(texts) {
        if (!Array.isArray(texts) || texts.length === 0) {
            throw new Error('embed: texts must be a non-empty array');
        }
        const base = String(this._lmstudioEndpoint || '').replace(/\/+$/, '');
        const url = `${base}/v1/embeddings`;

        let res;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: this._lmstudioModel, input: texts })
            });
        } catch (err) {
            throw new Error(`Cannot reach LM Studio at ${this._lmstudioEndpoint}: ${err.message}`);
        }
        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error(`LM Studio embedding failed: ${res.status} ${res.statusText} ${errText}`.trim());
        }
        const data = await res.json();
        if (!Array.isArray(data?.data) || data.data.length === 0) {
            throw new Error('LM Studio embedding returned empty response');
        }
        return data.data
            .slice()
            .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
            .map((row) => normalize(Float32Array.from(row.embedding)));
    }

    async _embedCloud(texts) {
        if (!this._apiKey) {
            throw new Error('Cloud embedding requires an OpenRouter API key (set in Settings → Q&A).');
        }
        if (!Array.isArray(texts) || texts.length === 0) {
            throw new Error('embed: texts must be a non-empty array');
        }

        const origin = (typeof window !== 'undefined' && window.location?.origin) || '';
        const res = await fetch(this._cloudEndpoint, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this._apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': origin,
                'X-Title': 'Reading Partner'
            },
            body: JSON.stringify({ model: this._cloudModel, input: texts })
        });
        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error(`Cloud embedding failed: ${res.status} ${res.statusText} ${errText}`.trim());
        }
        const data = await res.json();
        if (!Array.isArray(data?.data) || data.data.length === 0) {
            throw new Error('Cloud embedding returned empty response');
        }
        // Each item: { index, embedding: number[] }. Sort by index just in
        // case the server reorders, then normalise.
        return data.data
            .slice()
            .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
            .map((row) => normalize(Float32Array.from(row.embedding)));
    }

    async _embedLocal(texts) {
        if (!this._ready) await this.load();
        const id = `e${this._nextId++}`;
        return new Promise((resolve, reject) => {
            this._pending.set(id, { resolve, reject });
            this._worker.postMessage({ type: 'embed', id, texts });
        });
    }

    /**
     * Whether the active backend is ready. Cloud is always ready; local
     * is ready after the worker reports ready.
     */
    isReady() {
        if (this._source === 'openrouter') return Boolean(this._apiKey);
        if (this._source === 'lmstudio') return Boolean(this._lmstudioEndpoint);
        return this._ready;
    }

    /**
     * Tear down the worker (local only) and reject any pending requests.
     */
    unload() {
        this._teardownLocal('Embedding provider unloaded');
    }

    _teardownLocal(reason = 'Embedding worker unloaded') {
        const err = new Error(reason);
        for (const [, { reject }] of this._pending) reject(err);
        this._pending.clear();
        if (this._worker) {
            this._worker.terminate();
            this._worker = null;
        }
        this._ready = false;
        this._readyPromise = null;
    }

    _dispatch(msg) {
        if (!msg || typeof msg !== 'object') return;

        if (msg.type === 'loading') {
            this.onProgress?.(msg.progress);
            return;
        }
        if (msg.type === 'ready') {
            this._ready = true;
            this._pending.get('__load__')?.resolve();
            this._pending.delete('__load__');
            return;
        }
        if (msg.type === 'result') {
            this._pending.get(msg.id)?.resolve(msg.embeddings);
            this._pending.delete(msg.id);
            return;
        }
        if (msg.type === 'error') {
            const err = new Error(msg.error || 'Embedding worker error');
            if (msg.id) {
                this._pending.get(msg.id)?.reject(err);
                this._pending.delete(msg.id);
            } else {
                this._pending.get('__load__')?.reject(err);
                this._pending.delete('__load__');
                this._readyPromise = null;
            }
        }
    }
}

// Singleton
export const embeddingProvider = new EmbeddingProvider();
