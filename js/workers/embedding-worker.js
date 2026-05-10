/**
 * Embedding Web Worker
 * Runs a local feature-extraction model (e.g. Xenova/all-MiniLM-L6-v2)
 * to produce 384-d unit-norm embeddings for entity-resolution cosine search.
 *
 * Message protocol (mirrors llm-worker.js):
 *   in:  { type: 'load', model?, transformersVersion? }
 *   in:  { type: 'embed', id, texts: string[] }
 *   out: { type: 'loading', progress: { status, file?, loaded?, total?, progress? } }
 *   out: { type: 'ready', info: { model } }
 *   out: { type: 'result', id, embeddings: Float32Array[] }
 *   out: { type: 'error', id?, error: string }
 */

let extractor = null;
let isLoading = false;

self.onmessage = async (event) => {
    const { type, ...data } = event.data || {};
    if (type === 'load') return loadModel(data);
    if (type === 'embed') return embed(data);
};

async function loadModel({ model = 'Xenova/all-MiniLM-L6-v2', transformersVersion = '3' } = {}) {
    if (isLoading || extractor) return;
    isLoading = true;

    try {
        self.postMessage({
            type: 'loading',
            progress: { status: `Loading transformers.js v${transformersVersion}...` }
        });

        const transformers = await import(
            /* @vite-ignore */
            `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${transformersVersion}`
        );

        // Disable local-model lookups so the model is fetched from the Hub
        transformers.env.allowLocalModels = false;

        extractor = await transformers.pipeline('feature-extraction', model, {
            progress_callback: (progress) => {
                if (progress.status === 'progress') {
                    self.postMessage({
                        type: 'loading',
                        progress: {
                            status: `Downloading ${progress.file}`,
                            file: progress.file,
                            loaded: progress.loaded,
                            total: progress.total,
                            progress: progress.progress
                        }
                    });
                }
            }
        });

        isLoading = false;
        self.postMessage({ type: 'ready', info: { model } });
    } catch (error) {
        isLoading = false;
        self.postMessage({ type: 'error', error: error.message ?? String(error) });
    }
}

async function embed({ id, texts }) {
    try {
        if (!extractor) throw new Error('Embedding model not loaded');
        if (!Array.isArray(texts) || texts.length === 0) throw new Error('embed: texts must be a non-empty array');

        // Mean-pooled, L2-normalised → ready for cosine via plain dot product
        const out = await extractor(texts, { pooling: 'mean', normalize: true });

        // out.tolist() → number[][]; ship Float32Array per row to keep wire size small
        const rows = out.tolist().map((row) => Float32Array.from(row));
        self.postMessage(
            { type: 'result', id, embeddings: rows },
            rows.map((r) => r.buffer)
        );
    } catch (error) {
        self.postMessage({ type: 'error', id, error: error.message ?? String(error) });
    }
}
