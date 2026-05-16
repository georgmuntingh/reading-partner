/**
 * SRS Generator — Workflow 1 (Grounded Curriculum Generation)
 *
 * Produces flashcards grounded in the actual book text. The pipeline:
 *
 *   1. Pick targets (highest-centrality nodes/edges without coverage)
 *   2. Retrieve the sentences they're mentioned in (Phase 3)
 *   3. Sample plausible distractors from the graph neighbourhood
 *   4. Ask the LLM for a JSON card payload grounded in that text
 *   5. Validate + shuffle options + persist
 *
 * L1 vs L2 throttling:
 *   The spec gates L2 generation on L1 mastery (srsBox >= 1 for both
 *   endpoints). We keep the throttle here so the LLM never wastes
 *   cycles producing cards the scheduler will hide; if a user races
 *   to mastery, the next generation pass picks up the L2s. (The
 *   scheduler's prerequisite gate is a second safety net.)
 *
 * The prompt builders and the validator are pure functions, exported
 * for direct unit testing without an LLM.
 */

import { gatherContextWindows } from './srs-text-retrieval.js';
import { rankNodesByCentrality } from './srs-centrality.js';
import { newCardDefaults } from './srs-scheduler.js';

// Number of extra neighbour names sampled beyond the distractor count,
// giving the LLM one to discard. Larger values waste tokens; 1 is enough
// for most graphs.
const DISTRACTOR_OVERSAMPLE = 1;

export const SRS_SYSTEM_PROMPT = [
    'You write multiple-choice flashcards for a reader studying a book.',
    'RULES:',
    '1. The QUESTION and CORRECT ANSWER must be derivable strictly from the CONTEXT TEXT.',
    '   Use the author\'s phrasing and analogies where possible.',
    '2. Each option must be a distinct, plausible answer. No duplicates, no trivially wrong fillers.',
    '3. The EXPLANATION (1-2 sentences) must cite which part of the CONTEXT TEXT supports the answer.',
    '4. Output JSON only, no prose, no markdown fence. Schema:',
    '   { "question": string, "options": string[], "correctIndex": integer, "explanation": string }'
].join('\n');

// ---------- Pure: prompt builders ----------

/**
 * Build the user-side prompt for a Level-1 (node definition) card.
 */
export function buildGroundedNodePrompt({
    targetConcept,
    targetDefinition,
    contextText,
    candidateDistractors,
    distractorCount,
    wholeChapter
}) {
    const optionCount = distractorCount + 1;
    const lines = [
        `TARGET CONCEPT: ${targetConcept}`
    ];
    if (targetDefinition) {
        lines.push(`KNOWN DEFINITION: ${targetDefinition}`);
    }
    lines.push('');
    lines.push('CONTEXT TEXT:');
    lines.push(contextText);
    lines.push('');
    if (wholeChapter) {
        lines.push(
            `Pick ${distractorCount} DISTRACTORS by selecting other concepts mentioned in ` +
            'the CONTEXT TEXT that a reader could plausibly confuse with the correct answer.'
        );
    } else if (Array.isArray(candidateDistractors) && candidateDistractors.length > 0) {
        lines.push(
            `Pick ${distractorCount} DISTRACTORS from these CANDIDATE DISTRACTORS ` +
            '(real concepts from this book the reader could confuse with the answer). ' +
            'You may rephrase slightly but do not invent unrelated terms:'
        );
        for (const d of candidateDistractors) lines.push(`- ${d}`);
    } else {
        lines.push(
            `Pick ${distractorCount} DISTRACTORS that are plausible misreadings of the ` +
            'CONTEXT TEXT — concepts that sound related but are not what the passage says.'
        );
    }
    lines.push('');
    lines.push(`Write ONE multiple-choice flashcard testing the reader's grasp of "${targetConcept}".`);
    lines.push(`Output exactly ${optionCount} options.`);
    return lines.join('\n');
}

/**
 * Build the user-side prompt for a Level-2 (edge relation) card.
 */
