/**
 * SRS Text Retrieval
 *
 * Given a set of KG nodes (and optionally edges), fetches the actual
 * sentences from the book that mention them. This is the grounding
 * layer for Workflow 1 — the LLM card generator gets real text rather
 * than just node names, so questions and distractors reflect the
 * author's phrasing.
 *
 * Each node carries `contexts: [{ chapterIndex, sentenceIndices[] }]`
 * (chapter-relative indices, stable across reads). Edges carry the same
 * shape — the resolver populates it when an edge is first observed.
 *
 * Padding modes:
 *   - paddingSentences = N (integer)     → ±N sentences around each hit
 *   - paddingSentences = null/Infinity   → whole chapter (one window per chapter)
 *
 * Overlapping windows (from multiple hits in the same chapter) are
 * merged so the LLM sees each sentence at most once.
 */

/**
 * Collect (chapterIndex, sentenceIndex, weight) hits from nodes & edges.
 * Edges get weight 2 so an edge mention biases the "primary" anchor
 * toward where the relation was explicitly stated.
 */
function collectHits(nodes, edges) {
    const hits = [];
    if (Array.isArray(nodes)) {
        for (const n of nodes) {
            if (!Array.isArray(n?.contexts)) continue;
            for (const ctx of n.contexts) {
                if (typeof ctx?.chapterIndex !== 'number') continue;
                const indices = Array.isArray(ctx.sentenceIndices) ? ctx.sentenceIndices : [];
                for (const si of indices) {
                    if (typeof si === 'number' && si >= 0) {
                        hits.push({ chapterIndex: ctx.chapterIndex, sentenceIndex: si, weight: 1 });
                    }
                }
            }
        }
    }
    if (Array.isArray(edges)) {
        for (const e of edges) {
            if (!Array.isArray(e?.contexts)) continue;
            for (const ctx of e.contexts) {
                if (typeof ctx?.chapterIndex !== 'number') continue;
                const indices = Array.isArray(ctx.sentenceIndices) ? ctx.sentenceIndices : [];
                for (const si of indices) {
                    if (typeof si === 'number' && si >= 0) {
                        hits.push({ chapterIndex: ctx.chapterIndex, sentenceIndex: si, weight: 2 });
                    }
                }
            }
        }
    }
    return hits;
}

function groupBy(items, keyFn) {
    const out = new Map();
    for (const it of items) {
        const k = keyFn(it);
        if (!out.has(k)) out.set(k, []);
        out.get(k).push(it);
    }
    return out;
}

/**
 * Merge overlapping or adjacent [start, end] spans into a minimal set.
 * Adjacent (end+1 === next.start) spans are merged so the windows read
 * as one continuous passage.
 *
 * @param {Array<{start:number,end:number}>} spans
 * @returns {Array<{start:number,end:number}>}
 */
export function mergeOverlappingSpans(spans) {
    if (!Array.isArray(spans) || spans.length === 0) return [];
    const sorted = spans
        .filter((s) => s && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end >= s.start)
        .slice()
        .sort((a, b) => a.start - b.start || a.end - b.end);
    if (sorted.length === 0) return [];
    const out = [{ start: sorted[0].start, end: sorted[0].end }];
    for (let i = 1; i < sorted.length; i++) {
        const cur = sorted[i];
        const last = out[out.length - 1];
        if (cur.start <= last.end + 1) {
            if (cur.end > last.end) last.end = cur.end;
        } else {
            out.push({ start: cur.start, end: cur.end });
        }
    }
    return out;
}

/**
 * Pick the "primary" sentence anchor for a card — the single
 * (chapterIndex, sentenceIndex) the UI will jump to on a failed review.
 * Strategy: highest weight wins; tie-break by earliest chapter then
 * earliest sentence (so jumps land on the first mention).
 */
export function pickPrimary(hits) {
    if (!Array.isArray(hits) || hits.length === 0) return null;
    let best = hits[0];
    for (const h of hits) {
        if (
            h.weight > best.weight ||
            (h.weight === best.weight && h.chapterIndex < best.chapterIndex) ||
            (h.weight === best.weight && h.chapterIndex === best.chapterIndex && h.sentenceIndex < best.sentenceIndex)
        ) {
            best = h;
        }
    }
    return { chapterIndex: best.chapterIndex, sentenceIndex: best.sentenceIndex };
}

/**
 * @typedef {Object} ContextWindow
 * @property {number} start                 - inclusive sentence index
 * @property {number} end                   - inclusive sentence index
 * @property {string[]} sentences           - raw sentence strings
 *
 * @typedef {Object} ChapterContext
 * @property {number} chapterIndex
 * @property {ContextWindow[]} windows
 * @property {string} flatText              - tagged & joined for LLM prompt
 *
 * @typedef {Object} ContextBundle
 * @property {ChapterContext[]} chapters
 * @property {{chapterIndex:number, sentenceIndex:number}|null} primary
 * @property {number} totalSentences
 */

