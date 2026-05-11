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
import { chunkSentences, extractFromChunkBatch, RELATION_BLACKLIST } from '../services/kg-extractor.js';
import { KGResolver } from '../services/kg-resolver.js';

export const KG_STATE = Object.freeze({
    IDLE: 'IDLE',
    RUNNING: 'RUNNING',
    DONE: 'DONE',
    ERROR: 'ERROR'
});

export class KGController {
    /**
     * @param {Object} deps
     * @param {() => Object} deps.getSettings
     * @param {() => Object} deps.getBook
     * @param {(book: Object) => Promise<string|null>} [deps.promptForDomain]
     *   Optional async UI callback invoked when the current book has no
     *   kgDomain set. Resolves to the domain string the user typed, or
     *   null to cancel. If omitted, the build proceeds without Tier-1/2
     *   filtering — Tier-3 regex still applies.
     */
    constructor({ getSettings, getBook, promptForDomain }) {
        if (typeof getSettings !== 'function') throw new Error('KGController: getSettings is required');
        if (typeof getBook !== 'function') throw new Error('KGController: getBook is required');
        this.getSettings = getSettings;
        this.getBook = getBook;
        this.promptForDomain = typeof promptForDomain === 'function' ? promptForDomain : null;
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
        const relevanceThreshold = Number.isFinite(settings.kgRelevanceThreshold)
            ? settings.kgRelevanceThreshold
            : 0.15;
        const chunksPerRequest = Math.max(1, settings.kgChunksPerRequest ?? 4);
        const targetBackend = settings.kgExtractionBackend;

        // Resolve the per-book domain. Persist on the book so we only prompt
        // once. A user-cancelled prompt aborts the build.
        let kgDomain = String(book.kgDomain || '').trim();
        if (!kgDomain && this.promptForDomain) {
            const entered = await this.promptForDomain(book);
            const trimmed = String(entered || '').trim();
            if (!trimmed) {
                this.state = KG_STATE.IDLE;
                return;
            }
            kgDomain = trimmed;
            book.kgDomain = kgDomain;
            try {
                await storage.saveBook(book);
            } catch (err) {
                console.warn('[kg-controller] failed to persist kgDomain:', err?.message);
            }
        }

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

            // 2) Compute the Tier-2 domain anchor once per session. We wrap
            //    the raw kgDomain in a framing sentence because feature-
            //    extraction embedders produce noisy vectors for bare nouns
            //    ("Biology") compared to natural sentences.
            let anchor = null;
            if (kgDomain) {
                try {
                    const anchorText = `The core academic topic of this text is ${kgDomain}.`;
                    const [vec] = await embeddingProvider.embed([anchorText]);
                    if (vec instanceof Float32Array) anchor = vec;
                } catch (err) {
                    console.warn(
                        '[kg-controller] anchor embedding failed — Tier-2 relevance disabled this session:',
                        err?.message ?? String(err)
                    );
                }
            }

            // 3) Resolver (per-book candidate set + anchor gate)
            const resolver = new KGResolver({
                bookId: book.id,
                similarityThreshold,
                anchor,
                relevanceThreshold
            });
            await resolver.load();

            // 3) Chunk the chapter
            const chunks = chunkSentences(chapter.sentences, chunkSize, chunkOverlap);

            // 4) Phase A — extract chunks in groups of K (kgChunksPerRequest).
            //    Each group is a single LLM call returning per-chunk entities/
            //    relations, so a 20-chunk chapter with K=4 makes 5 LLM calls
            //    instead of 20. Per-batch failures log + skip (one bad batch
            //    loses K chunks but the rest of the chapter still completes).
            const extractions = new Array(chunks.length).fill(null);
            for (let start = 0; start < chunks.length; start += chunksPerRequest) {
                const end = Math.min(start + chunksPerRequest, chunks.length);
                const batchTexts = chunks.slice(start, end).map((c) => c.text);
                this.onProgress?.({
                    stage: 'extract',
                    current: start + 1,
                    total: chunks.length,
                    batchSize: batchTexts.length
                });
                let batchResults;
                try {
                    batchResults = await extractFromChunkBatch(batchTexts, { kgDomain });
                } catch (err) {
                    console.warn(
                        `[kg-controller] batch ${start}-${end - 1} extraction threw:`,
                        err?.message
                    );
                    continue;
                }
                for (let j = 0; j < batchResults.length; j++) {
                    extractions[start + j] = batchResults[j];
                }
            }

            // 5) Phase B — collect a chapter-wide unique-name list so we
            //    can do ONE batched embed call instead of one per chunk.
            //    Repeated names across chunks share a single embedding.
            const uniqueNames = [];
            const seen = new Set();
            for (const ex of extractions) {
                if (!ex) continue;
                for (const ent of ex.entities) {
                    if (!ent?.name || seen.has(ent.name)) continue;
                    seen.add(ent.name);
                    uniqueNames.push(ent.name);
                }
            }

            // 6) Phase C — batched embedding. EmbeddingProvider.embed()
            //    auto-splits at EMBED_MAX_BATCH so callers can pass the
            //    full set in one shot.
            const nameToEmbedding = new Map();
            if (uniqueNames.length > 0) {
                this.onProgress?.({ stage: 'embed', count: uniqueNames.length });
                try {
                    const embeddings = await embeddingProvider.embed(uniqueNames);
                    for (let i = 0; i < uniqueNames.length; i++) {
                        nameToEmbedding.set(uniqueNames[i], embeddings[i]);
                    }
                } catch (err) {
                    // No embeddings means nothing can be resolved — surface
                    // the failure so the chapter stays unprocessed and the
                    // user can retry.
                    console.warn('[kg-controller] batch embedding failed:', err?.message);
                    throw err;
                }
            }

            // 7) Phase D — resolve nodes and edges per chunk, in order.
            //    The resolver's state (existing candidates + new ones from
            //    earlier chunks) is naturally maintained so cross-chunk
            //    duplicates collapse exactly as before.
            //
            //    Important: the resolver also stores `sentenceIndices` for
            //    each context. Naively passing chunks[i].sentenceIndices
            //    (the whole chunk window — typically 6 sentences) means the
            //    side panel's links lead to neighbours that don't actually
            //    mention the concept. Filter down to sentences whose text
            //    contains the canonical name or one of the aliases.
            const chapterSentences = Array.isArray(chapter.sentences) ? chapter.sentences : [];
            const lowerCache = new Array(chapterSentences.length);
            const sentenceLower = (idx) => {
                if (lowerCache[idx] === undefined) {
                    lowerCache[idx] = String(chapterSentences[idx] ?? '').toLowerCase();
                }
                return lowerCache[idx];
            };
            const matchSentencesFor = (chunk, needles) => {
                const ns = needles
                    .map((s) => String(s || '').toLowerCase().trim())
                    .filter((s) => s.length > 0);
                if (ns.length === 0) return chunk.sentenceIndices.slice();
                const hits = [];
                for (const si of chunk.sentenceIndices) {
                    const text = sentenceLower(si);
                    if (ns.some((n) => text.includes(n))) hits.push(si);
                }
                // Fallback: if surface-form matching missed every sentence
                // (e.g. the LLM canonicalised "mitochondria" to
                // "mitochondrion" and only the plural appears) keep the
                // whole chunk so we don't lose the context entirely.
                return hits.length > 0 ? hits : chunk.sentenceIndices.slice();
            };

            for (let i = 0; i < chunks.length; i++) {
                this.onProgress?.({ stage: 'resolve', current: i + 1, total: chunks.length });
                const ex = extractions[i];
                if (!ex || ex.entities.length === 0) continue;

                const nameToNodeId = new Map();
                const nameToSentenceIndices = new Map();
                for (const ent of ex.entities) {
                    const emb = nameToEmbedding.get(ent.name);
                    if (!emb) continue;
                    const aliases = Array.isArray(ent.aliases) ? ent.aliases : [];
                    const entSentences = matchSentencesFor(chunks[i], [ent.name, ...aliases]);
                    try {
                        const result = await resolver.resolve({
                            name: ent.name,
                            type: ent.type,
                            aliases,
                            bloom: ent.bloom,
                            embedding: emb,
                            chapterIndex,
                            sentenceIndices: entSentences
                        });
                        // result === null when the Tier-2 anchor gate dropped
                        // the entity. Skip silently so relations referencing
                        // it are also dropped below.
                        if (result) {
                            nameToNodeId.set(ent.name, result.id);
                            nameToSentenceIndices.set(ent.name, entSentences);
                        }
                    } catch (err) {
                        console.warn(`[kg-controller] resolve failed for "${ent.name}":`, err?.message);
                    }
                }

                for (const r of ex.relations) {
                    // Belt-and-braces: kg-extractor.sanitizeExtraction()
                    // already filters the blacklist, but if a future caller
                    // bypasses it we still won't write structural relations.
                    const relStr = String(r.relation || '').toLowerCase().trim();
                    if (RELATION_BLACKLIST.has(relStr)) continue;
                    const sId = nameToNodeId.get(r.source);
                    const tId = nameToNodeId.get(r.target);
                    if (!sId || !tId) continue;
                    // Sentences that mention BOTH endpoints are the strongest
                    // evidence for the relation. Fall back to the union if
                    // there's no overlap.
                    const srcS = new Set(nameToSentenceIndices.get(r.source) || []);
                    const tgtS = nameToSentenceIndices.get(r.target) || [];
                    const both = tgtS.filter((si) => srcS.has(si));
                    const edgeSentences = both.length > 0
                        ? both
                        : Array.from(new Set([...srcS, ...tgtS]));
                    try {
                        await resolver.resolveEdge({
                            sourceId: sId,
                            targetId: tId,
                            relation: r.relation,
                            chapterIndex,
                            sentenceIndices: edgeSentences
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