export function buildGroundedEdgePrompt({
    sourceConcept,
    targetConcept,
    relation,
    contextText,
    candidateDistractors,
    distractorCount,
    wholeChapter
}) {
    const optionCount = distractorCount + 1;
    const lines = [
        `RELATION: ${sourceConcept} — [${relation}] → ${targetConcept}`,
        '',
        'CONTEXT TEXT:',
        contextText,
        ''
    ];
    if (wholeChapter) {
        lines.push(
            `Pick ${distractorCount} DISTRACTORS by selecting other concepts mentioned in ` +
            'the CONTEXT TEXT that could plausibly be confused with the correct entity in the relation.'
        );
    } else if (Array.isArray(candidateDistractors) && candidateDistractors.length > 0) {
        lines.push(
            `Pick ${distractorCount} DISTRACTORS from these related concepts in the book ` +
            '(use them as wrong entities the reader could plausibly substitute):'
        );
        for (const d of candidateDistractors) lines.push(`- ${d}`);
    }
    lines.push('');
    lines.push(
        `Write ONE multiple-choice question testing the reader's grasp of the relation ` +
        `"${sourceConcept} ${relation} ${targetConcept}". The question should require the ` +
        'reader to discriminate the correct entity from the distractors.'
    );
    lines.push(`Output exactly ${optionCount} options.`);
    return lines.join('\n');
}

// ---------- Pure: validation ----------

/**
 * Validate an LLM JSON payload for a flashcard. Returns true iff the
 * payload is structurally sound enough to persist as a card.
 */
export function validateCardPayload(parsed, expectedOptionCount) {
    if (!parsed || typeof parsed !== 'object') return false;
    if (typeof parsed.question !== 'string' || !parsed.question.trim()) return false;
    if (!Array.isArray(parsed.options)) return false;
    if (parsed.options.length !== expectedOptionCount) return false;
    if (!parsed.options.every((o) => typeof o === 'string' && o.trim().length > 0)) return false;
    if (!Number.isInteger(parsed.correctIndex)) return false;
    if (parsed.correctIndex < 0 || parsed.correctIndex >= parsed.options.length) return false;
    if (typeof parsed.explanation !== 'string' || !parsed.explanation.trim()) return false;
    const lower = parsed.options.map((o) => o.trim().toLowerCase());
    if (new Set(lower).size !== lower.length) return false;
    return true;
}

// ---------- Pure: shuffle options to remove positional bias ----------

/**
 * Shuffle a payload's options and remap correctIndex. Pulls randomness
 * from `rng` (default Math.random) so tests can inject determinism.
 */
export function shuffleOptions(payload, rng = Math.random) {
    const n = payload.options.length;
    const order = payload.options.map((_, i) => i);
    for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
    }
    const correctOrigIndex = payload.correctIndex;
    const options = order.map((i) => payload.options[i]);
    const correctIndex = order.indexOf(correctOrigIndex);
    return { ...payload, options, correctIndex };
}

// ---------- Helpers ----------

function neighborNodeIds(nodeId, edges) {
    const out = new Set();
    for (const e of edges) {
        if (!e) continue;
        if (e.sourceId === nodeId && e.targetId && e.targetId !== nodeId) out.add(e.targetId);
        else if (e.targetId === nodeId && e.sourceId && e.sourceId !== nodeId) out.add(e.sourceId);
    }
    return Array.from(out);
}

function sampleDistractors(neighborIds, allNodes, count) {
    const names = [];
    for (const nid of neighborIds) {
        const n = allNodes.find((x) => x.id === nid);
        if (n?.canonicalName) names.push(n.canonicalName);
        if (names.length >= count) break;
    }
    return names;
}

