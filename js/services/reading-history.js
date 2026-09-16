/**
 * Reading History Service
 *
 * Owns the "Continue reading" list: the most-recently-read books, newest first.
 *
 * Storage lives in localStorage. It used to live in the `readingPartnerState`
 * cookie, but a cookie caps out around 4KB and an entry costs ~300 bytes of
 * JSON that `encodeURIComponent` roughly doubles — so a full list would push
 * past the limit, at which point `document.cookie` fails *silently* and history
 * stops saving altogether. `loadHistory()` migrates any surviving cookie once
 * and then expires it.
 *
 * The API is deliberately synchronous so the start-screen render path does not
 * have to become async. Every storage access is guarded: localStorage throws in
 * some private-browsing modes, and losing the history list must never take the
 * app down with it.
 */

const STORAGE_KEY = 'readingPartner.history';
const LEGACY_COOKIE_NAME = 'readingPartnerState';

export const DEFAULT_HISTORY_SIZE = 7;

/**
 * Read the legacy cookie, if it is still around.
 * @returns {Object[]|null} Parsed entries, or null when there is nothing to migrate.
 */
function readLegacyCookie() {
    try {
        const cookies = document.cookie.split(';');
        for (const cookie of cookies) {
            const separator = cookie.indexOf('=');
            if (separator === -1) continue;
            const name = cookie.slice(0, separator).trim();
            const value = cookie.slice(separator + 1).trim();
            if (name !== LEGACY_COOKIE_NAME || !value) continue;

            const parsed = JSON.parse(decodeURIComponent(value));
            // Migrate the even older single-object format to an array.
            if (parsed && !Array.isArray(parsed)) return [parsed];
            return Array.isArray(parsed) ? parsed : [];
        }
    } catch (error) {
        console.error('Failed to read legacy reading history cookie:', error);
    }
    return null;
}

/**
 * Expire the legacy cookie so it cannot shadow localStorage later.
 */
function clearLegacyCookie() {
    try {
        document.cookie = `${LEGACY_COOKIE_NAME}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;SameSite=Lax`;
    } catch (error) {
        console.error('Failed to clear legacy reading history cookie:', error);
    }
}

/**
 * Load the reading history, most recent first.
 * Migrates from the legacy cookie on first call.
 * @returns {Object[]} Saved book states, or an empty array.
 */
export function loadHistory() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw !== null) {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        }
    } catch (error) {
        console.error('Failed to load reading history:', error);
        return [];
    }

    // Nothing in localStorage yet — take over from the cookie if one exists.
    const legacy = readLegacyCookie();
    if (legacy === null) return [];

    saveHistory(legacy);
    clearLegacyCookie();
    return legacy;
}

/**
 * Persist the reading history.
 * @param {Object[]} entries
 */
export function saveHistory(entries) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(entries || []));
    } catch (error) {
        console.error('Failed to save reading history:', error);
    }
}

/**
 * Record a visit to a book, moving it to the front of the list.
 * @param {Object} entry - Saved book state; must carry a bookId.
 * @param {number} [maxSize=DEFAULT_HISTORY_SIZE] - How many entries to keep.
 * @returns {Object[]} The updated history.
 */
export function recordVisit(entry, maxSize = DEFAULT_HISTORY_SIZE) {
    if (!entry?.bookId) return loadHistory();

    const limit = maxSize > 0 ? maxSize : DEFAULT_HISTORY_SIZE;
    let history = loadHistory().filter((h) => h.bookId !== entry.bookId);
    history.unshift(entry);
    history = history.slice(0, limit);

    saveHistory(history);
    return history;
}

/**
 * Drop a single book from the history. Non-destructive: the book itself and its
 * position, bookmarks and highlights are untouched.
 * @param {string} bookId
 * @returns {Object[]} The updated history.
 */
export function removeEntry(bookId) {
    const history = loadHistory().filter((h) => h.bookId !== bookId);
    saveHistory(history);
    return history;
}

/**
 * Trim the history down to the current size setting.
 * @param {number} [maxSize=DEFAULT_HISTORY_SIZE]
 * @returns {Object[]} The updated history.
 */
export function trimHistory(maxSize = DEFAULT_HISTORY_SIZE) {
    const limit = maxSize > 0 ? maxSize : DEFAULT_HISTORY_SIZE;
    const history = loadHistory();
    if (history.length <= limit) return history;

    const trimmed = history.slice(0, limit);
    saveHistory(trimmed);
    return trimmed;
}
