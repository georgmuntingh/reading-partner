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
     * @param {(phrase: string) => Promise<{ definition?: string, translation?: string } | null>} [deps.lookupDefinition]
     *   Optional callback to fetch a short definition for each newly-
     *   created node. When supplied, definitions are persisted on the
     *   node at creation time so the graph-explorer side panel can show
     *   them without a fresh LLM call. Fetches run in parallel after
     *   each chapter's resolution phase; failures are logged and skipped.
     */
    constructor({ getSettings, getBook, promptForDomain, lookupDefinition }) {
        if (typeof getSettings !== 'function') throw new Error('KGController: getSettings is required');
        if (typeof getBook !== 'function') throw new Error('KGController: getBook is required');
        this.getSettings = getSettings;
        this.getBook = getBook;
        this.promptForDomain = typeof promptForDomain === 'function' ? promptForDomain : null;
        this.lookupDefinition = typeof lookupDefinition === 'function' ? lookupDefinition : null;
        this.state = KG_STATE.IDLE;
        // Progress callback. Stages: 'embed-load' | 'extract' | 'done' | 'error'
        this.onProgress = null;
        // Live-build callbacks. Invoked once per freshly-created record
        // immediately after resolver.resolve()/resolveEdge() persist; the
        // graph explorer uses these to grow the live view as extraction
        // runs instead of forcing the user to close and re-open.
        this.onNodeCreated = null;
        this.onEdgeCreated = null;
        // Fired after each chunk-batch finishes extract → embed → resolve,
        // i.e. one full LLM round-trip's worth of new nodes/edges has
        // landed. The explorer uses this as a heartbeat to run a small
        // settle layout on the newly-added subgraph.
        this.onBatchComplete = null;
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

            // 4) Stream per-batch: extract → embed → resolve for each
            //    chunk-batch in turn so the explorer can paint a partial
            //    graph after every LLM request instead of waiting for the
            //    whole chapter. The previous design batched ALL
            //    extractions, then ONE chapter-wide embedding call, then
            //    sequential resolution — which gave the user nothing
            //    visible until the very last phase.
            //
            //    Cost trade-off: more embedding calls (one per chunk-batch
            //    instead of one per chapter). Each embedding call still
            //    batches its inputs internally, so per-call overhead is
            //    small (HTTP roundtrip on cloud, model warmup on local).
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

            // Track newly-created nodes across the chapter so we can
            // batch-fetch their definitions in a single fire-and-forget
            // pass after resolution finishes (avoids stalling each chunk
            // on an LLM call).
            const newlyCreated = new Map();   // nodeId -> canonicalName

            for (let start = 0; start < chunks.length; start += chunksPerRequest) {
                const end = Math.min(start + chunksPerRequest, chunks.length);
                const batchChunks = chunks.slice(start, end);
                const batchTexts = batchChunks.map((c) => c.text);

                // ---- Extract (one LLM call per batch) ----
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

                // ---- Embed (one call per batch's unique entity names) ----
                const batchNames = [];
                const seenInBatch = new Set();
                for (const ex of batchResults) {
                    if (!ex) continue;
                    for (const ent of ex.entities) {
                        if (!ent?.name || seenInBatch.has(ent.name)) continue;
                        seenInBatch.add(ent.name);
                        batchNames.push(ent.name);
                    }
                }
                const nameToEmbedding = new Map();
                if (batchNames.length > 0) {
                    this.onProgress?.({ stage: 'embed', count: batchNames.length });
                    try {
                        const embeddings = await embeddingProvider.embed(batchNames);
                        for (let i = 0; i < batchNames.length; i++) {
                            nameToEmbedding.set(batchNames[i], embeddings[i]);
                        }
                    } catch (err) {
                        // No embeddings means this batch can't be resolved
                        // and the chapter would end up half-built. Surface
                        // so the chapter stays unprocessed and the user
                        // can retry — earlier batches' work IS already on
                        // disk, but the resolver dedups on retry so we
                        // won't double-create.
                        console.warn(
                            `[kg-controller] batch ${start}-${end - 1} embedding failed:`,
                            err?.message
                        );
                        throw err;
                    }
                }

                // ---- Resolve this batch's chunks ----
                for (let j = 0; j < batchChunks.length; j++) {
                    const chunkIndex = start + j;
                    this.onProgress?.({ stage: 'resolve', current: chunkIndex + 1, total: chunks.length });
                    const ex = batchResults[j];
                    if (!ex || ex.entities.length === 0) continue;

                    const nameToNodeId = new Map();
                    const nameToSentenceIndices = new Map();
                    for (const ent of ex.entities) {
                        const emb = nameToEmbedding.get(ent.name);
                        if (!emb) continue;
                        const aliases = Array.isArray(ent.aliases) ? ent.aliases : [];
                        const entSentences = matchSentencesFor(batchChunks[j], [ent.name, ...aliases]);
                        try {
                            const result = await resolver.resolve({
                                name: ent.name,
                                type: ent.type,
                                aliases,
                                bloom: ent.bloom,
                                definition: typeof ent.definition === 'string'
                                    ? ent.definition.trim()
                                    : '',
                                embedding: emb,
                                chapterIndex,
                                sentenceIndices: entSentences
                            });
                            if (result) {
                                nameToNodeId.set(ent.name, result.id);
                                nameToSentenceIndices.set(ent.name, entSentences);
                                if (result.created) {
                                    newlyCreated.set(result.id, ent.name);
                                    if (result.node) {
                                        try { this.onNodeCreated?.(result.node); }
                                        catch (e) { console.warn('[kg-controller] onNodeCreated listener threw:', e?.message); }
                                    }
                                }
                            }
                        } catch (err) {
                            console.warn(`[kg-controller] resolve failed for "${ent.name}":`, err?.message);
                        }
                    }

                    for (const r of ex.relations) {
                        const relStr = String(r.relation || '').toLowerCase().trim();
                        if (RELATION_BLACKLIST.has(relStr)) continue;
                        const sId = nameToNodeId.get(r.source);
                        const tId = nameToNodeId.get(r.target);
                        if (!sId || !tId) continue;
                        const srcS = new Set(nameToSentenceIndices.get(r.source) || []);
                        const tgtS = nameToSentenceIndices.get(r.target) || [];
                        const both = tgtS.filter((si) => srcS.has(si));
                        const edgeSentences = both.length > 0
                            ? both
                            : Array.from(new Set([...srcS, ...tgtS]));
                        try {
                            const edgeResult = await resolver.resolveEdge({
                                sourceId: sId,
                                targetId: tId,
                                relation: r.relation,
                                chapterIndex,
                                sentenceIndices: edgeSentences
                            });
                            if (edgeResult?.created && edgeResult.edge) {
                                try { this.onEdgeCreated?.(edgeResult.edge); }
                                catch (e) { console.warn('[kg-controller] onEdgeCreated listener threw:', e?.message); }
                            }
                        } catch (err) {
                            console.warn('[kg-controller] edge save failed:', err?.message);
                        }
                    }
                }

                // ---- Batch boundary: explorer settles new positions ----
                try { this.onBatchComplete?.({ batchStart: start, batchEnd: end - 1, totalChunks: chunks.length }); }
                catch (e) { console.warn('[kg-controller] onBatchComplete listener threw:', e?.message); }
            }

            // Phase E — fallback definition lookup for nodes the
            // extraction LLM declined to define (e.g. it returned an empty
            // string for "definition"). The primary path is in-band: the
            // extractor schema asks for a definition per entity and the
            // resolver persists it at creation. This pass only fires for
            // nodes that still have an empty definition AND we were given
            // a `lookupDefinition` callback to ask externally.
            const undefined_nodes = [];
            for (const [nodeId, name] of newlyCreated) {
                const node = await storage.getKGNode(nodeId);
                if (node && (!node.definition || !String(node.definition).trim())) {
                    undefined_nodes.push([nodeId, name]);
                }
            }
            if (this.lookupDefinition && undefined_nodes.length > 0) {
                this.onProgress?.({
                    stage: 'definitions',
                    total: undefined_nodes.length
                });
                let done = 0;
                await Promise.all(
                    undefined_nodes.map(async ([nodeId, name]) => {
                        try {
                            const res = await this.lookupDefinition(name);
                            // lookupService returns `{ definition, translation, ... }`
                            // — flatten to a plain string for consistency with
                            // the extractor-supplied path.
                            const def = typeof res === 'string'
                                ? res
                                : (res?.definition || '');
                            if (def) {
                                const node = await storage.getKGNode(nodeId);
                                if (node) {
                                    node.definition = String(def);
                                    node.updatedAt = Date.now();
                                    await storage.saveKGNode(node);
                                }
                            }
                        } catch (err) {
                            console.warn(
                                `[kg-controller] definition lookup failed for "${name}":`,
                                err?.message ?? String(err)
                            );
                        } finally {
                            done += 1;
                            this.onProgress?.({
                                stage: 'definitions',
                                current: done,
                                total: undefined_nodes.length
                            });
                        }
                    })
                );
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