function uuid() {
    return (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

// ---------- Class ----------

export class SRSGenerator {
    /**
     * @param {Object} deps
     * @param {Object} deps.storage          - StorageService instance
     * @param {Object} deps.readingState     - { loadChapter(idx) => Promise<string[]> }
     * @param {Object} deps.llmClient        - { complete({system,prompt,...}), getProvider().parseJSON }
     * @param {Object} deps.settings         - SRS settings (padding, distractor count, etc.)
     * @param {Object} [deps.logger]
     */
    constructor({ storage, readingState, llmClient, settings, logger = console }) {
        this.storage = storage;
        this.readingState = readingState;
        this.llmClient = llmClient;
        this.settings = settings;
        this.logger = logger;
    }

    _paddingArg() {
        return this.settings?.srsPaddingMode === 'whole-chapter'
            ? null
            : (this.settings?.srsPaddingSentences ?? 3);
    }

    _distractorCount() {
        const n = this.settings?.srsDistractorCount;
        return Number.isInteger(n) && n >= 1 ? n : 3;
    }

    _temperature() {
        const t = this.settings?.srsLLMTemperature;
        return Number.isFinite(t) ? t : 0.4;
    }

    /**
     * Call the LLM, parse JSON, validate, and shuffle. Returns the
     * shuffled payload or null on any failure.
     */
    async _callLLM(prompt, expectedOptionCount) {
        let raw;
        try {
            raw = await this.llmClient.complete({
                system: SRS_SYSTEM_PROMPT,
                prompt,
                maxTokens: 600,
                temperature: this._temperature()
            });
        } catch (err) {
            this.logger.warn?.('[srs-generator] LLM call failed:', err?.message || err);
            return null;
        }
        let parsed;
        try {
            parsed = this.llmClient.getProvider().parseJSON(raw);
        } catch (err) {
            this.logger.warn?.('[srs-generator] LLM output JSON parse failed:', err?.message || err);
            return null;
        }
        if (!validateCardPayload(parsed, expectedOptionCount)) {
            this.logger.warn?.('[srs-generator] card payload failed validation');
            return null;
        }
        return shuffleOptions(parsed);
    }

    // ---------- Level 1 (node definition) ----------

    /**
     * Produce one L1 card for a single node, or null if generation
     * fails (no context, LLM error, invalid payload).
     */
    async generateForNode(node, allNodes, allEdges) {
        const padding = this._paddingArg();
        const wholeChapter = padding == null;
        const bundle = await gatherContextWindows({
            nodes: [node],
            edges: [],
            readingState: this.readingState,
            paddingSentences: padding
        });
        if (bundle.chapters.length === 0) return null;

        const distractorCount = this._distractorCount();
        const candidates = wholeChapter
            ? []
            : sampleDistractors(neighborNodeIds(node.id, allEdges), allNodes,
                distractorCount + DISTRACTOR_OVERSAMPLE);

        const contextText = bundle.chapters.map((c) => c.flatText).join('\n\n');
        const prompt = buildGroundedNodePrompt({
            targetConcept: node.canonicalName,
            targetDefinition: node.definition,
            contextText,
            candidateDistractors: candidates,
            distractorCount,
            wholeChapter
        });

        const payload = await this._callLLM(prompt, distractorCount + 1);
        if (!payload) return null;

        const now = Date.now();
        return {
            id: `fc_${uuid()}`,
            bookId: node.bookId,
            cognitiveLevel: 1,
            targetNodeIds: [node.id],
            targetEdgeIds: [],
            question: payload.question.trim(),
            options: payload.options.map((o) => o.trim()),
            correctIndex: payload.correctIndex,
            explanation: payload.explanation.trim(),
            primaryChapterIndex: bundle.primary?.chapterIndex ?? 0,
            primarySentenceIndex: bundle.primary?.sentenceIndex ?? 0,
            ...newCardDefaults(this.settings, now)
        };
    }

    // ---------- Level 2 (edge relation) ----------

    /**
     * Produce one L2 card for a single edge, or null. The edge is
     * gated on L1 mastery of BOTH endpoints — if either endpoint
     * lacks an L1 card with srsBox >= 1, we skip (the scheduler would
     * hide the card anyway, so we save the LLM round-trip).
     */
    async generateForEdge(edge, allNodes, allEdges) {
        const sourceNode = allNodes.find((n) => n.id === edge.sourceId);
        const targetNode = allNodes.find((n) => n.id === edge.targetId);
        if (!sourceNode || !targetNode) return null;

        // L1 mastery throttle (spec Workflow 1, step 4).
        const existing = await this.storage.getFlashcardsForBook(edge.bookId);
        const masteredNode = (nid) => existing.some(
            (c) => c.cognitiveLevel === 1 &&
                   Array.isArray(c.targetNodeIds) &&
                   c.targetNodeIds.includes(nid) &&
                   c.srsBox >= 1
        );
        if (!masteredNode(edge.sourceId) || !masteredNode(edge.targetId)) return null;

        const padding = this._paddingArg();
        const wholeChapter = padding == null;
        const bundle = await gatherContextWindows({
            nodes: [],
            edges: [edge],
            readingState: this.readingState,
            paddingSentences: padding
        });
        if (bundle.chapters.length === 0) return null;

        const distractorCount = this._distractorCount();
        // Distractors: neighbours of the source (excluding the target itself).
        const candidates = wholeChapter
            ? []
            : sampleDistractors(
                neighborNodeIds(edge.sourceId, allEdges).filter((id) => id !== edge.targetId),
                allNodes,
                distractorCount + DISTRACTOR_OVERSAMPLE
            );

        const contextText = bundle.chapters.map((c) => c.flatText).join('\n\n');
        const prompt = buildGroundedEdgePrompt({
            sourceConcept: sourceNode.canonicalName,
            targetConcept: targetNode.canonicalName,
            relation: edge.relation,
            contextText,
            candidateDistractors: candidates,
            distractorCount,
            wholeChapter
        });

        const payload = await this._callLLM(prompt, distractorCount + 1);
        if (!payload) return null;

        const now = Date.now();
        return {
            id: `fc_${uuid()}`,
            bookId: edge.bookId,
            cognitiveLevel: 2,
            targetNodeIds: [edge.sourceId, edge.targetId],
            targetEdgeIds: [edge.id],
            question: payload.question.trim(),
            options: payload.options.map((o) => o.trim()),
            correctIndex: payload.correctIndex,
            explanation: payload.explanation.trim(),
            primaryChapterIndex: bundle.primary?.chapterIndex ?? 0,
            primarySentenceIndex: bundle.primary?.sentenceIndex ?? 0,
            ...newCardDefaults(this.settings, now)
        };
    }

    // ---------- Batch entry points ----------

    /**
     * Generate up to `maxCards` cards for a book. Picks the highest-
     * centrality uncovered nodes first, then attempts L2 cards for any
     * edges whose L1 prereqs are mastered.
     */
    async generateForBook(bookId, opts = {}) {
        const maxCards = opts.maxCards ?? 20;
        const [nodes, edges, existing] = await Promise.all([
            this.storage.getKGNodesForBook(bookId),
            this.storage.getKGEdgesForBook(bookId),
            this.storage.getFlashcardsForBook(bookId)
        ]);

        const coveredNodeIds = new Set();
        const coveredEdgeIds = new Set();
        for (const c of existing) {
            if (c.cognitiveLevel === 1) {
                for (const nid of (c.targetNodeIds || [])) coveredNodeIds.add(nid);
            }
            if (c.cognitiveLevel === 2) {
                for (const eid of (c.targetEdgeIds || [])) coveredEdgeIds.add(eid);
            }
        }

        const candidateNodes = nodes.filter((n) => !coveredNodeIds.has(n.id));
        const ranked = rankNodesByCentrality(candidateNodes, edges);
        const targets = ranked.slice(0, maxCards).map((r) => r.node);

        const newCards = [];
        // Sequential — local LLMs cannot handle parallel inference and
        // cloud quotas don't appreciate it either.
        for (const node of targets) {
            const card = await this.generateForNode(node, nodes, edges);
            if (card) newCards.push(card);
        }

        // L2 pass: try edges whose endpoints are both mastered. Limited
        // to whatever budget remains; produces nothing on a fresh book.
        const l2Budget = Math.max(0, maxCards - newCards.length);
        if (l2Budget > 0) {
            const candidateEdges = edges.filter((e) => !coveredEdgeIds.has(e.id));
            for (const edge of candidateEdges) {
                if (newCards.length - (maxCards - l2Budget) >= l2Budget) break;
                const card = await this.generateForEdge(edge, nodes, edges);
                if (card) newCards.push(card);
            }
        }

        if (newCards.length > 0) {
            await this.storage.bulkPutFlashcards(newCards);
        }
        return newCards;
    }

    /**
     * Generate cards for nodes first seen in a specific chapter. Used
     * by the on-chapter-finish trigger.
     */
    async generateForChapter(bookId, chapterIndex, opts = {}) {
        const maxCards = opts.maxCards ?? 10;
        const [nodes, edges, existing] = await Promise.all([
            this.storage.getKGNodesForBook(bookId),
            this.storage.getKGEdgesForBook(bookId),
            this.storage.getFlashcardsForBook(bookId)
        ]);

        const coveredNodeIds = new Set();
        for (const c of existing) {
            if (c.cognitiveLevel === 1) {
                for (const nid of (c.targetNodeIds || [])) coveredNodeIds.add(nid);
            }
        }

        const chapterNodes = nodes.filter(
            (n) => n.firstSeenChapter === chapterIndex && !coveredNodeIds.has(n.id)
        );
        const ranked = rankNodesByCentrality(chapterNodes, edges);
        const targets = ranked.slice(0, maxCards).map((r) => r.node);

        const newCards = [];
        for (const node of targets) {
            const card = await this.generateForNode(node, nodes, edges);
            if (card) newCards.push(card);
        }
        if (newCards.length > 0) {
            await this.storage.bulkPutFlashcards(newCards);
        }
        return newCards;
    }
}
