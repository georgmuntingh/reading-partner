import { describe, it, expect, beforeEach } from 'vitest';
import { StorageService } from '../js/services/storage.js';

describe('storage v4 migration + KG CRUD', () => {
    let storage;

    beforeEach(async () => {
        storage = new StorageService();
        await storage.init();
    });

    it('opens DB at version 4 with kg_nodes and kg_edges stores', () => {
        const names = Array.from(storage._db.objectStoreNames);
        expect(names).toContain('kg_nodes');
        expect(names).toContain('kg_edges');
        expect(storage._db.version).toBe(4);
    });

    it('preserves existing stores after the v4 upgrade', () => {
        const names = Array.from(storage._db.objectStoreNames);
        expect(names).toEqual(expect.arrayContaining(['books', 'positions', 'bookmarks', 'settings', 'highlights', 'lookups']));
    });

    it('round-trips a kg node with a Float32Array embedding', async () => {
        const emb = Float32Array.from([0.1, 0.2, 0.3]);
        const node = {
            id: 'kgnode_a',
            bookId: 'b1',
            canonicalName: 'Arthur',
            aliases: ['the king'],
            type: 'PERSON',
            bloom: 'Remember',
            embedding: emb,
            contexts: [{ chapterIndex: 0, sentenceIndices: [3] }],
            firstSeenChapter: 0,
            srs: { ease: 2.5, interval: 0, repetitions: 0, dueAt: 1, lastReviewedAt: null },
            createdAt: 1,
            updatedAt: 1
        };
        await storage.saveKGNode(node);
        const got = await storage.getKGNode('kgnode_a');
        expect(got.canonicalName).toBe('Arthur');
        expect(got.aliases).toEqual(['the king']);
        expect(got.srs.ease).toBe(2.5);
        // structured-clone preserves typed arrays; values should round-trip
        expect(Array.from(got.embedding)).toEqual([
            expect.closeTo(0.1, 5),
            expect.closeTo(0.2, 5),
            expect.closeTo(0.3, 5)
        ]);
    });

    it('returns null for an unknown KG node id', async () => {
        const got = await storage.getKGNode('does-not-exist');
        expect(got).toBeNull();
    });

    it('getKGNodesForBook returns only nodes scoped to the requested book', async () => {
        await storage.saveKGNode({
            id: 'n1', bookId: 'b1', canonicalName: 'X', aliases: [], type: 'OTHER',
            bloom: 'Remember', embedding: new Float32Array(1), contexts: [],
            firstSeenChapter: 0, srs: {}, createdAt: 0, updatedAt: 0
        });
        await storage.saveKGNode({
            id: 'n2', bookId: 'b2', canonicalName: 'Y', aliases: [], type: 'OTHER',
            bloom: 'Remember', embedding: new Float32Array(1), contexts: [],
            firstSeenChapter: 0, srs: {}, createdAt: 0, updatedAt: 0
        });

        const fromB1 = await storage.getKGNodesForBook('b1');
        const fromB2 = await storage.getKGNodesForBook('b2');
        expect(fromB1).toHaveLength(1);
        expect(fromB1[0].id).toBe('n1');
        expect(fromB2).toHaveLength(1);
        expect(fromB2[0].id).toBe('n2');
    });

    it('getKGNodesForBook returns an empty array when no nodes exist for the book', async () => {
        const got = await storage.getKGNodesForBook('nonexistent');
        expect(got).toEqual([]);
    });

    it('saveKGEdge round-trips and getKGEdgesForBook returns edges scoped to the book', async () => {
        const edge = {
            id: 'e1',
            bookId: 'b1',
            sourceId: 'n1',
            targetId: 'n2',
            relation: 'pulled from',
            contexts: [{ chapterIndex: 0, sentenceIndices: [7] }],
            createdAt: 1
        };
        await storage.saveKGEdge(edge);
        await storage.saveKGEdge({ ...edge, id: 'e2', bookId: 'b2' });

        const fromB1 = await storage.getKGEdgesForBook('b1');
        expect(fromB1).toHaveLength(1);
        expect(fromB1[0].relation).toBe('pulled from');
        expect(fromB1[0].sourceId).toBe('n1');
    });

    it('saveKGEdge with the same id overwrites (used by edge dedup)', async () => {
        const edge = {
            id: 'e1', bookId: 'b1', sourceId: 'n1', targetId: 'n2', relation: 'X',
            contexts: [{ chapterIndex: 0, sentenceIndices: [1] }], createdAt: 0
        };
        await storage.saveKGEdge(edge);
        await storage.saveKGEdge({
            ...edge,
            contexts: [{ chapterIndex: 0, sentenceIndices: [1, 2] }]
        });
        const all = await storage.getKGEdgesForBook('b1');
        expect(all).toHaveLength(1);
        expect(all[0].contexts[0].sentenceIndices).toEqual([1, 2]);
    });

    it('clearKGForBook removes nodes and edges only for the requested book', async () => {
        await storage.saveKGNode({
            id: 'n1', bookId: 'b1', canonicalName: 'X', aliases: [], type: 'OTHER',
            bloom: 'Remember', embedding: new Float32Array(1), contexts: [],
            firstSeenChapter: 0, srs: {}, createdAt: 0, updatedAt: 0
        });
        await storage.saveKGEdge({
            id: 'e1', bookId: 'b1', sourceId: 'n1', targetId: 'n1', relation: 'self',
            contexts: [], createdAt: 0
        });
        await storage.saveKGNode({
            id: 'n2', bookId: 'b2', canonicalName: 'Y', aliases: [], type: 'OTHER',
            bloom: 'Remember', embedding: new Float32Array(1), contexts: [],
            firstSeenChapter: 0, srs: {}, createdAt: 0, updatedAt: 0
        });
        await storage.saveKGEdge({
            id: 'e2', bookId: 'b2', sourceId: 'n2', targetId: 'n2', relation: 'self',
            contexts: [], createdAt: 0
        });

        await storage.clearKGForBook('b1');

        expect(await storage.getKGNodesForBook('b1')).toHaveLength(0);
        expect(await storage.getKGEdgesForBook('b1')).toHaveLength(0);
        expect(await storage.getKGNodesForBook('b2')).toHaveLength(1);
        expect(await storage.getKGEdgesForBook('b2')).toHaveLength(1);
    });

    it('deleteKGNode removes a single node by id and leaves siblings intact', async () => {
        const base = (id) => ({
            id, bookId: 'b1', canonicalName: id, aliases: [], type: 'OTHER',
            bloom: 'Remember', embedding: new Float32Array(1), contexts: [],
            firstSeenChapter: 0, srs: {}, createdAt: 0, updatedAt: 0
        });
        await storage.saveKGNode(base('n1'));
        await storage.saveKGNode(base('n2'));
        await storage.deleteKGNode('n1');
        const remaining = await storage.getKGNodesForBook('b1');
        expect(remaining.map((n) => n.id)).toEqual(['n2']);
    });

    it('deleteKGEdge removes a single edge by id', async () => {
        await storage.saveKGEdge({
            id: 'e1', bookId: 'b1', sourceId: 'a', targetId: 'b', relation: 'r',
            contexts: [], createdAt: 0
        });
        await storage.saveKGEdge({
            id: 'e2', bookId: 'b1', sourceId: 'a', targetId: 'c', relation: 'r',
            contexts: [], createdAt: 0
        });
        await storage.deleteKGEdge('e1');
        const all = await storage.getKGEdgesForBook('b1');
        expect(all.map((e) => e.id)).toEqual(['e2']);
    });

    it('applyMergeTransaction is atomic across kg_nodes and kg_edges', async () => {
        const base = (id) => ({
            id, bookId: 'b1', canonicalName: id, aliases: [], type: 'OTHER',
            bloom: 'Remember', embedding: new Float32Array(1), contexts: [],
            firstSeenChapter: 0, srs: {}, createdAt: 0, updatedAt: 0
        });
        await storage.saveKGNode(base('P'));
        await storage.saveKGNode(base('S'));
        await storage.saveKGEdge({
            id: 'e_keep', bookId: 'b1', sourceId: 'P', targetId: 'P_OTHER',
            relation: 'k', contexts: [], createdAt: 0
        });
        await storage.saveKGEdge({
            id: 'e_dup', bookId: 'b1', sourceId: 'S', targetId: 'P_OTHER',
            relation: 'k', contexts: [{ chapterIndex: 0, sentenceIndices: [4] }],
            createdAt: 0
        });

        await storage.applyMergeTransaction({
            updatedNode: { ...base('P'), canonicalName: 'P', aliases: ['S-name'] },
            deletedNodeIds: ['S'],
            savedEdges: [{
                id: 'e_keep', bookId: 'b1', sourceId: 'P', targetId: 'P_OTHER',
                relation: 'k',
                contexts: [{ chapterIndex: 0, sentenceIndices: [4] }],
                createdAt: 0
            }],
            deletedEdgeIds: ['e_dup']
        });

        const nodes = await storage.getKGNodesForBook('b1');
        expect(nodes.map((n) => n.id).sort()).toEqual(['P']);
        expect(nodes[0].aliases).toEqual(['S-name']);

        const edges = await storage.getKGEdgesForBook('b1');
        expect(edges.map((e) => e.id)).toEqual(['e_keep']);
        expect(edges[0].contexts[0].sentenceIndices).toEqual([4]);
    });

    it('applyDeleteTransaction removes nodes and edges in one shot', async () => {
        const base = (id) => ({
            id, bookId: 'b1', canonicalName: id, aliases: [], type: 'OTHER',
            bloom: 'Remember', embedding: new Float32Array(1), contexts: [],
            firstSeenChapter: 0, srs: {}, createdAt: 0, updatedAt: 0
        });
        await storage.saveKGNode(base('n1'));
        await storage.saveKGNode(base('n2'));
        await storage.saveKGEdge({
            id: 'e1', bookId: 'b1', sourceId: 'n1', targetId: 'n2', relation: 'r',
            contexts: [], createdAt: 0
        });
        await storage.applyDeleteTransaction({
            deletedNodeIds: ['n1'],
            deletedEdgeIds: ['e1']
        });
        const nodes = await storage.getKGNodesForBook('b1');
        const edges = await storage.getKGEdgesForBook('b1');
        expect(nodes.map((n) => n.id)).toEqual(['n2']);
        expect(edges).toEqual([]);
    });

    it('persists and reads KG settings via the existing settings store', async () => {
        await storage.saveSetting('kgExtractionBackend', 'local');
        await storage.saveSetting('kgChunkSize', 6);
        await storage.saveSetting('kgChunkOverlap', 2);
        await storage.saveSetting('kgSimilarityThreshold', 0.88);

        expect(await storage.getSetting('kgExtractionBackend')).toBe('local');
        expect(await storage.getSetting('kgChunkSize')).toBe(6);
        expect(await storage.getSetting('kgChunkOverlap')).toBe(2);
        expect(await storage.getSetting('kgSimilarityThreshold')).toBe(0.88);
    });

    it('saveBook strips transient chapter caches (html / sentences / loaded) so blob URLs do not survive a reload', async () => {
        const book = {
            id: 'b-blob',
            title: 'T',
            chapters: [
                {
                    title: 'Ch 1',
                    href: 'ch1.xhtml',
                    kgProcessed: true,    // ← persisted field (not transient)
                    html: '<img src="blob:https://example.com/abcd">',
                    sentences: ['s0', 's1'],
                    loaded: true
                }
            ]
        };
        await storage.saveBook(book);
        const reloaded = await storage.getBook('b-blob');
        expect(reloaded.chapters[0].kgProcessed).toBe(true);
        // Transient fields must be absent — they would otherwise carry
        // dead blob URLs into the next session.
        expect(reloaded.chapters[0].html).toBeUndefined();
        expect(reloaded.chapters[0].sentences).toBeUndefined();
        expect(reloaded.chapters[0].loaded).toBeUndefined();
        // The in-memory book object the caller passed is NOT mutated by
        // the strip — only the persisted copy is.
        expect(book.chapters[0].html).toBeDefined();
        expect(book.chapters[0].sentences).toBeDefined();
    });
});
