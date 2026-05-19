/**
 * Storage Service
 * Handles IndexedDB persistence for books, positions, bookmarks, and settings
 */

const DB_NAME = 'reading-partner-db';
const DB_VERSION = 5;

// Store names
const STORES = {
    BOOKS: 'books',
    POSITIONS: 'positions',
    BOOKMARKS: 'bookmarks',
    SETTINGS: 'settings',
    HIGHLIGHTS: 'highlights',
    LOOKUPS: 'lookups',
    KG_NODES: 'kg_nodes',
    KG_EDGES: 'kg_edges',
    KG_FLASHCARDS: 'kg_flashcards'
};

/**
 * Strip per-chapter runtime caches that must not survive a page reload.
 * Specifically `chapter.html` may carry `blob:` URLs created by
 * `URL.createObjectURL`; those URLs are scoped to the current session and
 * resolve to ERR_FILE_NOT_FOUND on the next load. `sentences` and `loaded`
 * are deterministically derivable from `html` and re-extracted on demand.
 *
 * Returns a shallow clone so callers can keep mutating the in-memory book
 * without affecting the persisted copy.
 */
function stripTransientChapterState(book) {
    if (!book || !Array.isArray(book.chapters)) return book;
    return {
        ...book,
        chapters: book.chapters.map((ch) => {
            if (!ch || typeof ch !== 'object') return ch;
            const { html: _h, sentences: _s, loaded: _l, ...rest } = ch;
            return rest;
        })
    };
}

export class StorageService {
    constructor() {
        this._db = null;
    }

    /**
     * Initialize the database
     * @returns {Promise<void>}
     */
    async init() {
        try {
            await this._openDatabase();
        } catch (error) {
            console.warn('Database init failed, deleting and retrying:', error.message);
            // If upgrade fails (e.g. blocked by old connection), delete and recreate
            await this._deleteDatabase();
            await this._openDatabase();
        }
    }

