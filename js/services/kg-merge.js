/**
 * KG Merge Helpers
 * Pure functions for merging multiple kg_node records into a user-designated
 * Primary, and for redirecting + deduplicating the edges incident to the
 * merged Secondary nodes.
 *
 * The Primary is the survivor: its id, canonicalName, type, bloom, embedding,
 * relevanceScore, mergeCount, firstSeenChapter, srs, definition, and createdAt
 * are preserved verbatim. Secondaries contribute aliases (with their own
 * canonicalNames folded in) and contexts only.
 */

/**
 * Case-insensitive de-duplication that preserves the first variant's casing.
 * Used so a clash like ['ATP', 'atp'] keeps 'ATP' (Primary's variant when
 * Primary's aliases are processed first) instead of producing ['ATP','atp'].
 */
function uniqueCaseInsensitive(values, excludeLower = new Set()) {
    const out = [];
    const seen = new Set(excludeLower);
    for (const v of values) {
        if (typeof v !== 'string') continue;
        const trimmed = v.trim();
        if (!trimmed) continue;
        const key = trimmed.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(trimmed);
    }
    return out;
}

/**
 * Merge a list of `contexts` arrays into a single canonical array.
 * Within each chapterIndex, sentenceIndices are unioned and sorted ascending.
 * Matches the per-chapter shape the resolver maintains (see kg-resolver.js
 * resolve() — one row per chapterIndex, never duplicates).
 */
function mergeContextArrays(arrays) {
    const byChapter = new Map();   // chapterIndex -> Set<sentenceIndex>
    for (const arr of arrays) {
        if (!Array.isArray(arr)) continue;
        for (const c of arr) {
            if (!c || !Number.isInteger(c.chapterIndex)) continue;
            let bucket = byChapter.get(c.chapterIndex);
            if (!bucket) {
                bucket = new Set();
                byChapter.set(c.chapterIndex, bucket);
            }
            for (const si of c.sentenceIndices || []) {
                if (Number.isInteger(si)) bucket.add(si);
            }
        }
    }
    const out = [];
    for (const [chapterIndex, set] of byChapter) {
        out.push({
            chapterIndex,
            sentenceIndices: Array.from(set).sort((a, b) => a - b)
        });
    }
    out.sort((a, b) => a.chapterIndex - b.chapterIndex);
    return out;
}

/**
 * Build the surviving Primary node by folding every Secondary into it.
 * Primary scalars win on every field except aliases (unioned with secondary
 * canonicalNames) and contexts (chapter-wise unioned).
 *
 * @param {Object} primary
 * @param {Object[]} secondaries
 * @returns {Object} A new node record ready to persist.
 */
export function mergeNodeMetadata(primary, secondaries) {
    if (!primary || typeof primary !== 'object') {
        throw new Error('mergeNodeMetadata: primary required');
    }
    const others = Array.isArray(secondaries) ? secondaries : [];

    // Case-insensitive aliases. Exclude the primary's canonicalName so it
    // can never end up duplicated as one of its own aliases.
    const primaryNameKey = String(primary.canonicalName || '').trim().toLowerCase();
    const aliasInputs = [
        ...(Array.isArray(primary.aliases) ? primary.aliases : []),
        ...others.flatMap((s) => ([
            ...(Array.isArray(s?.aliases) ? s.aliases : []),
            // Secondary's canonicalName becomes one of the survivor's aliases.
            ...(s?.canonicalName ? [s.canonicalName] : [])
        ]))
    ];
    const aliases = uniqueCaseInsensitive(
        aliasInputs,
        primaryNameKey ? new Set([primaryNameKey]) : new Set()
    );

    const contexts = mergeContextArrays([
        primary.contexts,
        ...others.map((s) => s?.contexts)
    ]);

    return {
        ...primary,
        aliases,
        contexts,
        updatedAt: Date.now()
    };
}

function edgeKey(sourceId, targetId, relation) {
    return `${sourceId}|${targetId}|${String(relation || '').toLowerCase().trim()}`;
}

/**
 * For every edge incident to a Secondary, rewrite its endpoint(s) to point at
 * the Primary. Drop the edge if the rewrite collapses it to a self-loop on
 * the Primary. Dedupe by (sourceId, targetId, relation.toLowerCase().trim()):
 * when multiple edges collapse to the same key, keep the lowest-id one and
 * merge the rest's contexts into it.
 *
 * @param {Object[]} edges - All edges potentially affected (typically the
 *   full set for the book; the function filters internally).
 * @param {string} primaryId
 * @param {Set<string>} secondaryIdSet
 * @returns {{ saves: Object[], deletes: string[] }}
 *   `saves` is the set of edges whose stored representation has changed
 *   (endpoints rewritten and/or contexts extended). `deletes` is the set of
 *   edge ids that should be removed from the store (duplicates absorbed into
 *   another edge, or self-loops that resulted from the rewrite).
 */
export function redirectAndDedupeEdges(edges, primaryId, secondaryIdSet) {
    if (!Array.isArray(edges)) return { saves: [], deletes: [] };
    const secondaries = secondaryIdSet instanceof Set
        ? secondaryIdSet
        : new Set(secondaryIdSet || []);

    const deletes = [];
    // Working copies of edges that survive the rewrite (and are not self-loops).
    const survivors = [];
    const dirtyIds = new Set();   // edges whose source/target/contexts changed

    for (const original of edges) {
        if (!original || typeof original !== 'object') continue;
        // Pre-existing self-loops (source === target on the same node) are
        // meaningless data — for the merge case the user expects every
        // self-loop on the survivor cleaned up, not just the freshly-
        // collapsed ones. Drop any self-loop we encounter, regardless of
        // whether the merge created it.
        if (original.sourceId === original.targetId) {
            deletes.push(original.id);
            continue;
        }
        const involvesSecondary = secondaries.has(original.sourceId)
            || secondaries.has(original.targetId);
        if (!involvesSecondary) {
            survivors.push(original);
            continue;
        }
        const next = { ...original };
        if (secondaries.has(next.sourceId)) next.sourceId = primaryId;
        if (secondaries.has(next.targetId)) next.targetId = primaryId;
        // Self-loop on Primary is meaningless; drop. (Redundant with the
        // top-of-loop guard for edges that were already a self-loop, but
        // still needed for edges that only become one after the rewrite.)
        if (next.sourceId === next.targetId) {
            deletes.push(original.id);
            continue;
        }
        dirtyIds.add(next.id);
        survivors.push(next);
    }

    // Dedupe by canonical key. Keep the lowest-id representative; absorb the
    // rest into it and queue them for deletion.
    const byKey = new Map();
    for (const e of survivors) {
        const key = edgeKey(e.sourceId, e.targetId, e.relation);
        const incumbent = byKey.get(key);
        if (!incumbent) {
            byKey.set(key, e);
            continue;
        }
        // Pick the lower-id one as the canonical survivor.
        const [keep, drop] = incumbent.id <= e.id ? [incumbent, e] : [e, incumbent];
        const mergedContexts = mergeContextArrays([keep.contexts, drop.contexts]);
        const merged = { ...keep, contexts: mergedContexts };
        byKey.set(key, merged);
        dirtyIds.add(merged.id);
        deletes.push(drop.id);
    }

    // saves = only edges that changed (avoid rewriting untouched rows).
    const saves = [];
    for (const e of byKey.values()) {
        if (dirtyIds.has(e.id)) saves.push(e);
    }

    return { saves, deletes };
}
