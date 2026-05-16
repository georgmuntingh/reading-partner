/**
 * KG Extractor
 * Splits chapter text into overlapping sentence chunks and asks the active
 * LLM (via llmClient) to extract entities + relations + Bloom level as JSON.
 *
 * Fault-tolerant by design: a single hallucinated/empty/network-failed chunk
 * MUST NOT crash the chapter pipeline. extractFromChunk returns null on any
 * failure so the controller can log + skip and continue.
 *
 * Tier-1 (prompt constriction): the system prompt is built per call from the
 * book's kgDomain so the LLM is steered toward load-bearing concepts.
 *
 * Tier-3 (regex blacklist): structurally-noisy entity names (Figure 3,
 * "Section 2.4", "[12]", "et al.") and structurally-noisy relation strings
 * ("mentioned in", "cited by") are dropped from the LLM output before the
 * resolver sees them — cheap and saves embedding calls.
 */

import { llmClient } from './llm-client.js';

/**
 * Split a list of sentences into overlapping chunks.
 *
 * @param {string[]} sentences - The chapter's sentences in reading order
 * @param {number} chunkSize - Max sentences per chunk (>=1)
 * @param {number} overlap - Sentences shared between consecutive chunks (>=0)
 * @returns {{ text: string, sentenceIndices: number[] }[]}
 */
export function chunkSentences(sentences, chunkSize, overlap) {
    if (!Array.isArray(sentences) || sentences.length === 0) return [];
    const size = Math.max(1, Math.floor(chunkSize));
    const lap = Math.max(0, Math.floor(overlap));
    // Clamp step to at least 1 so we always make progress (covers overlap >= chunkSize)
    const step = Math.max(1, size - lap);

    const chunks = [];
    for (let start = 0; start < sentences.length; start += step) {
        const end = Math.min(start + size, sentences.length);
        const slice = sentences.slice(start, end);
        const indices = [];
        for (let i = start; i < end; i++) indices.push(i);
        chunks.push({ text: slice.join(' '), sentenceIndices: indices });
        if (end === sentences.length) break;
    }
    return chunks;
}

// Tier-3 pre-embedding heuristics. Hard-coded and intentionally conservative —
// only patterns that are almost never legitimate entity names belong here.
export const STRUCTURAL_NOISE_PATTERNS = [
    /^(figure|fig\.?|table|section|chapter|page|pg\.?|appendix|eq\.?|equation)\s+\w+/i,
    /^\[?\d+\]?$/,                                                                  // bare citation numbers
    /^(et al\.?|ibid\.?|op\. ?cit\.?|cf\.?|n\.b\.?|i\.e\.?|e\.g\.?)$/i,
    /^(introduction|preface|foreword|afterword|conclusion|summary|abstract|references?|bibliography|index|glossary|acknowledg(e?)ments?)$/i,
    /^(part|volume|book)\s+[ivxlcdm0-9]+/i,
    /^\d{4}$/                                                                        // bare years
];

export const RELATION_BLACKLIST = new Set([
    'mentioned in', 'mentions', 'cited by', 'cites', 'references',
    'referenced in', 'see also', 'appears in', 'discussed in',
    'shown in', 'depicted in', 'listed in'
]);

/**
 * @param {string} name
 * @returns {boolean} true if the name looks like meta / structural text and
 *   should not be embedded or added to the graph.
 */
export function isStructuralNoise(name) {
    if (!name) return true;
    const s = String(name).trim();
    if (s.length === 0 || s.length > 80) return true;
    return STRUCTURAL_NOISE_PATTERNS.some((re) => re.test(s));
}

/**
 * Build the single-passage extraction system prompt. The `kgDomain` is
 * inlined so the LLM knows what counts as on-topic.
 *
 * @param {{ kgDomain?: string }} [opts]
 * @returns {string}
 */
