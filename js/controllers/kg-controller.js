/**
 * KG Controller
 * Orchestrates per-chapter knowledge-graph extraction:
 *   chunk → LLM extract → embed → resolve nodes → resolve edges → persist.
 *
 * Trigger model: manual button per chapter (matches QuizController UX).
 * Fault-tolerant: any per-chunk extract/embed/resolve failure is logged and
 * skipped — one bad chunk never crashes the chapter pipeline. The previous
 * llmClient backend is restored even on error.
 */

import { storage } from '../services/storage.js';
import { llmClient } from '../services/llm-client.js';
import { embeddingProvider } from '../services/embedding-provider.js';
import { chunkSentences, extractFromChunk } from '../services/kg-extractor.js';
import { KGResolver } from '../services/kg-resolver.js';

export const KG_STATE = Object.freeze({
    IDLE: 'IDLE',
    RUNNING: 'RUNNING',
    DONE: 'DONE',
    ERROR: 'ERROR'
});

export class KGController {
    constructor({ getSettings, getBook }) {
        if (typeof getSettings !== 'function') throw new Error('KGController: getSettings is required');
        if (typeof getBook !== 'function') throw new Error('KGController: getBook is required');
        this.getSettings = getSettings;
        this.getBook = getBook;
        this.state = KG_STATE.IDLE;
        // Progress callback. Stages: 'embed-load' | 'extract' | 'done' | 'error'
        this.onProgress = null;
    }

    /**
     * Build the knowledge graph for a single chapter.
     *
     * If the chapter has already been processed (chapter.kgProcessed === true),
     * this is a no-op unless { force: true } is passed. The button in the
     * reader is grayed out for processed chapters, but the controller also
     * short-circuits as defense in depth.
     *
     * @param {number} chapterIndex
     * @param {{ force?: boolean }} [opts]
     */
    async buildChapterGraph(chapterIndex, opts = {}) {
        const { force = false } = opts;
        if (this.state === KG_STATE.RUNNING) {
            throw new Error('KG build already in progress');
        }
        this.state = KG_STATE.RUNNING;

        const book = this.getBook();
        if (!book) throw new Error('KGController: no current book');
        const chapter = book.chapters?.[chapterIndex];
        if (!chapter) throw new Error(`KGController: chapter ${chapterIndex} not found`);
        if (!Array.isArray(chapter.sentences) || chapter.sentences.length === 0) {
            this.state = KG_STATE.IDLE;
            return;
        }
        if (!force && chapter.kgProcessed === true) {
            this.state = KG_STATE.DONE;
            this.onProgress?.({ stage: 'done', chapterIndex, skipped: true });
            return;
        }

        const settings = this.getSettings() || {};
        const chunkSize = settings.kgChunkSize ?? 6;
        const chunkOverlap = settings.kgChunkOverlap ?? 2;
        const similarityThreshold = settings.kgSimilarityThreshold ?? 0.88;
        const targetBackend = settings.kgExtractionBackend;

        const prevBackend = llmClient.getBackend();
        if (targetBackend && targetBackend !== prevBackend) {
            llmClient.setBackend(targetBackend);
        }

        try {
            // 1) Configure the embedding backend before each build so settings
            //    changes (cloud ↔ local, model swap, key rotation) take effect.
            const embeddingSource = settings.kgEmbeddingSource || 'openrouter';
            embeddingProvider.setSource(embeddingSource);
            if (embeddingSource === 'openrouter') {
                if (settings.kgCloudEmbeddingModel) embeddingProvider.setCloudModel(settings.kgCloudEmbeddingModel);
                if (settings.apiKey) embeddingProvider.setApiKey(settings.apiKey);
            } else {
                if (settings.kgLocalEmbeddingModel) embeddingProvider.setLocalModel(settings.kgLocalEmbeddingModel);
            }

            // Forward download progress (only fires for the local source).
            embeddingProvider.onProgress = (p) => this.onProgress?.({
                stage: 'embed-load',
                status: p?.status,
                file: p?.file,
                loaded: p?.loaded,
                total: p?.total,
                progress: p?.progress
            });
            await embeddingProvider.load();

            // 2) Resolver (per-book candidate set)
            const resolver = new KGResolver({ bookId: book.id, similarityThreshold });
            await resolver.load();

            // 3) Chunk the chapter
            const chunks = chunkSentences(chapter.sentences, chunkSize, chunkOverlap);

            // 4) For each chunk: extract → embed → resolve nodes → resolve edges.
            //    Fault-tolerant: per-chunk failures log and continue.
            for (let i = 0; i < chunks.length; i++) {
                this.onProgress?.({ stage: 'extract', current: i + 1, total: chunks.length });

                let extracted;
                try {
                    extracted = await extractFromChunk(chunks[i].text);
                } catch (err) {
                    console.warn(`[kg-controller] chunk ${i} extraction threw:`, err?.message);
                    continue;
                }
                if (!extracted || extracted.entities.length === 0) continue;

                let embeddings;
                try {
                    embeddings = await embeddingProvider.embed(extracted.entities.map((e) => e.name));
                } catch (err) {
                    console.warn(`[kg-controller] chunk ${i} embedding failed, skipping:`, err?.message);
                    continue;
                }

                const nameToNodeId = new Map();
                for (let j = 0; j < extracted.entities.length; j++) {
                    const e = extracted.entities[j];
                    try {
                        const { id } = await resolver.resolve({
                            name: e.name,
                            type: e.type,
                            aliases: Array.isArray(e.aliases) ? e.aliases : [],
                            bloom: e.bloom,
                            embedding: embeddings[j],
                            chapterIndex,
                            sentenceIndices: chunks[i].sentenceIndices
                        });
                        nameToNodeId.set(e.name, id);
                    } catch (err) {
                        console.warn(`[kg-controller] resolve failed for "${e.name}":`, err?.message);
                    }
                }

                for (const r of extracted.relations) {
                    const sId = nameToNodeId.get(r.source);
                    const tId = nameToNodeId.get(r.target);
                    if (!sId || !tId) continue;
                    try {
                        await resolver.resolveEdge({
                            sourceId: sId,
                            targetId: tId,
                            relation: r.relation,
                            chapterIndex,
                            sentenceIndices: chunks[i].sentenceIndices
                        });
                    } catch (err) {
                        console.warn('[kg-controller] edge save failed:', err?.message);
                    }
                }
            }

            chapter.kgProcessed = true;
            try {
                await storage.saveBook(book);
            } catch (err) {
                console.warn('[kg-controller] failed to persist kgProcessed flag:', err?.message);
            }

            this.state = KG_STATE.DONE;
            this.onProgress?.({ stage: 'done', chapterIndex });
        } catch (err) {
            this.state = KG_STATE.ERROR;
            this.onProgress?.({ stage: 'error', error: err?.message ?? String(err) });
            throw err;
        } finally {
            if (targetBackend && targetBackend !== prevBackend) {
                llmClient.setBackend(prevBackend);
            }
        }
    }
}
