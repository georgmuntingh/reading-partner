/**
 * Model Manager
 * Tracks model download status and provides progress information.
 * transformers.js handles its own caching (Cache API / IndexedDB);
 * this wraps it with UI-friendly progress info and status checks.
 */

export class ModelManager {
    constructor() {
        this._onProgress = null;
        this._downloadingModels = new Set();
    }

    /**
     * Set progress callback
     * @param {(modelId: string, progress: Object) => void} callback
     */
    onProgress(callback) {
        this._onProgress = callback;
    }

    /**
     * Check if a model is likely cached by checking the Cache API.
     * transformers.js v3 uses the Cache API via ONNX Runtime Web.
     * This is a heuristic check - we look for files matching the model name.
     * @param {string} modelId - e.g. 'onnx-community/whisper-tiny.en'
     * @returns {Promise<boolean>}
     */
    async isModelCached(modelId) {
        try {
            if (!('caches' in window)) return false;

            // transformers.js uses a cache named 'transformers-cache'
            const cacheNames = await caches.keys();
            const tfCache = cacheNames.find(name =>
                name.includes('transformers') || name.includes('onnx')
            );

            if (!tfCache) return false;

            const cache = await caches.open(tfCache);
            const keys = await cache.keys();

            // Check if any cached URL contains the model ID
            const modelPattern = modelId.replace('/', '%2F');
            return keys.some(req =>
                req.url.includes(modelId) || req.url.includes(modelPattern)
            );
        } catch {
            return false;
        }
    }

    /**
     * Get estimated model sizes
     * @param {string} modelId
     * @returns {{ download: string, memory: string }}
     */
    getModelSize(modelId) {
        const sizes = {
            'onnx-community/whisper-tiny.en': { download: '~75 MB', memory: '~200 MB' },
            'onnx-community/whisper-base.en': { download: '~150 MB', memory: '~400 MB' },
            'onnx-community/whisper-small.en': { download: '~470 MB', memory: '~1 GB' },
            'onnx-community/whisper-tiny': { download: '~75 MB', memory: '~200 MB' },
            'onnx-community/whisper-base': { download: '~150 MB', memory: '~400 MB' },
            'HuggingFaceTB/SmolLM2-135M-Instruct': { download: '~100 MB', memory: '~200 MB' },
            'HuggingFaceTB/SmolLM2-360M-Instruct': { download: '~250 MB', memory: '~400 MB' },
            'HuggingFaceTB/SmolLM2-1.7B-Instruct': { download: '~925 MB', memory: '~1.5 GB' },
        };
        return sizes[modelId] || { download: 'Unknown', memory: 'Unknown' };
    }

    /**
     * Get storage usage info
     * @returns {Promise<{ used: string, available: string }>}
     */
    async getStorageUsage() {
        try {
            if (navigator.storage?.estimate) {
                const estimate = await navigator.storage.estimate();
                return {
                    used: this._formatBytes(estimate.usage || 0),
                    available: this._formatBytes(estimate.quota || 0)
                };
            }
        } catch {
            // Fall through
        }
        return { used: 'Unknown', available: 'Unknown' };
    }

    /**
     * Check if a model is currently downloading
     * @param {string} modelId
     * @returns {boolean}
     */
    isDownloading(modelId) {
        return this._downloadingModels.has(modelId);
    }

    /**
     * Mark a model as downloading
     * @param {string} modelId
     */
    setDownloading(modelId) {
        this._downloadingModels.add(modelId);
    }

    /**
     * Mark a model as done downloading
     * @param {string} modelId
     */
    clearDownloading(modelId) {
        this._downloadingModels.delete(modelId);
    }

    /**
     * Report progress for a model
     * @param {string} modelId
     * @param {Object} progress
     */
    reportProgress(modelId, progress) {
        this._onProgress?.(modelId, progress);
    }

    // ========== Private ==========

    _formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }
}

// Export singleton
export const modelManager = new ModelManager();