/**
 * Retrieve sentence-level context for a set of nodes (and optional edges)
 * from the book. Returns a bundle ready to feed into a grounded prompt.
 *
 * @param {Object} args
 * @param {Object[]} args.nodes              - KG nodes whose contexts to expand
 * @param {Object[]} [args.edges]            - optional KG edges (use edge.contexts directly)
 * @param {{loadChapter: (idx:number) => Promise<string[]>}} args.readingState
 * @param {number|null} args.paddingSentences - N; null/Infinity → whole-chapter mode
 * @returns {Promise<ContextBundle>}
 */
export async function gatherContextWindows({
    nodes,
    edges,
    readingState,
    paddingSentences
}) {
    const hits = collectHits(nodes, edges);
    if (hits.length === 0) {
        return { chapters: [], primary: null, totalSentences: 0 };
    }

    const wholeChapter = paddingSentences == null || !Number.isFinite(paddingSentences);
    const N = wholeChapter ? 0 : Math.max(0, Math.floor(paddingSentences));

    const byChapter = groupBy(hits, (h) => h.chapterIndex);
    const sortedChapters = Array.from(byChapter.keys()).sort((a, b) => a - b);

    const chapters = [];
    let totalSentences = 0;

    for (const chapterIndex of sortedChapters) {
        const chHits = byChapter.get(chapterIndex);
        const sentences = await readingState.loadChapter(chapterIndex);
        if (!Array.isArray(sentences) || sentences.length === 0) continue;
        const maxIdx = sentences.length - 1;

        const rawSpans = wholeChapter
            ? [{ start: 0, end: maxIdx }]
            : chHits.map((h) => ({
                start: Math.max(0, h.sentenceIndex - N),
                end: Math.min(maxIdx, h.sentenceIndex + N)
            }));

        const merged = mergeOverlappingSpans(rawSpans);
        if (merged.length === 0) continue;

        const windows = merged.map(({ start, end }) => ({
            start,
            end,
            sentences: sentences.slice(start, end + 1)
        }));

        const flatText = windows
            .map((w) => `[ch${chapterIndex} s${w.start}-${w.end}] ${w.sentences.join(' ')}`)
            .join('\n\n');

        for (const w of windows) totalSentences += (w.end - w.start + 1);
        chapters.push({ chapterIndex, windows, flatText });
    }

    return {
        chapters,
        primary: pickPrimary(hits),
        totalSentences
    };
}

/**
 * Intersect contexts from two records (nodes or edges) by (chapterIndex,
 * sentenceIndex). Exported for use by callers that want to gate L2/L3
 * card generation on co-occurrence of both endpoints in the same
 * sentence — not used by `gatherContextWindows` itself (edges carry
 * their own contexts from the resolver).
 *
 * @param {Object} a  record with `.contexts`
 * @param {Object} b  record with `.contexts`
 * @returns {Array<{chapterIndex:number, sentenceIndex:number}>}
 */
export function intersectContexts(a, b) {
    const setOf = (rec) => {
        const s = new Set();
        if (Array.isArray(rec?.contexts)) {
            for (const ctx of rec.contexts) {
                if (typeof ctx?.chapterIndex !== 'number') continue;
                const indices = Array.isArray(ctx.sentenceIndices) ? ctx.sentenceIndices : [];
                for (const si of indices) {
                    if (typeof si === 'number') s.add(`${ctx.chapterIndex}:${si}`);
                }
            }
        }
        return s;
    };
    const sa = setOf(a);
    const sb = setOf(b);
    const out = [];
    for (const key of sa) {
        if (sb.has(key)) {
            const [ch, si] = key.split(':').map(Number);
            out.push({ chapterIndex: ch, sentenceIndex: si });
        }
    }
    return out;
}

/**
 * Union of contexts from two records by (chapterIndex, sentenceIndex).
 * Companion to `intersectContexts` — useful as a fallback when the
 * intersection is empty.
 */
export function unionContexts(a, b) {
    const seen = new Set();
    const out = [];
    const add = (rec) => {
        if (!Array.isArray(rec?.contexts)) return;
        for (const ctx of rec.contexts) {
            if (typeof ctx?.chapterIndex !== 'number') continue;
            const indices = Array.isArray(ctx.sentenceIndices) ? ctx.sentenceIndices : [];
            for (const si of indices) {
                if (typeof si !== 'number') continue;
                const key = `${ctx.chapterIndex}:${si}`;
                if (seen.has(key)) continue;
                seen.add(key);
                out.push({ chapterIndex: ctx.chapterIndex, sentenceIndex: si });
            }
        }
    };
    add(a);
    add(b);
    return out;
}
