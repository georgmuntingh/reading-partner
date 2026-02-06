/**
 * FormatParser - Abstract interface for file format parsers
 * All format-specific parsers must implement this interface.
 */

/**
 * @typedef {Object} Chapter
 * @property {string} id
 * @property {string} title
 * @property {string} href
 * @property {string[]|null} sentences - null until loaded
 * @property {string|null} html - processed HTML with sentence spans, null until loaded
 * @property {boolean} loaded
 */

/**
 * @typedef {Object} BookState
 * @property {string} id
 * @property {string} title
 * @property {string} author
 * @property {Blob|null} coverImage
 * @property {Chapter[]} chapters
 * @property {ArrayBuffer|string} fileData - Raw file data for persistence
 * @property {string} fileType - File format: 'epub', 'markdown', 'html'
 * @property {number} lastOpened
 */

export class FormatParser {
    /**
     * Load a file (metadata + chapter stubs, content lazy-loaded)
     * @param {File} file
     * @returns {Promise<BookState>}
     */
    async loadFromFile(file) {
        throw new Error('loadFromFile() must be implemented by subclass');
    }

    /**
     * Initialize parser from stored data (for resuming sessions)
     * @param {ArrayBuffer|string} fileData
     * @returns {Promise<void>}
     */
    async initFromStoredData(fileData) {
        throw new Error('initFromStoredData() must be implemented by subclass');
    }

    /**
     * Load chapter content on demand (lazy loading)
     * @param {BookState} book
     * @param {number} chapterIndex
     * @returns {Promise<string[]>} sentences
     */
    async loadChapter(book, chapterIndex) {
        throw new Error('loadChapter() must be implemented by subclass');
    }

    /**
     * Get already-loaded chapter HTML
     * @param {BookState} book
     * @param {number} chapterIndex
     * @returns {string|null}
     */
    getChapterHtml(book, chapterIndex) {
        if (chapterIndex < 0 || chapterIndex >= book.chapters.length) {
            return null;
        }
        return book.chapters[chapterIndex].html || null;
    }

    /**
     * Get already-loaded chapter sentences
     * @param {BookState} book
     * @param {number} chapterIndex
     * @returns {string[]}
     */
    getChapterSentences(book, chapterIndex) {
        if (chapterIndex < 0 || chapterIndex >= book.chapters.length) {
            return [];
        }
        return book.chapters[chapterIndex].sentences || [];
    }

    /**
     * Destroy parser and free resources
     */
    destroy() {
        // Default no-op; subclasses can override
    }
}