export function buildExtractionSystemPrompt({ kgDomain = '' } = {}) {
    const domain = String(kgDomain || '').trim();
    const domainBlock = domain
        ? `You are extracting concepts for a learner studying ${domain}. Only include entities and relations that are load-bearing for understanding ${domain}.`
        : `You are extracting load-bearing concepts from a passage of non-fiction.`;
    const fallbackEmpty = domain
        ? `the subject of ${domain}`
        : "the book's subject";

    return `You are an information-extraction system. ${domainBlock}

STRICT RULES — apply them in order:
1. IGNORE structural / meta text: "Figure 3", "Table 1", "Section 2.4", "Chapter", "page 17", roman numerals, citations like "[12]" or "(Smith 2007)", "et al.", "ibid.", author names that are merely citing sources, and section titles like "Introduction" or "References".
2. IGNORE passing examples and incidental nouns. If a noun appears once as illustration and is not itself the topic, do NOT extract it.
3. PRIORITISE high-level concepts, mechanisms, principles, named theories, and their canonical relationships over surface details.
4. Prefer the canonical / dictionary form of a concept over an inflected mention.
5. Output JSON ONLY in the exact schema below — no commentary, no markdown.

Schema:
{
  "entities": [{ "name": string, "type": "PERSON"|"PLACE"|"OBJECT"|"EVENT"|"CONCEPT"|"OTHER", "aliases": string[], "bloom": "Remember"|"Understand"|"Apply"|"Analyze"|"Evaluate"|"Create", "definition": string }],
  "relations": [{ "source": string, "target": string, "relation": string }]
}

- "definition" is a concise one-sentence dictionary-style definition of the entity, written for a learner of ${fallbackEmpty}. Stand-alone (do not start with "is" / "are"). Omit only if the passage gives you nothing to work with.
- "source" and "target" in relations MUST exactly match an entity "name".
- If the passage contains no concepts that are load-bearing for ${fallbackEmpty}, return {"entities": [], "relations": []}.`;
}

/**
 * Build the batched (multi-passage) extraction system prompt.
 *
 * @param {{ kgDomain?: string }} [opts]
 * @returns {string}
 */
export function buildBatchExtractionSystemPrompt({ kgDomain = '' } = {}) {
    const domain = String(kgDomain || '').trim();
    const domainBlock = domain
        ? `You are extracting concepts for a learner studying ${domain}. Only include entities and relations that are load-bearing for understanding ${domain}.`
        : `You are extracting load-bearing concepts from passages of non-fiction.`;

    return `You are an information-extraction system. ${domainBlock}

STRICT RULES — apply them in order:
1. IGNORE structural / meta text: "Figure 3", "Table 1", "Section 2.4", "Chapter", "page 17", roman numerals, citations like "[12]" or "(Smith 2007)", "et al.", "ibid.", author names that are merely citing sources, and section titles like "Introduction" or "References".
2. IGNORE passing examples and incidental nouns. If a noun appears once as illustration and is not itself the topic, do NOT extract it.
3. PRIORITISE high-level concepts, mechanisms, principles, named theories, and their canonical relationships over surface details.
4. Prefer the canonical / dictionary form of a concept over an inflected mention.
5. Output JSON ONLY in the exact schema below — no commentary, no markdown.

Schema:
{
  "passages": [
    {
      "entities": [{ "name": string, "type": "PERSON"|"PLACE"|"OBJECT"|"EVENT"|"CONCEPT"|"OTHER", "aliases": string[], "bloom": "Remember"|"Understand"|"Apply"|"Analyze"|"Evaluate"|"Create", "definition": string }],
      "relations": [{ "source": string, "target": string, "relation": string }]
    }
  ]
}

- "definition" is a concise one-sentence dictionary-style definition of the entity, written for a learner. Stand-alone (do not start with "is" / "are"). Omit only if the passage gives you nothing to work with.
- "passages" MUST have exactly one entry per input passage, in the same order.
- A relation's "source" and "target" MUST exactly match an entity "name" from the SAME passage. Do NOT introduce cross-passage relations.`;
}

// Backwards-compatible "no domain" exports for tests and any caller that
// hasn't migrated to the builder form yet.
export const KG_EXTRACTION_SYSTEM_PROMPT = buildExtractionSystemPrompt();
export const KG_BATCH_EXTRACTION_SYSTEM_PROMPT = buildBatchExtractionSystemPrompt();

/**
 * Strip structurally-noisy entities and relations from a parsed LLM result.
 * Also coerces `entities`/`relations` to arrays in case the model emitted
 * `null`, omitted the key, or returned a singleton object.
 *
 * @param {{ entities?: any, relations?: any }} parsed
 * @returns {{ entities: Object[], relations: Object[] }}
 */
export function sanitizeExtraction(parsed) {
    const entities = Array.isArray(parsed?.entities) ? parsed.entities : [];
    const relations = Array.isArray(parsed?.relations) ? parsed.relations : [];

    const droppedNames = new Set();
    const cleanEntities = entities.filter((e) => {
        if (!e || typeof e !== 'object') return false;
        if (isStructuralNoise(e.name)) {
            if (typeof e.name === 'string') droppedNames.add(e.name.toLowerCase());
            return false;
        }
        return true;
    });

    const cleanRelations = relations.filter((r) => {
        if (!r || typeof r !== 'object') return false;
        const rel = String(r.relation || '').toLowerCase().trim();
        if (RELATION_BLACKLIST.has(rel)) return false;
        const src = String(r.source || '').toLowerCase();
        const tgt = String(r.target || '').toLowerCase();
        if (droppedNames.has(src) || droppedNames.has(tgt)) return false;
        return true;
    });

    return { entities: cleanEntities, relations: cleanRelations };
}

