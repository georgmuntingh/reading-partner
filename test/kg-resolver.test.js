import { describe, it, expect, beforeEach } from 'vitest';
import { KGResolver, cosine } from '../js/services/kg-resolver.js';
import { storage } from '../js/services/storage.js';

// Build a unit-norm Float32Array embedding from a small vector
function unit(v) {
    const n = Math.hypot(...v);
    return Float32Array.from(v.map((x) => x / n));
}

beforeEach(async () => {
    await storage.init();
});

describe('cosine helper', () => {
    it('returns ~1 for identical unit vectors', () => {
        const a = unit([1, 0, 0]);
        const b = unit([1, 0, 0]);
        expect(cosine(a, b)).toBeCloseTo(1, 5);
    });
    it('returns ~0 for orthogonal unit vectors', () => {
        const a = unit([1, 0]);
        const b = unit([0, 1]);
        expect(cosine(a, b)).toBeCloseTo(0, 5);
    });
});

describe('KGResolver.resolve', () => {
    it('creates a brand-new node when the resolver is empty (initialises SM-2 stub)', async () => {
        const r = new KGResolver({ bookId: 'b1', similarityThreshold: 0.88 });
        const { id, created } = await r.resolve({
            name: 'Arthur',
            type: 'PERSON',
            aliases: ['the king'],
            bloom: 'Remember',
            embedding: unit([1, 0, 0, 0]),
            chapterIndex: 0,
            sentenceIndices: [3]
        });
        expect(created).toBe(true);
        const stored = await storage.getKGNode(id);
        expect(stored.canonicalName).toBe('Arthur');
        expect(stored.aliases).toEqual(['the king']);
        expect(stored.srs.ease).toBe(2.5);
        expect(stored.srs.interval).toBe(0);
        expect(stored.srs.repetitions).toBe(0);
        expect(stored.srs.lastReviewedAt).toBeNull();
    });

    it('takes the exact-name fast path even if the embedding is far from the existing one', async () => {
        const r = new KGResolver({ bookId: 'b1', similarityThreshold: 0.99 });
        const a = await r.resolve({
            name: 'Arthur', type: 'PERSON', aliases: [], bloom: 'Remember',
            embedding: unit([1, 0, 0, 0]), chapterIndex: 0, sentenceIndices: [0]
        });
        // Same name, orthogonal embedding — exact-name match should still merge
        const b = await r.resolve({
            name: 'Arthur', type: 'PERSON', aliases: [], bloom: 'Remember',
            embedding: unit([0, 1, 0, 0]), chapterIndex: 1, sentenceIndices: [4]
        });
        expect(b.created).toBe(false);
        expect(b.id).toBe(a.id);
    });

    it('merges into an existing node when cosine >= threshold; accumulates aliases + contexts', async () => {
        const r = new KGResolver({ bookId: 'b1', similarityThreshold: 0.88 });
        const a = await r.resolve({
            name: 'King Arthur', type: 'PERSON', aliases: [], bloom: 'Remember',
            embedding: unit([1, 0.05, 0, 0]), chapterIndex: 0, sentenceIndices: [1]
        });
        const b = await r.resolve({
            name: 'Arthur', type: 'PERSON', aliases: ['Art'], bloom: 'Remember',
            embedding: unit([1, 0.04, 0, 0]), chapterIndex: 1, sentenceIndices: [9]
        });
        expect(b.created).toBe(false);
        expect(b.id).toBe(a.id);
        const stored = await storage.getKGNode(a.id);
        expect(stored.aliases).toEqual(expect.arrayContaining(['Arthur', 'Art']));
        expect(stored.contexts.map((c) => c.chapterIndex).sort()).toEqual([0, 1]);
    });

    it('creates a separate node when cosine < threshold and names differ', async () => {
        const r = new KGResolver({ bookId: 'b1', similarityThreshold: 0.99 });
        const a = await r.resolve({
            name: 'Arthur', type: 'PERSON', aliases: [], bloom: 'Remember',
            embedding: unit([1, 0, 0, 0]), chapterIndex: 0, sentenceIndices: [0]
        });
        const b = await r.resolve({
            name: 'Excalibur', type: 'OBJECT', aliases: [], bloom: 'Remember',
            embedding: unit([0, 1, 0, 0]), chapterIndex: 0, sentenceIndices: [1]
        });
        expect(b.created).toBe(true);
        expect(b.id).not.toBe(a.id);
    });

    it('appends sentence indices to an existing chapter context without duplicating them', async () => {
        const r = new KGResolver({ bookId: 'b1', similarityThreshold: 0.5 });
        const a = await r.resolve({
            name: 'Arthur', type: 'PERSON', aliases: [], bloom: 'Remember',
            embedding: unit([1, 0, 0, 0]), chapterIndex: 0, sentenceIndices: [3, 7]
        });
        await r.resolve({
            name: 'Arthur', type: 'PERSON', aliases: [], bloom: 'Remember',
            embedding: unit([1, 0, 0, 0]), chapterIndex: 0, sentenceIndices: [7, 11]
        });
        const stored = await storage.getKGNode(a.id);
        expect(stored.contexts).toHaveLength(1);
        expect(stored.contexts[0].sentenceIndices.slice().sort((x, y) => x - y))
            .toEqual([3, 7, 11]);
    });

    it('isolates per-book scope: identical embedding in book b2 must not merge into b1', async () => {
        const r1 = new KGResolver({ bookId: 'b1', similarityThreshold: 0.5 });
        const a = await r1.resolve({
            name: 'Arthur', type: 'PERSON', aliases: [], bloom: 'Remember',
            embedding: unit([1, 0, 0, 0]), chapterIndex: 0, sentenceIndices: [0]
        });
        const r2 = new KGResolver({ bookId: 'b2', similarityThreshold: 0.5 });
        const b = await r2.resolve({
            name: 'Arthur', type: 'PERSON', aliases: [], bloom: 'Remember',
            embedding: unit([1, 0, 0, 0]), chapterIndex: 0, sentenceIndices: [0]
        });
        expect(b.created).toBe(true);
        expect(b.id).not.toBe(a.id);
    });

    it('does not add the canonical name to aliases when it equals an alias input', async () => {
        const r = new KGResolver({ bookId: 'b1', similarityThreshold: 0.5 });
        const a = await r.resolve({
            name: 'Arthur', type: 'PERSON', aliases: [], bloom: 'Remember',
            embedding: unit([1, 0, 0, 0]), chapterIndex: 0, sentenceIndices: [0]
        });
        await r.resolve({
            name: 'Arthur', type: 'PERSON', aliases: ['Arthur'], bloom: 'Remember',
            embedding: unit([1, 0, 0, 0]), chapterIndex: 1, sentenceIndices: [1]
        });
        const stored = await storage.getKGNode(a.id);
        expect(stored.aliases).not.toContain('Arthur');
    });

    it('throws if embedding is not a Float32Array', async () => {
        const r = new KGResolver({ bookId: 'b1', similarityThreshold: 0.5 });
        await expect(r.resolve({
            name: 'X', type: 'OTHER', aliases: [], bloom: 'Remember',
            embedding: [1, 0, 0, 0],
            chapterIndex: 0, sentenceIndices: [0]
        })).rejects.toThrow(/Float32Array/);
    });
});