    /**
     * Delete the database
     * @returns {Promise<void>}
     */
    _deleteDatabase() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.deleteDatabase(DB_NAME);
            request.onsuccess = () => {
                console.log('Database deleted for fresh creation');
                resolve();
            };
            request.onerror = () => reject(new Error('Failed to delete database'));
            request.onblocked = () => {
                console.warn('Database delete blocked, resolving anyway');
                resolve();
            };
        });
    }

    /**
     * Open the IndexedDB database
     * @returns {Promise<void>}
     */
    _openDatabase() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            let blocked = false;

            request.onerror = () => {
                console.error('Database open error:', request.error);
                reject(new Error('Failed to open database: ' + (request.error?.message || 'unknown error')));
            };

            request.onblocked = () => {
                blocked = true;
                console.warn('Database upgrade blocked by another connection');
                reject(new Error('Database upgrade blocked'));
            };

            request.onsuccess = () => {
                if (blocked) return;
                this._db = request.result;

                // Handle version change from other tabs
                this._db.onversionchange = () => {
                    this._db.close();
                    this._db = null;
                    console.log('Database version changed in another tab, connection closed');
                };

                console.log('Storage service initialized');
                resolve();
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // Books store
                if (!db.objectStoreNames.contains(STORES.BOOKS)) {
                    const bookStore = db.createObjectStore(STORES.BOOKS, { keyPath: 'id' });
                    bookStore.createIndex('lastOpened', 'lastOpened', { unique: false });
                }

                // Positions store
                if (!db.objectStoreNames.contains(STORES.POSITIONS)) {
                    db.createObjectStore(STORES.POSITIONS, { keyPath: 'bookId' });
                }

                // Bookmarks store
                if (!db.objectStoreNames.contains(STORES.BOOKMARKS)) {
                    const bookmarkStore = db.createObjectStore(STORES.BOOKMARKS, { keyPath: 'id' });
                    bookmarkStore.createIndex('bookId', 'bookId', { unique: false });
                }

                // Settings store
                if (!db.objectStoreNames.contains(STORES.SETTINGS)) {
                    db.createObjectStore(STORES.SETTINGS, { keyPath: 'key' });
                }

                // Highlights store
                if (!db.objectStoreNames.contains(STORES.HIGHLIGHTS)) {
                    const highlightStore = db.createObjectStore(STORES.HIGHLIGHTS, { keyPath: 'id' });
                    highlightStore.createIndex('bookId', 'bookId', { unique: false });
                }

                // Lookups store (word/phrase dictionary lookups)
                if (!db.objectStoreNames.contains(STORES.LOOKUPS)) {
                    const lookupStore = db.createObjectStore(STORES.LOOKUPS, { keyPath: 'id' });
                    lookupStore.createIndex('bookId', 'bookId', { unique: false });
                    lookupStore.createIndex('timestamp', 'timestamp', { unique: false });
                }

                // Knowledge Graph nodes (extracted entities with embeddings + SRS state)
                if (!db.objectStoreNames.contains(STORES.KG_NODES)) {
                    const kgNodeStore = db.createObjectStore(STORES.KG_NODES, { keyPath: 'id' });
                    kgNodeStore.createIndex('bookId', 'bookId', { unique: false });
                    kgNodeStore.createIndex('bookChapter', ['bookId', 'firstSeenChapter'], { unique: false });
                }

                // Knowledge Graph edges (relations between resolved nodes)
                if (!db.objectStoreNames.contains(STORES.KG_EDGES)) {
                    const kgEdgeStore = db.createObjectStore(STORES.KG_EDGES, { keyPath: 'id' });
                    kgEdgeStore.createIndex('bookId', 'bookId', { unique: false });
                    kgEdgeStore.createIndex('source', 'sourceId', { unique: false });
                    kgEdgeStore.createIndex('target', 'targetId', { unique: false });
                }

                // Knowledge Graph flashcards (decoupled SRS state; v5+).
                // Cards reference nodes/edges by id and own all SRS state
                // (srsBox, SM-2 fields, nextReviewAt) so kg_nodes / kg_edges
                // stay immutable from the scheduler's perspective.
                if (!db.objectStoreNames.contains(STORES.KG_FLASHCARDS)) {
                    const fcStore = db.createObjectStore(STORES.KG_FLASHCARDS, { keyPath: 'id' });
                    fcStore.createIndex('bookId', 'bookId', { unique: false });
                    fcStore.createIndex('nextReviewAt', 'nextReviewAt', { unique: false });
                    fcStore.createIndex('bookDue', ['bookId', 'nextReviewAt'], { unique: false });
                    fcStore.createIndex('cognitiveLevel', 'cognitiveLevel', { unique: false });
                }

                console.log('Database schema created/upgraded to version', DB_VERSION);
            };
        });
    }

    // ========== Books ==========

    /**
     * Save a book
     * @param {Object} book
     * @returns {Promise<void>}
     */
    async saveBook(book) {
        const transaction = this._db.transaction([STORES.BOOKS], 'readwrite');
        const store = transaction.objectStore(STORES.BOOKS);

        book.lastOpened = Date.now();

        // Strip per-chapter runtime caches before persisting. `chapter.html`
        // contains `blob:` URLs created by `URL.createObjectURL` in the
        // current session; those URLs are gone on the next page load and
        // would render as ERR_FILE_NOT_FOUND if reused. `sentences` and the
        // `loaded` flag are derived from `html` and can be re-extracted
        // lazily, so they're stripped too.
        const persistable = stripTransientChapterState(book);

        return new Promise((resolve, reject) => {
            const request = store.put(persistable);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Get a book by ID
     * @param {string} id
     * @returns {Promise<Object|null>}
     */
    async getBook(id) {
        const transaction = this._db.transaction([STORES.BOOKS], 'readonly');
        const store = transaction.objectStore(STORES.BOOKS);

        return new Promise((resolve, reject) => {
            const request = store.get(id);
            request.onsuccess = () => resolve(
                // Even if a stale persisted record still carries a cached
                // `chapter.html` from before this fix (with dead blob URLs),
                // strip it on read so we never paint with stale blobs.
                request.result ? stripTransientChapterState(request.result) : null
            );
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Get all books (sorted by last opened)
     * @returns {Promise<Object[]>}
     */
    async getAllBooks() {
        const transaction = this._db.transaction([STORES.BOOKS], 'readonly');
        const store = transaction.objectStore(STORES.BOOKS);
        const index = store.index('lastOpened');

        return new Promise((resolve, reject) => {
            const request = index.openCursor(null, 'prev');
            const books = [];

            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    books.push(cursor.value);
                    cursor.continue();
                } else {
                    resolve(books);
                }
            };

            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Delete a book
     * @param {string} id
     * @returns {Promise<void>}
     */
    async deleteBook(id) {
        const transaction = this._db.transaction([STORES.BOOKS], 'readwrite');
        const store = transaction.objectStore(STORES.BOOKS);

        return new Promise((resolve, reject) => {
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    // ========== Positions ==========

    /**
     * Save reading position
     * @param {Object} position - { bookId, chapterIndex, sentenceIndex, updatedAt }
     * @returns {Promise<void>}
     */
    async savePosition(position) {
        const transaction = this._db.transaction([STORES.POSITIONS], 'readwrite');
        const store = transaction.objectStore(STORES.POSITIONS);

        position.updatedAt = Date.now();

        return new Promise((resolve, reject) => {
            const request = store.put(position);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Get reading position for a book
     * @param {string} bookId
     * @returns {Promise<Object|null>}
     */
    async getPosition(bookId) {
        const transaction = this._db.transaction([STORES.POSITIONS], 'readonly');
        const store = transaction.objectStore(STORES.POSITIONS);

        return new Promise((resolve, reject) => {
            const request = store.get(bookId);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Delete reading position
     * @param {string} bookId
     * @returns {Promise<void>}
     */
    async deletePosition(bookId) {
        const transaction = this._db.transaction([STORES.POSITIONS], 'readwrite');
        const store = transaction.objectStore(STORES.POSITIONS);

        return new Promise((resolve, reject) => {
            const request = store.delete(bookId);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    // ========== Bookmarks ==========

    /**
     * Add a bookmark
     * @param {Object} bookmark - { id, bookId, chapterIndex, sentenceIndex, note, createdAt }
     * @returns {Promise<void>}
     */
    async addBookmark(bookmark) {
        const transaction = this._db.transaction([STORES.BOOKMARKS], 'readwrite');
        const store = transaction.objectStore(STORES.BOOKMARKS);

        bookmark.createdAt = bookmark.createdAt || Date.now();

        return new Promise((resolve, reject) => {
            const request = store.put(bookmark);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Get all bookmarks for a book
     * @param {string} bookId
     * @returns {Promise<Object[]>}
     */
    async getBookmarks(bookId) {
        const transaction = this._db.transaction([STORES.BOOKMARKS], 'readonly');
        const store = transaction.objectStore(STORES.BOOKMARKS);
        const index = store.index('bookId');

        return new Promise((resolve, reject) => {
            const request = index.getAll(bookId);
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Delete a bookmark
     * @param {string} id
     * @returns {Promise<void>}
     */
    async deleteBookmark(id) {
        const transaction = this._db.transaction([STORES.BOOKMARKS], 'readwrite');
        const store = transaction.objectStore(STORES.BOOKMARKS);

        return new Promise((resolve, reject) => {
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    // ========== Highlights ==========

    /**
     * Add a highlight
     * @param {Object} highlight - { id, bookId, chapterIndex, startSentenceIndex, endSentenceIndex, text, note, color, createdAt }
     * @returns {Promise<void>}
     */
    async addHighlight(highlight) {
        const transaction = this._db.transaction([STORES.HIGHLIGHTS], 'readwrite');
        const store = transaction.objectStore(STORES.HIGHLIGHTS);

        highlight.createdAt = highlight.createdAt || Date.now();

        return new Promise((resolve, reject) => {
            const request = store.put(highlight);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Get all highlights for a book
     * @param {string} bookId
     * @returns {Promise<Object[]>}
     */
    async getHighlights(bookId) {
        const transaction = this._db.transaction([STORES.HIGHLIGHTS], 'readonly');
        const store = transaction.objectStore(STORES.HIGHLIGHTS);
        const index = store.index('bookId');

        return new Promise((resolve, reject) => {
            const request = index.getAll(bookId);
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Delete a highlight
     * @param {string} id
     * @returns {Promise<void>}
     */
    async deleteHighlight(id) {
        const transaction = this._db.transaction([STORES.HIGHLIGHTS], 'readwrite');
        const store = transaction.objectStore(STORES.HIGHLIGHTS);

        return new Promise((resolve, reject) => {
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    // ========== Lookups ==========

    /**
     * Save a lookup entry
     * @param {Object} lookup - { id, bookId, chapterIndex, sentenceIndex, phrase, context, result, timestamp }
     * @returns {Promise<void>}
     */
    async saveLookup(lookup) {
        const transaction = this._db.transaction([STORES.LOOKUPS], 'readwrite');
        const store = transaction.objectStore(STORES.LOOKUPS);

        lookup.timestamp = lookup.timestamp || Date.now();

        return new Promise((resolve, reject) => {
            const request = store.put(lookup);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Get all lookups for a book (sorted by timestamp descending)
     * @param {string} bookId
     * @returns {Promise<Object[]>}
     */
    async getLookups(bookId) {
        const transaction = this._db.transaction([STORES.LOOKUPS], 'readonly');
        const store = transaction.objectStore(STORES.LOOKUPS);
        const index = store.index('bookId');

        return new Promise((resolve, reject) => {
            const request = index.getAll(bookId);
            request.onsuccess = () => {
                const results = request.result || [];
                results.sort((a, b) => b.timestamp - a.timestamp);
                resolve(results);
            };
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Get all lookups across all books (sorted by timestamp descending)
     * @returns {Promise<Object[]>}
     */
    async getAllLookups() {
        const transaction = this._db.transaction([STORES.LOOKUPS], 'readonly');
        const store = transaction.objectStore(STORES.LOOKUPS);

        return new Promise((resolve, reject) => {
            const request = store.getAll();
            request.onsuccess = () => {
                const results = request.result || [];
                results.sort((a, b) => b.timestamp - a.timestamp);
                resolve(results);
            };
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Delete a lookup
     * @param {string} id
     * @returns {Promise<void>}
     */
    async deleteLookup(id) {
        const transaction = this._db.transaction([STORES.LOOKUPS], 'readwrite');
        const store = transaction.objectStore(STORES.LOOKUPS);

        return new Promise((resolve, reject) => {
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    // ========== Quiz Questions ==========
    // Uses the settings store with key patterns to avoid schema changes

    /**
     * Save a quiz question for a chapter
     * @param {string} bookId
     * @param {number} chapterIndex
     * @param {Object} question - Quiz question data
     * @returns {Promise<void>}
     */
    async saveQuizQuestion(bookId, chapterIndex, question) {
        const key = `quiz_${bookId}_ch${chapterIndex}`;
        const existing = await this.getSetting(key) || [];
        existing.push(question);
        await this.saveSetting(key, existing);
    }

    /**
     * Get all quiz questions for a chapter
     * @param {string} bookId
     * @param {number} chapterIndex
     * @returns {Promise<Object[]>}
     */
    async getQuizQuestions(bookId, chapterIndex) {
        const key = `quiz_${bookId}_ch${chapterIndex}`;
        return await this.getSetting(key) || [];
    }

    /**
     * Get all quiz questions for a book across all chapters
     * @param {string} bookId
     * @param {number} chapterCount
     * @returns {Promise<Object[]>} Array of { chapterIndex, questions[] }
     */
    async getAllQuizQuestionsForBook(bookId, chapterCount) {
        const result = [];
        for (let i = 0; i < chapterCount; i++) {
            const questions = await this.getQuizQuestions(bookId, i);
            if (questions.length > 0) {
                result.push({ chapterIndex: i, questions });
            }
        }
        return result;
    }

    /**
     * Clear quiz questions for a chapter
     * @param {string} bookId
     * @param {number} chapterIndex
     * @returns {Promise<void>}
     */
    async clearQuizQuestions(bookId, chapterIndex) {
        const key = `quiz_${bookId}_ch${chapterIndex}`;
        await this.deleteSetting(key);
    }

    // ========== Settings ==========

    /**
     * Save a setting
     * @param {string} key
     * @param {*} value
     * @returns {Promise<void>}
     */
    async saveSetting(key, value) {
        const transaction = this._db.transaction([STORES.SETTINGS], 'readwrite');
        const store = transaction.objectStore(STORES.SETTINGS);

        return new Promise((resolve, reject) => {
            const request = store.put({ key, value });
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Get a setting
     * @param {string} key
     * @returns {Promise<*>}
     */
    async getSetting(key) {
        const transaction = this._db.transaction([STORES.SETTINGS], 'readonly');
        const store = transaction.objectStore(STORES.SETTINGS);

        return new Promise((resolve, reject) => {
            const request = store.get(key);
            request.onsuccess = () => {
                const result = request.result;
                resolve(result ? result.value : null);
            };
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Get all settings
     * @returns {Promise<Object>}
     */
    async getAllSettings() {
        const transaction = this._db.transaction([STORES.SETTINGS], 'readonly');
        const store = transaction.objectStore(STORES.SETTINGS);

        return new Promise((resolve, reject) => {
            const request = store.getAll();
            request.onsuccess = () => {
                const settings = {};
                request.result.forEach(item => {
                    settings[item.key] = item.value;
                });
                resolve(settings);
            };
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Delete a setting
     * @param {string} key
     * @returns {Promise<void>}
     */
    async deleteSetting(key) {
        const transaction = this._db.transaction([STORES.SETTINGS], 'readwrite');
        const store = transaction.objectStore(STORES.SETTINGS);

        return new Promise((resolve, reject) => {
            const request = store.delete(key);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    // ========== Knowledge Graph ==========

    /**
     * Save a knowledge graph node
     * @param {Object} node
     * @returns {Promise<void>}
     */
    async saveKGNode(node) {
        const transaction = this._db.transaction([STORES.KG_NODES], 'readwrite');
        const store = transaction.objectStore(STORES.KG_NODES);

        return new Promise((resolve, reject) => {
            const request = store.put(node);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Get a single knowledge graph node by id
     * @param {string} id
     * @returns {Promise<Object|null>}
     */
    async getKGNode(id) {
        const transaction = this._db.transaction([STORES.KG_NODES], 'readonly');
        const store = transaction.objectStore(STORES.KG_NODES);

        return new Promise((resolve, reject) => {
            const request = store.get(id);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Get all knowledge graph nodes for a book
     * @param {string} bookId
     * @returns {Promise<Object[]>}
     */
    async getKGNodesForBook(bookId) {
        const transaction = this._db.transaction([STORES.KG_NODES], 'readonly');
        const store = transaction.objectStore(STORES.KG_NODES);
        const index = store.index('bookId');

        return new Promise((resolve, reject) => {
            const request = index.getAll(bookId);
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Delete all knowledge graph nodes for a book
     * @param {string} bookId
     * @returns {Promise<void>}
     */
    async deleteKGNodesForBook(bookId) {
        const transaction = this._db.transaction([STORES.KG_NODES], 'readwrite');
        const store = transaction.objectStore(STORES.KG_NODES);
        const index = store.index('bookId');

        return new Promise((resolve, reject) => {
            const request = index.openCursor(IDBKeyRange.only(bookId));
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    cursor.delete();
                    cursor.continue();
                } else {
                    resolve();
                }
            };
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Save a knowledge graph edge
     * @param {Object} edge
     * @returns {Promise<void>}
     */
    async saveKGEdge(edge) {
        const transaction = this._db.transaction([STORES.KG_EDGES], 'readwrite');
        const store = transaction.objectStore(STORES.KG_EDGES);

        return new Promise((resolve, reject) => {
            const request = store.put(edge);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Get all knowledge graph edges for a book
     * @param {string} bookId
     * @returns {Promise<Object[]>}
     */
    async getKGEdgesForBook(bookId) {
        const transaction = this._db.transaction([STORES.KG_EDGES], 'readonly');
        const store = transaction.objectStore(STORES.KG_EDGES);
        const index = store.index('bookId');

        return new Promise((resolve, reject) => {
            const request = index.getAll(bookId);
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Delete all knowledge graph edges for a book
     * @param {string} bookId
     * @returns {Promise<void>}
     */
    async deleteKGEdgesForBook(bookId) {
        const transaction = this._db.transaction([STORES.KG_EDGES], 'readwrite');
        const store = transaction.objectStore(STORES.KG_EDGES);
        const index = store.index('bookId');

        return new Promise((resolve, reject) => {
            const request = index.openCursor(IDBKeyRange.only(bookId));
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    cursor.delete();
                    cursor.continue();
                } else {
                    resolve();
                }
            };
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Clear all knowledge graph data (nodes + edges) for a book
     * @param {string} bookId
     * @returns {Promise<void>}
     */
    async clearKGForBook(bookId) {
        await this.deleteKGNodesForBook(bookId);
        await this.deleteKGEdgesForBook(bookId);
    }

    /**
     * Delete a single knowledge graph node by id.
     * @param {string} id
     */
    async deleteKGNode(id) {
        const transaction = this._db.transaction([STORES.KG_NODES], 'readwrite');
        const store = transaction.objectStore(STORES.KG_NODES);
        return new Promise((resolve, reject) => {
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Delete a single knowledge graph edge by id.
     * @param {string} id
     */
    async deleteKGEdge(id) {
        const transaction = this._db.transaction([STORES.KG_EDGES], 'readwrite');
        const store = transaction.objectStore(STORES.KG_EDGES);
        return new Promise((resolve, reject) => {
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Atomic multi-store delete used by graph-explorer's bulk Delete action.
     * One transaction over kg_nodes + kg_edges so a partial failure cannot
     * leave the graph with edges referencing deleted nodes.
     *
     * @param {Object} payload
     * @param {string[]} payload.deletedNodeIds
     * @param {string[]} payload.deletedEdgeIds
     */
    async applyDeleteTransaction({ deletedNodeIds = [], deletedEdgeIds = [] } = {}) {
        const transaction = this._db.transaction(
            [STORES.KG_NODES, STORES.KG_EDGES], 'readwrite');
        const nodes = transaction.objectStore(STORES.KG_NODES);
        const edges = transaction.objectStore(STORES.KG_EDGES);
        return new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error || new Error('transaction aborted'));
            for (const id of deletedEdgeIds) edges.delete(id);
            for (const id of deletedNodeIds) nodes.delete(id);
        });
    }

    /**
     * Atomic merge: write the surviving Primary node, write the rewritten
     * edges, delete the absorbed/self-loop edges, and delete the Secondary
     * nodes — all inside one transaction spanning kg_nodes + kg_edges.
     *
     * FUTURE: when a kg_flashcards store is added (decoupled SRS), it must
     * be added to this transaction's store list and the rewrite of each
     * flashcard's `targetNodeIds` (Secondary id → Primary id, plus dedup of
     * the resulting array) must be queued here so flashcard updates land
     * atomically with node/edge updates.
     *
     * @param {Object} payload
     * @param {Object} payload.updatedNode
     * @param {string[]} payload.deletedNodeIds
     * @param {Object[]} payload.savedEdges
     * @param {string[]} payload.deletedEdgeIds
     */
    async applyMergeTransaction({
        updatedNode,
        deletedNodeIds = [],
        savedEdges = [],
        deletedEdgeIds = []
    } = {}) {
        if (!updatedNode || !updatedNode.id) {
            throw new Error('applyMergeTransaction: updatedNode is required');
        }
        const transaction = this._db.transaction(
            [STORES.KG_NODES, STORES.KG_EDGES], 'readwrite');
        const nodes = transaction.objectStore(STORES.KG_NODES);
        const edges = transaction.objectStore(STORES.KG_EDGES);
        return new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error || new Error('transaction aborted'));
            nodes.put(updatedNode);
            for (const e of savedEdges) edges.put(e);
            for (const id of deletedEdgeIds) edges.delete(id);
            for (const id of deletedNodeIds) nodes.delete(id);
        });
    }

    // ========== KG Flashcards (decoupled SRS) ==========

    /**
     * Save a single flashcard.
     * @param {Object} card
     * @returns {Promise<void>}
     */
    async saveFlashcard(card) {
        const transaction = this._db.transaction([STORES.KG_FLASHCARDS], 'readwrite');
        const store = transaction.objectStore(STORES.KG_FLASHCARDS);
        return new Promise((resolve, reject) => {
            const request = store.put(card);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Bulk-insert/update flashcards inside a single transaction.
     * Used by the grounded generator to land a batch atomically.
     * @param {Object[]} cards
     * @returns {Promise<void>}
     */
    async bulkPutFlashcards(cards) {
        if (!Array.isArray(cards) || cards.length === 0) return;
        const transaction = this._db.transaction([STORES.KG_FLASHCARDS], 'readwrite');
        const store = transaction.objectStore(STORES.KG_FLASHCARDS);
        return new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error || new Error('transaction aborted'));
            for (const c of cards) store.put(c);
        });
    }

    /**
     * Get a flashcard by id.
     * @param {string} id
     * @returns {Promise<Object|null>}
     */
    async getFlashcard(id) {
        const transaction = this._db.transaction([STORES.KG_FLASHCARDS], 'readonly');
        const store = transaction.objectStore(STORES.KG_FLASHCARDS);
        return new Promise((resolve, reject) => {
            const request = store.get(id);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Get all flashcards for a book.
     * @param {string} bookId
     * @returns {Promise<Object[]>}
     */
    async getFlashcardsForBook(bookId) {
        const transaction = this._db.transaction([STORES.KG_FLASHCARDS], 'readonly');
        const store = transaction.objectStore(STORES.KG_FLASHCARDS);
        const index = store.index('bookId');
        return new Promise((resolve, reject) => {
            const request = index.getAll(bookId);
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Get flashcards due for review (nextReviewAt <= nowMs) for a book.
     * Uses the composite [bookId, nextReviewAt] index for a range scan.
     * @param {string} bookId
     * @param {number} nowMs
     * @returns {Promise<Object[]>}
     */
    async getDueFlashcards(bookId, nowMs) {
        const transaction = this._db.transaction([STORES.KG_FLASHCARDS], 'readonly');
        const store = transaction.objectStore(STORES.KG_FLASHCARDS);
        const index = store.index('bookDue');
        const range = IDBKeyRange.bound([bookId, -Infinity], [bookId, nowMs]);
        return new Promise((resolve, reject) => {
            const request = index.getAll(range);
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Get flashcards whose targetNodeIds include the given nodeId.
     * No native index covers array membership, so this scans the bookId
     * index and filters in JS. Card counts per book are bounded.
     * @param {string} bookId
     * @param {string} nodeId
     * @returns {Promise<Object[]>}
     */
    async getFlashcardsByNodeId(bookId, nodeId) {
        const all = await this.getFlashcardsForBook(bookId);
        return all.filter((c) => Array.isArray(c.targetNodeIds) && c.targetNodeIds.includes(nodeId));
    }

    /**
     * Delete a flashcard by id.
     * @param {string} id
     * @returns {Promise<void>}
     */
    async deleteFlashcard(id) {
        const transaction = this._db.transaction([STORES.KG_FLASHCARDS], 'readwrite');
        const store = transaction.objectStore(STORES.KG_FLASHCARDS);
        return new Promise((resolve, reject) => {
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Delete all flashcards for a book.
     * @param {string} bookId
     * @returns {Promise<void>}
     */
    async deleteFlashcardsForBook(bookId) {
        const transaction = this._db.transaction([STORES.KG_FLASHCARDS], 'readwrite');
        const store = transaction.objectStore(STORES.KG_FLASHCARDS);
        const index = store.index('bookId');
        return new Promise((resolve, reject) => {
            const request = index.openCursor(IDBKeyRange.only(bookId));
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    cursor.delete();
                    cursor.continue();
                } else {
                    resolve();
                }
            };
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Close the database connection
     */
    close() {
        if (this._db) {
            this._db.close();
            this._db = null;
        }
    }
}

// Export singleton instance
export const storage = new StorageService();
