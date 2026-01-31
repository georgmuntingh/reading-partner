/**
 * Reading State Controller
 * Central state management for reading position, bookmarks, and auto-save
 */

import { storage } from '../services/storage.js';
import { epubParser } from '../services/epub-parser.js';

export class ReadingStateController {
    /**
     * @param {Object} options
     * @param {(chapterIndex: number, sentenceIndex: number) => void} options.onPositionChange
     * @param {() => void} options.onBookmarksChange
     * @param {() => void} options.onHighlightsChange
     */
    constructor({ onPositionChange, onBookmarksChange, onHighlightsChange } = {}) {
        this._currentBook = null;
        this._position = {
            chapterIndex: 0,
            sentenceIndex: 0
        };
        this._bookmarks = [];
        this._highlights = [];
        this._saveTimeout = null;
        this._onPositionChange = onPositionChange;
        this._onBookmarksChange = onBookmarksChange;
        this._onHighlightsChange = onHighlightsChange;
    }

    /**
     * Initialize the state controller
     * @returns {Promise<void>}
     */
    async init() {
        await storage.init();
        console.log('Reading state controller initialized');
    }

    /**
     * Load a book from file and save to storage
     * @param {File} file
     * @param {Object} [source] - Source information for persistence
     * @param {string} source.type - 'local' or 'gutenberg'
     * @param {string} [source.filename] - Original filename (for local)
     * @param {string} [source.bookId] - Gutenberg book ID (for gutenberg)
     * @param {string} [existingBookId] - Reuse an existing book ID (for re-downloads)
     * @returns {Promise<Object>} book
     */
    async loadBook(file, source = null, existingBookId = null) {
        const book = await epubParser.loadFromFile(file);

        // Reuse existing ID (for re-downloads) or generate new one
        book.id = existingBookId || this._generateBookId(file.name);

        // Store source information for persistence
        if (source) {
            book.source = source;
        } else {
            // Default to local with filename
            book.source = {
                type: 'local',
                filename: file.name
            };
        }

        // Save to storage
        await storage.saveBook(book);

        this._currentBook = book;

        // Try to restore position
        const savedPosition = await storage.getPosition(book.id);
        if (savedPosition) {
            this._position = {
                chapterIndex: savedPosition.chapterIndex,
                sentenceIndex: savedPosition.sentenceIndex
            };
            console.log('Restored position:', this._position);
        } else {
            this._position = { chapterIndex: 0, sentenceIndex: 0 };
        }

        // Load bookmarks
        this._bookmarks = await storage.getBookmarks(book.id);

        // Load highlights
        this._highlights = await storage.getHighlights(book.id);

        return book;
    }

    /**
     * Open a book by ID from storage
     * @param {string} bookId
     * @returns {Promise<Object>} book
     */
    async openBook(bookId) {
        const book = await storage.getBook(bookId);
        if (!book) {
            throw new Error('Book not found');
        }

        // Reinitialize epub.js from stored EPUB data
        if (book.epubData) {
            await epubParser.initFromArrayBuffer(book.epubData);
        } else {
            throw new Error('EPUB data not available');
        }

        this._currentBook = book;

        // Restore position
        const savedPosition = await storage.getPosition(bookId);
        if (savedPosition) {
            this._position = {
                chapterIndex: savedPosition.chapterIndex,
                sentenceIndex: savedPosition.sentenceIndex
            };
        } else {
            this._position = { chapterIndex: 0, sentenceIndex: 0 };
        }

        // Load bookmarks
        this._bookmarks = await storage.getBookmarks(bookId);

        // Load highlights
        this._highlights = await storage.getHighlights(bookId);

        // Update last opened
        await storage.saveBook(book);

        return book;
    }

    /**
     * Get all books from storage
     * @returns {Promise<Object[]>}
     */
    async getAllBooks() {
        return await storage.getAllBooks();
    }

    /**
     * Delete a book and its associated data
     * @param {string} bookId
     * @returns {Promise<void>}
     */
    async deleteBook(bookId) {
        await storage.deleteBook(bookId);
        await storage.deletePosition(bookId);

        // Delete all bookmarks for this book
        const bookmarks = await storage.getBookmarks(bookId);
        for (const bookmark of bookmarks) {
            await storage.deleteBookmark(bookmark.id);
        }

        // Delete all highlights for this book
        const highlights = await storage.getHighlights(bookId);
        for (const highlight of highlights) {
            await storage.deleteHighlight(highlight.id);
        }
    }

    /**
     * Get current book
     * @returns {Object|null}
     */
    getCurrentBook() {
        return this._currentBook;
    }

