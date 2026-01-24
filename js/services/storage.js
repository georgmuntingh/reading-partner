/**
 * Storage Service
 * Handles IndexedDB persistence for books, positions, bookmarks, and settings
 */

const DB_NAME = 'reading-partner-db';
const DB_VERSION = 1;

// Store names
const STORES = {
    BOOKS: 'books',
    POSITIONS: 'positions',
    BOOKMARKS: 'bookmarks',
    SETTINGS: 'settings'
};

export class StorageService {
    constructor() {
        this._db = null;
    }

    /**
     * Initialize the database
     * @returns {Promise<void>}
     */
    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onerror = () => {
                reject(new Error('Failed to open database'));
            };

            request.onsuccess = () => {
                this._db = request.result;
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

                console.log('Database schema created');
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

        return new Promise((resolve, reject) => {
            const request = store.put(book);
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
            request.onsuccess = () => resolve(request.result || null);
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