describe('KGResolver.resolveEdge — dedup', () => {
    it('creates a new edge on first call, then merges contexts on identical (source,target,relation)', async () => {
        const r = new KGResolver({ bookId: 'b1', similarityThreshold: 0.88 });
        await r.load();
        const first = await r.resolveEdge({
            sourceId: 'n1', targetId: 'n2', relation: 'pulled from',
            chapterIndex: 0, sentenceIndices: [3]
        });
        const second = await r.resolveEdge({
            sourceId: 'n1', targetId: 'n2', relation: 'pulled from',
            chapterIndex: 0, sentenceIndices: [4]
        });
        expect(second.created).toBe(false);
        expect(second.id).toBe(first.id);
        const all = await storage.getKGEdgesForBook('b1');
        expect(all).toHaveLength(1);
        expect(all[0].contexts[0].sentenceIndices.slice().sort((x, y) => x - y))
            .toEqual([3, 4]);
    });

    it('treats the relation case-insensitively when deduping', async () => {
        const r = new KGResolver({ bookId: 'b1', similarityThreshold: 0.88 });
        const a = await r.resolveEdge({
            sourceId: 'n1', targetId: 'n2', relation: 'Pulled From',
            chapterIndex: 0, sentenceIndices: [1]
        });
        const b = await r.resolveEdge({
            sourceId: 'n1', targetId: 'n2', relation: 'pulled from',
            chapterIndex: 0, sentenceIndices: [2]
        });
        expect(b.id).toBe(a.id);
    });

    it('treats reversed (source,target) as a different edge', async () => {
        const r = new KGResolver({ bookId: 'b1', similarityThreshold: 0.88 });
        const a = await r.resolveEdge({
            sourceId: 'n1', targetId: 'n2', relation: 'X',
            chapterIndex: 0, sentenceIndices: [1]
        });
        const b = await r.resolveEdge({
            sourceId: 'n2', targetId: 'n1', relation: 'X',
            chapterIndex: 0, sentenceIndices: [1]
        });
        expect(b.id).not.toBe(a.id);
    });

    it('merges into a different chapter context within the same edge', async () => {
        const r = new KGResolver({ bookId: 'b1', similarityThreshold: 0.88 });
        const a = await r.resolveEdge({
            sourceId: 'n1', targetId: 'n2', relation: 'X',
            chapterIndex: 0, sentenceIndices: [1]
        });
        await r.resolveEdge({
            sourceId: 'n1', targetId: 'n2', relation: 'X',
            chapterIndex: 5, sentenceIndices: [9]
        });
        const stored = (await storage.getKGEdgesForBook('b1')).find((e) => e.id === a.id);
        expect(stored.contexts.map((c) => c.chapterIndex).sort()).toEqual([0, 5]);
    });
});