/**
 * Run the LLM extraction prompt on a single chunk of text.
 * Returns null on any failure (network error, malformed JSON, non-object).
 *
 * @param {string} chunkText
 * @param {Object} [opts]
 * @param {number} [opts.maxTokens=800]
 * @param {number} [opts.temperature=0.1]
 * @param {string} [opts.kgDomain] - The per-book domain string used to build
 *   the system prompt. Empty/omitted falls back to the no-domain variant.
 * @returns {Promise<{ entities: Object[], relations: Object[] } | null>}
 */
export async function extractFromChunk(chunkText, opts = {}) {
    const { maxTokens = 800, temperature = 0.1, kgDomain = '' } = opts;
    const system = kgDomain
        ? buildExtractionSystemPrompt({ kgDomain })
        : KG_EXTRACTION_SYSTEM_PROMPT;

    let raw;
    try {
        raw = await llmClient.complete({
            system,
            prompt: `Passage:\n${chunkText}`,
            maxTokens,
            temperature
        });
    } catch (err) {
        console.warn('[kg-extractor] LLM call failed:', err?.message ?? String(err));
        return null;
    }

    try {
        const provider = llmClient.getProvider();
        const parsed = provider.parseJSON(raw);
        if (!parsed || typeof parsed !== 'object') throw new Error('Non-object JSON');
        return sanitizeExtraction(parsed);
    } catch (err) {
        console.warn(
            '[kg-extractor] Bad JSON, skipping chunk:',
            err?.message ?? String(err),
            'raw:',
            typeof raw === 'string' ? raw.slice(0, 200) : raw
        );
        return null;
    }
}

/**
 * Batched variant: send N passages in a single LLM call and unpack a
 * per-passage entities/relations array. Returns one slot per input
 * chunk, with null for chunks the LLM failed to produce.
 *
 * If the whole batch fails (network error, malformed JSON, missing
 * `passages` array), every slot is null and the chapter pipeline moves
 * on to the next batch — the same fault-tolerance posture as the
 * single-chunk path, just at coarser granularity.
 *
 * @param {string[]} chunkTexts
 * @param {Object} [opts]
 * @param {number} [opts.temperature=0.1]
 * @param {number} [opts.maxTokensPerChunk=800]
 * @param {number} [opts.maxTokensCap=8000]
 * @param {string} [opts.kgDomain]
 * @returns {Promise<({ entities: Object[], relations: Object[] } | null)[]>}
 */
export async function extractFromChunkBatch(chunkTexts, opts = {}) {
    const {
        temperature = 0.1,
        maxTokensPerChunk = 800,
        maxTokensCap = 8000,
        kgDomain = ''
    } = opts;
    if (!Array.isArray(chunkTexts) || chunkTexts.length === 0) return [];

    // K=1 → use the single-chunk prompt to avoid asking the model to wrap
    // a one-entry passages array for no reason.
    if (chunkTexts.length === 1) {
        const single = await extractFromChunk(chunkTexts[0], {
            maxTokens: maxTokensPerChunk,
            temperature,
            kgDomain
        });
        return [single];
    }

    const prompt = `Passages:\n\n${
        chunkTexts.map((t, i) => `--- Passage ${i + 1} ---\n${t}`).join('\n\n')
    }`;
    const maxTokens = Math.min(maxTokensPerChunk * chunkTexts.length, maxTokensCap);
    const system = kgDomain
        ? buildBatchExtractionSystemPrompt({ kgDomain })
        : KG_BATCH_EXTRACTION_SYSTEM_PROMPT;

    let raw;
    try {
        raw = await llmClient.complete({
            system,
            prompt,
            maxTokens,
            temperature
        });
    } catch (err) {
        console.warn('[kg-extractor] batch LLM call failed:', err?.message ?? String(err));
        return chunkTexts.map(() => null);
    }

    try {
        const parsed = llmClient.getProvider().parseJSON(raw);
        if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.passages)) {
            throw new Error('Missing "passages" array');
        }
        return chunkTexts.map((_, i) => {
            const p = parsed.passages[i];
            if (!p || typeof p !== 'object') return null;
            return sanitizeExtraction(p);
        });
    } catch (err) {
        console.warn(
            '[kg-extractor] Bad batch JSON, skipping batch:',
            err?.message ?? String(err),
            'raw:',
            typeof raw === 'string' ? raw.slice(0, 200) : raw
        );
        return chunkTexts.map(() => null);
    }
}