    /**
     * Get current position
     * @returns {{ chapterIndex: number, sentenceIndex: number }}
     */
    getCurrentPosition() {
        return { ...this._position };
    }

    /**
     * Load chapter content
     * @param {number} chapterIndex
     * @returns {Promise<string[]>} sentences
     */
    async loadChapter(chapterIndex) {
        if (!this._currentBook) {
            throw new Error('No book loaded');
        }

        return await epubParser.loadChapter(this._currentBook, chapterIndex);
    }

    /**
     * Go to a specific chapter
     * @param {number} chapterIndex
     * @param {number} [sentenceIndex=0]
     */
    goToChapter(chapterIndex, sentenceIndex = 0) {
        if (!this._currentBook) return;

        this._position.chapterIndex = chapterIndex;
        this._position.sentenceIndex = sentenceIndex;

        this._schedulePositionSave();
        this._notifyPositionChange();
    }

    /**
     * Go to a specific sentence in current chapter
     * @param {number} sentenceIndex
     */
    goToSentence(sentenceIndex) {
        this._position.sentenceIndex = sentenceIndex;
        this._schedulePositionSave();
        this._notifyPositionChange();
    }

    /**
     * Update sentence position (called during playback)
     * @param {number} sentenceIndex
     */
    updateSentencePosition(sentenceIndex) {
        this._position.sentenceIndex = sentenceIndex;
        this._schedulePositionSave();
    }

    /**
     * Go to a bookmark
     * @param {Object} bookmark
     */
    goToBookmark(bookmark) {
        this._position.chapterIndex = bookmark.chapterIndex;
        this._position.sentenceIndex = bookmark.sentenceIndex;

        this._schedulePositionSave();
        this._notifyPositionChange();
    }

    /**
     * Add a bookmark at current position
     * @param {string} [note='']
     * @returns {Promise<Object>} bookmark
     */
    async addBookmark(note = '') {
        if (!this._currentBook) {
            throw new Error('No book loaded');
        }

        const bookmark = {
            id: this._generateBookmarkId(),
            bookId: this._currentBook.id,
            chapterIndex: this._position.chapterIndex,
            sentenceIndex: this._position.sentenceIndex,
            note,
            createdAt: Date.now()
        };

        await storage.addBookmark(bookmark);
        this._bookmarks.push(bookmark);
        this._bookmarks.sort((a, b) => {
            if (a.chapterIndex !== b.chapterIndex) {
                return a.chapterIndex - b.chapterIndex;
            }
            return a.sentenceIndex - b.sentenceIndex;
        });

        this._notifyBookmarksChange();
        return bookmark;
    }

    /**
     * Delete a bookmark
     * @param {string} bookmarkId
     * @returns {Promise<void>}
     */
    async deleteBookmark(bookmarkId) {
        await storage.deleteBookmark(bookmarkId);
        this._bookmarks = this._bookmarks.filter(b => b.id !== bookmarkId);
        this._notifyBookmarksChange();
    }

    /**
     * Get all bookmarks for current book
     * @returns {Object[]}
     */
    getBookmarks() {
        return [...this._bookmarks];
    }

    // ========== Highlights ==========

    /**
     * Add a highlight
     * @param {number} chapterIndex
     * @param {number} startSentenceIndex
     * @param {number} endSentenceIndex
     * @param {string} text - The highlighted text
     * @param {string} [note='']
     * @param {string} [color='yellow']
     * @returns {Promise<Object>} highlight
     */
    async addHighlight(chapterIndex, startSentenceIndex, endSentenceIndex, text, note = '', color = 'yellow') {
        if (!this._currentBook) {
            throw new Error('No book loaded');
        }

        const highlight = {
            id: this._generateHighlightId(),
            bookId: this._currentBook.id,
            chapterIndex,
            startSentenceIndex,
            endSentenceIndex,
            text,
            note,
            color,
            createdAt: Date.now()
        };

        await storage.addHighlight(highlight);
        this._highlights.push(highlight);
        this._highlights.sort((a, b) => {
            if (a.chapterIndex !== b.chapterIndex) {
                return a.chapterIndex - b.chapterIndex;
            }
            return a.startSentenceIndex - b.startSentenceIndex;
        });

        this._notifyHighlightsChange();
        return highlight;
    }

    /**
     * Delete a highlight
     * @param {string} highlightId
     * @returns {Promise<void>}
     */
    async deleteHighlight(highlightId) {
        await storage.deleteHighlight(highlightId);
        this._highlights = this._highlights.filter(h => h.id !== highlightId);
        this._notifyHighlightsChange();
    }

