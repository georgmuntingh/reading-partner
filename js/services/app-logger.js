/**
 * App Logger Service
 * Persists structured log entries to IndexedDB so that the log leading up to
 * a crash can be inspected on the next session.
 *
 * Each entry contains: timestamp, level, message, and optional memory usage.
 * The log is capped at MAX_ENTRIES (latest entries kept).
 */

const DB_NAME = 'reading-partner-logs';
const DB_VERSION = 1;
const STORE_NAME = 'logs';
const MAX_ENTRIES = 500;

class AppLogger {
    constructor() {
        this._db = null;
        this._queue = [];       // buffer entries while DB opens
        this._ready = false;
    }

    /**
     * Open (or create) the log database.
     * Call once at startup; entries queued before this resolves are flushed.
     */
    async init() {
        try {
            await this._openDatabase();
            this._ready = true;
            // flush anything queued before init completed
            for (const entry of this._queue) {
                await this._writeEntry(entry);
            }
            this._queue = [];
        } catch (err) {
            console.warn('[AppLogger] init failed:', err);
        }
    }

    _openDatabase() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onerror = () => reject(request.error);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
                    store.createIndex('timestamp', 'timestamp', { unique: false });
                }
            };

            request.onsuccess = () => {
                this._db = request.result;
                resolve();
            };
        });
    }

    /**
     * Gather memory information if available.
     * Uses `performance.memory` (Chrome) when present.
     */
    _getMemoryInfo() {
        // performance.memory is a Chrome-only non-standard API
        if (typeof performance !== 'undefined' && performance.memory) {
            const m = performance.memory;
            return {
                usedJSHeapSize: m.usedJSHeapSize,
                totalJSHeapSize: m.totalJSHeapSize,
                jsHeapSizeLimit: m.jsHeapSizeLimit,
                usedMB: Math.round(m.usedJSHeapSize / 1048576),
                totalMB: Math.round(m.totalJSHeapSize / 1048576),
                limitMB: Math.round(m.jsHeapSizeLimit / 1048576)
            };
        }
        return null;
    }

    /**
     * Write a single entry to the log store.
     */
    async _writeEntry(entry) {
        if (!this._db) return;
        try {
            const tx = this._db.transaction([STORE_NAME], 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            store.add(entry);
            await new Promise((resolve, reject) => {
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
        } catch (err) {
            // Silently drop — we must not block the app
        }
    }

    /**
     * Core log method.
     * @param {'info'|'warn'|'error'} level
     * @param {string} message
     * @param {*} [detail] — optional extra data (will be JSON-stringified)
     */
    log(level, message, detail) {
        const entry = {
            timestamp: Date.now(),
            level,
            message,
            memory: this._getMemoryInfo(),
            detail: detail !== undefined ? _safeStringify(detail) : undefined
        };

        if (this._ready) {
            this._writeEntry(entry);
        } else {
            this._queue.push(entry);
        }
    }

    info(message, detail) { this.log('info', message, detail); }
    warn(message, detail) { this.log('warn', message, detail); }
    error(message, detail) { this.log('error', message, detail); }

    /**
     * Retrieve all log entries, newest first.
     * @returns {Promise<Object[]>}
     */
    async getEntries() {
        if (!this._db) return [];
        return new Promise((resolve, reject) => {
            const tx = this._db.transaction([STORE_NAME], 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const request = store.getAll();
            request.onsuccess = () => {
                const entries = request.result || [];
                entries.sort((a, b) => b.timestamp - a.timestamp);
                resolve(entries);
            };
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Remove all log entries.
     */
    async clear() {
        if (!this._db) return;
        return new Promise((resolve, reject) => {
            const tx = this._db.transaction([STORE_NAME], 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            store.clear();
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    }

    /**
     * Trim log to MAX_ENTRIES (keep newest).
     */
    async trim() {
        if (!this._db) return;
        try {
            const entries = await this.getEntries();
            if (entries.length <= MAX_ENTRIES) return;
            const toDelete = entries.slice(MAX_ENTRIES); // oldest
            const tx = this._db.transaction([STORE_NAME], 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            for (const e of toDelete) {
                store.delete(e.id);
            }
            await new Promise((resolve, reject) => {
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
        } catch (err) {
            // Non-critical
        }
    }
}

function _safeStringify(value) {
    try {
        if (typeof value === 'string') return value;
        return JSON.stringify(value, null, 0);
    } catch {
        return String(value);
    }
}

export const appLogger = new AppLogger();
