/**
 * Embedding Provider
 * Main-thread Promise wrapper around js/workers/embedding-worker.js.
 *
 * Exposes:
 *   - load()      : downloads + initialises the embedding model (idempotent)
 *   - embed(texts): returns a Promise<Float32Array[]> with one unit-norm
 *                   embedding per input string
 *   - onProgress  : callback invoked with model-loading progress events
 */

export class EmbeddingProvider {
    constructor() {
        this._worker = null;
        this._ready = false;
        this._readyPromise = null;
        this._pending = new Map();   // id -> { resolve, reject }
        this._nextId = 1;
        this._model = null;          // Configured model id (set via setModel)
        this._transformersVersion = '3';
        this.onProgress = null;
    }

    /**
     * Configure the model to load. Has no effect after load() has been called.
     * @param {string} modelId
     */
    setModel(modelId) {
        this._model = modelId;
    }

    /**
     * Configure the transformers.js version. Has no effect after load() has been called.
     * @param {string} version
     */
    setTransformersVersion(version) {
        this._transformersVersion = version;
    }

    /**
     * Spawn the worker and request model load. Idempotent — repeated calls
     * return the same Promise.
     * @returns {Promise<void>}
     */
    async load() {
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
        if (this._model) payload.model = this._model;
        this._worker.postMessage(payload);

        return this._readyPromise;
    }

    /**
     * Generate one embedding per input string.
     * Auto-loads the model on first call.
     * @param {string[]} texts
     * @returns {Promise<Float32Array[]>}
     */
    async embed(texts) {
        if (!this._ready) await this.load();
        const id = `e${this._nextId++}`;
        return new Promise((resolve, reject) => {
            this._pending.set(id, { resolve, reject });
            this._worker.postMessage({ type: 'embed', id, texts });
        });
    }

    /**
     * Whether the model has finished loading.
     * @returns {boolean}
     */
    isReady() {
        return this._ready;
    }

    /**
     * Terminate the worker and reset state. Pending requests are rejected.
     */
    unload() {
        const err = new Error('Embedding provider unloaded');
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

// Singleton — one embedding worker per app session
export const embeddingProvider = new EmbeddingProvider();
