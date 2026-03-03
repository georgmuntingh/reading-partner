/**
 * LLM Client - Facade / Strategy Pattern
 * Delegates all LLM calls to the active provider (OpenRouter or Local).
 * Maintains backward-compatible API so existing imports continue to work.
 */

import { OpenRouterProvider, OPENROUTER_MODELS, DEFAULT_MODEL } from './openrouter-provider.js';
import { LocalLLMProvider, LOCAL_LLM_MODELS, DEFAULT_LOCAL_MODEL } from './local-llm-provider.js';
import { MediaPipeLLMProvider, MEDIAPIPE_LLM_MODEL } from './mediapipe-llm-provider.js';

// Re-export for backward compatibility
export { OPENROUTER_MODELS, DEFAULT_MODEL };
export { LOCAL_LLM_MODELS, DEFAULT_LOCAL_MODEL };
export { MEDIAPIPE_LLM_MODEL };

export class LLMClient {
    constructor(apiKey = null, model = DEFAULT_MODEL) {
        // Create all providers
        this._openRouterProvider = new OpenRouterProvider(apiKey, model);
        this._localProvider = new LocalLLMProvider();
        this._mediapipeProvider = new MediaPipeLLMProvider();

        // Active backend: 'openrouter', 'local', or 'mediapipe'
        this._backend = 'openrouter';

        // Callback for model loading progress (local / mediapipe providers)
        this.onModelProgress = null;
    }

    // ========== Backend Management ==========

    /**
     * Get the current backend type
     * @returns {'openrouter'|'local'}
     */
    getBackend() {
        return this._backend;
    }

    /**
     * Set the active backend
     * @param {'openrouter'|'local'} backend
     */
    setBackend(backend) {
        this._backend = backend;
    }

    /**
     * Get the active provider
     * @returns {import('./llm-provider.js').LLMProvider}
     */
    _getProvider() {
        if (this._backend === 'local') return this._localProvider;
        if (this._backend === 'mediapipe') return this._mediapipeProvider;
        return this._openRouterProvider;
    }

    /**
     * Get the OpenRouter provider directly (for API key management, etc.)
     * @returns {OpenRouterProvider}
     */
    getOpenRouterProvider() {
        return this._openRouterProvider;
    }

    /**
     * Get the local LLM provider directly (for model management, etc.)
     * @returns {LocalLLMProvider}
     */
    getLocalProvider() {
        return this._localProvider;
    }

    // ========== Backward-Compatible OpenRouter API ==========
    // These methods are used by app.js to configure OpenRouter

    setApiKey(key) {
        this._openRouterProvider.setApiKey(key);
    }

    getApiKey() {
        return this._openRouterProvider.getApiKey();
    }

    hasApiKey() {
        return this._openRouterProvider.hasApiKey();
    }

    setModel(model) {
        this._openRouterProvider.setModel(model);
    }

    getModel() {
        return this._openRouterProvider.getModel();
    }

    getAvailableModels() {
        return this._openRouterProvider.getAvailableModels();
    }

    // ========== Local LLM Config ==========

    setLocalModel(modelId) {
        this._localProvider.setModel(modelId);
    }

    getLocalModel() {
        return this._localProvider.getModel();
    }

    setLocalDevice(device) {
        this._localProvider.setDevice(device);
    }

    getLocalAvailableModels() {
        return this._localProvider.getAvailableModels();
    }

    isLocalModelReady() {
        return this._localProvider.isModelReady();
    }

    isLocalModelLoading() {
        return this._localProvider.isModelLoading();
    }

    /**
     * Load the local model (triggers download if needed)
     * @returns {Promise<void>}
     */
    async loadLocalModel() {
        // Wire up progress callback
        this._localProvider.onModelProgress = (progress) => {
            this.onModelProgress?.(progress);
        };
        return this._localProvider.loadModel();
    }

    /**
     * Unload the local model to free memory
     */
    unloadLocalModel() {
        this._localProvider.unloadModel();
    }

    // ========== MediaPipe LLM Config ==========

    setMediapipeHfToken(token) {
        this._mediapipeProvider.setHfToken(token);
    }

    getMediapipeHfToken() {
        return this._mediapipeProvider.getHfToken();
    }

    isMediapipeModelReady() {
        return this._mediapipeProvider.isModelReady();
    }

    isMediapipeModelLoading() {
        return this._mediapipeProvider.isModelLoading();
    }

    async isMediapipeModelCached() {
        return this._mediapipeProvider.isModelCached();
    }

    /**
     * Load the MediaPipe model (downloads + caches if needed)
     * @returns {Promise<void>}
     */
    async loadMediapipeModel() {
        this._mediapipeProvider.onModelProgress = (progress) => {
            this.onModelProgress?.(progress);
        };
        return this._mediapipeProvider.loadModel();
    }

    /**
     * Unload the MediaPipe model to free GPU memory
     */
    unloadMediapipeModel() {
        this._mediapipeProvider.unloadModel();
    }

    /**
     * Delete the cached MediaPipe model file from OPFS
     */
    async clearMediapipeModelCache() {
        return this._mediapipeProvider.clearModelCache();
    }

    // ========== Delegated LLM Methods ==========
    // All calls go through the active provider

    async askQuestion(contextSentences, question, bookMeta) {
        return this._getProvider().askQuestion(contextSentences, question, bookMeta);
    }

    async askQuestionStreaming(contextSentences, question, onChunk, onSentence, bookMeta, onProgress) {
        return this._getProvider().askQuestionStreaming(contextSentences, question, onChunk, onSentence, bookMeta, onProgress);
    }

    async lookupWord(options) {
        return this._getProvider().lookupWord(options);
    }

    async generateQuizQuestion(options) {
        return this._getProvider().generateQuizQuestion(options);
    }

    async streamQuizChat(messages, onChunk, onSentence) {
        return this._getProvider().streamQuizChat(messages, onChunk, onSentence);
    }

    async generateText(options) {
        return this._getProvider().generateText(options);
    }

    abort() {
        this._getProvider().abort();
    }

    // ========== OpenRouter-specific Methods ==========

    async validateApiKey(apiKey) {
        return this._openRouterProvider.validateApiKey(apiKey);
    }
}

// Export singleton instance
export const llmClient = new LLMClient();