describe('KGResolver — Tier-2 anchor gate', () => {
    it('drops an entity whose cosine to the anchor is below relevanceThreshold', async () => {
        const anchor = unit([1, 0, 0, 0]);
        const r = new KGResolver({
            bookId: 'b1', similarityThreshold: 0.88,
            anchor, relevanceThreshold: 0.5
        });
        const out = await r.resolve({
            name: 'irrelevant',
            type: 'OTHER',
            aliases: [],
            bloom: 'Remember',
            embedding: unit([0, 1, 0, 0]),     // orthogonal → cosine = 0
            chapterIndex: 0,
            sentenceIndices: [1]
        });
        expect(out).toBeNull();
        expect(r.wasDropped('irrelevant')).toBe(true);
        // Nothing should have been saved.
        const stored = await storage.getKGNodesForBook('b1');
        expect(stored).toEqual([]);
    });

    it('keeps an entity above threshold and persists its relevanceScore', async () => {
        const anchor = unit([1, 0, 0, 0]);
        const r = new KGResolver({
            bookId: 'b1', similarityThreshold: 0.88,
            anchor, relevanceThreshold: 0.5
        });
        const out = await r.resolve({
            name: 'on-topic',
            type: 'CONCEPT',
            aliases: [],
            bloom: 'Understand',
            embedding: unit([0.9, 0.1, 0, 0]),
            chapterIndex: 0,
            sentenceIndices: [1]
        });
        expect(out).not.toBeNull();
        const stored = (await storage.getKGNodesForBook('b1'))[0];
        expect(stored.relevanceScore).toBeGreaterThan(0.5);
    });

    it('stores relevanceScore=null when no anchor is supplied', async () => {
        const r = new KGResolver({ bookId: 'b1', similarityThreshold: 0.88 });
        await r.resolve({
            name: 'X', type: 'OTHER', aliases: [], bloom: 'Remember',
            embedding: unit([1, 0, 0]),
            chapterIndex: 0, sentenceIndices: [0]
        });
        const stored = (await storage.getKGNodesForBook('b1'))[0];
        expect(stored.relevanceScore).toBeNull();
    });
});