    /**
     * Get all highlights for current book
     * @returns {Object[]}
     */
    getHighlights() {
        return [...this._highlights];
    }

    /**
     * Get highlights for a specific chapter
     * @param {number} chapterIndex
     * @returns {Object[]}
     */
    getHighlightsForChapter(chapterIndex) {
        return this._highlights.filter(h => h.chapterIndex === chapterIndex);
    }

    /**
     * Generate highlight ID
     * @returns {string}
     */
    _generateHighlightId() {
        return `highlight_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    }

    /**
     * Notify highlights change
     */
    _notifyHighlightsChange() {
        this._onHighlightsChange?.();
    }

    /**
     * Get context sentences for Q&A (last N sentences before current position)
     * @param {number} [count=20]
     * @returns {Promise<string[]>}
     */
    async getContextSentences(count = 20) {
        if (!this._currentBook) {
            return [];
        }

        const context = [];
        let remaining = count;
        let chapterIdx = this._position.chapterIndex;
        let sentenceIdx = this._position.sentenceIndex;

        while (remaining > 0 && chapterIdx >= 0) {
            const sentences = await this.loadChapter(chapterIdx);
            const startIdx = Math.max(0, sentenceIdx - remaining + 1);
            const chunk = sentences.slice(startIdx, sentenceIdx + 1);

            context.unshift(...chunk);
            remaining -= chunk.length;

            // Move to previous chapter
            chapterIdx--;
            if (chapterIdx >= 0) {
                const prevSentences = await this.loadChapter(chapterIdx);
                sentenceIdx = prevSentences.length - 1;
            }
        }

        return context.slice(-count);
    }

    /**
     * Get context sentences after current position for Q&A
     * @param {number} [count=5]
     * @returns {Promise<string[]>}
     */
    async getContextSentencesAfter(count = 5) {
        if (!this._currentBook) {
            return [];
        }

        const context = [];
        let remaining = count;
        let chapterIdx = this._position.chapterIndex;
        let sentenceIdx = this._position.sentenceIndex + 1; // Start after current

        while (remaining > 0 && chapterIdx < this._currentBook.chapters.length) {
            const sentences = await this.loadChapter(chapterIdx);

            // Get sentences from current position to end of chapter or remaining count
            const endIdx = Math.min(sentenceIdx + remaining, sentences.length);
            const chunk = sentences.slice(sentenceIdx, endIdx);

            context.push(...chunk);
            remaining -= chunk.length;

            // Move to next chapter
            chapterIdx++;
            sentenceIdx = 0;
        }

        return context.slice(0, count);
    }

    /**
     * Schedule position save (debounced)
     */
    _schedulePositionSave() {
        if (!this._currentBook) return;

        if (this._saveTimeout) {
            clearTimeout(this._saveTimeout);
        }

        this._saveTimeout = setTimeout(async () => {
            try {
                await storage.savePosition({
                    bookId: this._currentBook.id,
                    chapterIndex: this._position.chapterIndex,
                    sentenceIndex: this._position.sentenceIndex
                });
                console.log('Position saved:', this._position);
            } catch (error) {
                console.error('Failed to save position:', error);
            }
        }, 2000); // Save 2 seconds after last position change
    }

    /**
     * Save position immediately
     * @returns {Promise<void>}
     */
    async savePositionNow() {
        if (!this._currentBook) return;

        if (this._saveTimeout) {
            clearTimeout(this._saveTimeout);
            this._saveTimeout = null;
        }

        await storage.savePosition({
            bookId: this._currentBook.id,
            chapterIndex: this._position.chapterIndex,
            sentenceIndex: this._position.sentenceIndex
        });
    }

    /**
     * Notify position change
     */
    _notifyPositionChange() {
        this._onPositionChange?.(this._position.chapterIndex, this._position.sentenceIndex);
    }

    /**
     * Notify bookmarks change
     */
    _notifyBookmarksChange() {
        this._onBookmarksChange?.();
    }

    /**
     * Generate book ID from filename
     * @param {string} filename
     * @returns {string}
     */
    _generateBookId(filename) {
        const timestamp = Date.now();
        const random = Math.random().toString(36).substring(2, 9);
        return `${filename.replace(/[^a-z0-9]/gi, '_')}_${timestamp}_${random}`;
    }

    /**
     * Generate bookmark ID
     * @returns {string}
     */
    _generateBookmarkId() {
        return `bookmark_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    }

    /**
     * Cleanup
     */
    destroy() {
        if (this._saveTimeout) {
            clearTimeout(this._saveTimeout);
        }
    }
}
