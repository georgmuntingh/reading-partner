import { describe, it, expect } from 'vitest';
import { mergeNodeMetadata, redirectAndDedupeEdges } from '../js/services/kg-merge.js';

const node = (over = {}) => ({
    id: 'n_p', bookId: 'b1', canonicalName: 'Mitochondrion',
    aliases: [], type: 'CONCEPT', bloom: 'Remember',
    embedding: new Float32Array([1, 0, 0]),
    relevanceScore: 0.9, definition: 'powerhouse',
    mergeCount: 3, firstSeenChapter: 1,
    srs: { ease: 2.5, interval: 0, repetitions: 0, dueAt: 1, lastReviewedAt: null },
    contexts: [{ chapterIndex: 0, sentenceIndices: [3, 5] }],
    createdAt: 100, updatedAt: 200,
    ...over
});

describe('mergeNodeMetadata', () => {
    it('keeps Primary\'s scalar fields verbatim', () => {
        const primary = node();
        const sec = node({
            id: 'n_s', canonicalName: 'mitochondria',
            type: 'OBJECT', bloom: 'Apply', relevanceScore: 0.1,
            definition: 'something else', mergeCount: 99,
            embedding: new Float32Array([0, 1, 0]),
            firstSeenChapter: 7, createdAt: 500,
            srs: { ease: 1.0, interval: 9, repetitions: 9, dueAt: 999, lastReviewedAt: 1 }
        });
        const merged = mergeNodeMetadata(primary, [sec]);
        expect(merged.id).toBe('n_p');
        expect(merged.canonicalName).toBe('Mitochondrion');
        expect(merged.type).toBe('CONCEPT');
        expect(merged.bloom).toBe('Remember');
        expect(merged.relevanceScore).toBe(0.9);
        expect(merged.definition).toBe('powerhouse');
        expect(merged.mergeCount).toBe(3);
        expect(merged.firstSeenChapter).toBe(1);
        expect(Array.from(merged.embedding)).toEqual([1, 0, 0]);
        expect(merged.srs.ease).toBe(2.5);
        expect(merged.createdAt).toBe(100);
    });

    it('unions aliases with secondary canonicalName, case-insensitively, preserving first casing', () => {
        const primary = node({ aliases: ['ATP', 'energy plant'] });
        const sec = node({
            id: 'n_s', canonicalName: 'mitochondria',
            aliases: ['atp', 'Atp', 'POWERHOUSE']
        });
        const merged = mergeNodeMetadata(primary, [sec]);
        // 'ATP' wins over the secondary 'atp'/'Atp' because the Primary's
        // alias is encountered first; secondary's canonicalName is folded
        // in; the primary's canonicalName is NOT in the alias list.
        expect(merged.aliases).toEqual(['ATP', 'energy plant', 'POWERHOUSE', 'mitochondria']);
        expect(merged.aliases).not.toContain('Mitochondrion');
    });

    it('excludes the Primary\'s canonicalName from aliases even if a Secondary supplied that spelling', () => {
        const primary = node();
        const sec = node({ id: 'n_s', canonicalName: 'MITOCHONDRION' });
        const merged = mergeNodeMetadata(primary, [sec]);
        expect(merged.aliases).toEqual([]);
    });

    it('merges contexts by chapterIndex; sentenceIndices are unioned and sorted', () => {
        const primary = node({
            contexts: [
                { chapterIndex: 0, sentenceIndices: [3, 5] },
                { chapterIndex: 2, sentenceIndices: [1] }
            ]
        });
        const sec = node({
            id: 'n_s',
            contexts: [
                { chapterIndex: 0, sentenceIndices: [4, 5, 7] },
                { chapterIndex: 1, sentenceIndices: [0] }
            ]
        });
        const merged = mergeNodeMetadata(primary, [sec]);
        expect(merged.contexts).toEqual([
            { chapterIndex: 0, sentenceIndices: [3, 4, 5, 7] },
            { chapterIndex: 1, sentenceIndices: [0] },
            { chapterIndex: 2, sentenceIndices: [1] }
        ]);
    });

    it('updates updatedAt', () => {
        const before = Date.now();
        const merged = mergeNodeMetadata(node({ updatedAt: 1 }), []);
        expect(merged.updatedAt).toBeGreaterThanOrEqual(before);
    });
});

describe('redirectAndDedupeEdges', () => {
    const edge = (over) => ({
        id: 'e?', bookId: 'b1', sourceId: 'A', targetId: 'B',
        relation: 'rel', contexts: [], createdAt: 0, ...over
    });

    it('redirects edges from Secondary to Primary', () => {
        const edges = [
            edge({ id: 'e1', sourceId: 'S', targetId: 'B' }),
            edge({ id: 'e2', sourceId: 'A', targetId: 'S' })
        ];
        const { saves, deletes } = redirectAndDedupeEdges(edges, 'P', new Set(['S']));
        expect(deletes).toEqual([]);
        expect(saves).toHaveLength(2);
        const e1 = saves.find((e) => e.id === 'e1');
        const e2 = saves.find((e) => e.id === 'e2');
        expect(e1.sourceId).toBe('P');
        expect(e1.targetId).toBe('B');
        expect(e2.sourceId).toBe('A');
        expect(e2.targetId).toBe('P');
    });

    it('drops edges that become self-loops on Primary', () => {
        const edges = [
            edge({ id: 'e1', sourceId: 'S1', targetId: 'S2' }),
            edge({ id: 'e2', sourceId: 'P', targetId: 'S1' })
        ];
        const { saves, deletes } = redirectAndDedupeEdges(
            edges, 'P', new Set(['S1', 'S2']));
        // e1: S1→S2 → P→P (self-loop, deleted)
        // e2: P→S1 → P→P (self-loop, deleted)
        expect(deletes.sort()).toEqual(['e1', 'e2']);
        expect(saves).toEqual([]);
    });

    it('drops pre-existing self-loops (source === target) even when not touched by the rewrite', () => {
        const edges = [
            edge({ id: 'e1', sourceId: 'P', targetId: 'P', relation: 'self' }),
            edge({ id: 'e2', sourceId: 'X', targetId: 'X', relation: 'orphan' }),
            edge({ id: 'e3', sourceId: 'S', targetId: 'B', relation: 'real' })
        ];
        const { saves, deletes } = redirectAndDedupeEdges(
            edges, 'P', new Set(['S']));
        // e1 + e2 are pre-existing self-loops → deleted on sight.
        // e3 is a legitimate redirect (S→B becomes P→B) → saved.
        expect(deletes.sort()).toEqual(['e1', 'e2']);
        expect(saves).toHaveLength(1);
        expect(saves[0].id).toBe('e3');
        expect(saves[0].sourceId).toBe('P');
        expect(saves[0].targetId).toBe('B');
    });

    it('dedupes by (source, target, relation): keeps lowest-id, merges contexts, deletes the rest', () => {
        const edges = [
            edge({
                id: 'e1', sourceId: 'P', targetId: 'B', relation: 'drew',
                contexts: [{ chapterIndex: 0, sentenceIndices: [1] }]
            }),
            edge({
                id: 'e2', sourceId: 'S', targetId: 'B', relation: 'DREW',
                contexts: [{ chapterIndex: 0, sentenceIndices: [2] }]
            }),
            edge({
                id: 'e3', sourceId: 'S', targetId: 'B', relation: 'drew',
                contexts: [{ chapterIndex: 1, sentenceIndices: [9] }]
            })
        ];
        const { saves, deletes } = redirectAndDedupeEdges(
            edges, 'P', new Set(['S']));
        // e2 and e3 redirect to (P,B,'drew'); collapse into e1 (lowest id).
        expect(deletes.sort()).toEqual(['e2', 'e3']);
        expect(saves).toHaveLength(1);
        expect(saves[0].id).toBe('e1');
        expect(saves[0].contexts).toEqual([
            { chapterIndex: 0, sentenceIndices: [1, 2] },
            { chapterIndex: 1, sentenceIndices: [9] }
        ]);
    });

    it('treats relation comparison case-insensitively and trims', () => {
        const edges = [
            edge({ id: 'e1', sourceId: 'P', targetId: 'B', relation: ' Drew ' }),
            edge({ id: 'e2', sourceId: 'S', targetId: 'B', relation: 'drew' })
        ];
        const { saves, deletes } = redirectAndDedupeEdges(
            edges, 'P', new Set(['S']));
        expect(deletes).toEqual(['e2']);
        expect(saves).toHaveLength(1);
    });

    it('untouched edges produce no save records', () => {
        const edges = [
            edge({ id: 'e1', sourceId: 'X', targetId: 'Y', relation: 'rel' })
        ];
        const { saves, deletes } = redirectAndDedupeEdges(
            edges, 'P', new Set(['S']));
        expect(saves).toEqual([]);
        expect(deletes).toEqual([]);
    });
});
