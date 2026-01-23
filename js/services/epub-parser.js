/**
 * EPUB Parser Service
 * Handles loading and parsing EPUB files using epub.js
 */

import { splitIntoSentences } from '../utils/sentence-splitter.js';
import { hashString, htmlToText } from '../utils/helpers.js';

/**
 * @typedef {Object} Chapter
 * @property {string} id
 * @property {string} title
 * @property {string} href
 * @property {string[]} sentences
 */

/**
 * @typedef {Object} BookState
 * @property {string} id
 * @property {string} title
 * @property {string} author
 * @property {Blob|null} coverImage
 * @property {Chapter[]} chapters
 * @property {number} lastOpened
 */

export class EPUBParser {
    constructor() {
        this._book = null;
    }

    /**
     * Load an EPUB file
     * @param {File} file
     * @returns {Promise<BookState>}
     */
    async loadFromFile(file) {
        // Validate file type
        if (!file.name.toLowerCase().endsWith('.epub')) {
            throw new Error('Invalid file type. Please select an EPUB file.');
        }

        // Create array buffer from file
        const arrayBuffer = await file.arrayBuffer();

        // Generate book ID from content hash
        const idSource = file.name + file.size + file.lastModified;
        const bookId = await hashString(idSource);

        // Initialize epub.js book
        // @ts-ignore - ePub is loaded globally
        this._book = ePub(arrayBuffer);

        // Wait for book to be ready
        await this._book.ready;

        // Extract metadata
        const metadata = await this._extractMetadata();

        // Parse chapters
        const chapters = await this._parseChapters();

        // Get cover image
        const coverImage = await this._extractCover();

        return {
            id: bookId,
            title: metadata.title || file.name.replace('.epub', ''),
            author: metadata.author || 'Unknown Author',
            coverImage,
            chapters,
            lastOpened: Date.now()
        };
    }

    /**
     * Extract book metadata
     * @returns {Promise<{title: string, author: string}>}
     */
    async _extractMetadata() {
        const metadata = this._book.package.metadata;

        return {
            title: metadata.title || '',
            author: metadata.creator || ''
        };
    }

    /**
     * Extract cover image
     * @returns {Promise<Blob|null>}
     */
    async _extractCover() {
        try {
            const coverUrl = await this._book.coverUrl();
            if (coverUrl) {
                const response = await fetch(coverUrl);
                return await response.blob();
            }
        } catch (e) {
            console.warn('Could not extract cover:', e);
        }
        return null;
    }

    /**
     * Parse all chapters from the EPUB
     * @returns {Promise<Chapter[]>}
     */
    async _parseChapters() {
        const spine = this._book.spine;
        const toc = this._book.navigation?.toc || [];
        const chapters = [];

        // Create a map of href to toc title
        const tocMap = new Map();
        this._flattenToc(toc, tocMap);

        // Iterate through spine items
        for (let i = 0; i < spine.items.length; i++) {
            const item = spine.items[i];

            // Get chapter content
            const doc = await this._book.load(item.href);

            // Extract text content
            const textContent = this._extractText(doc);

            // Skip empty chapters
            if (!textContent.trim()) {
                continue;
            }

            // Split into sentences
            const sentences = splitIntoSentences(textContent);

            // Skip chapters with no valid sentences
            if (sentences.length === 0) {
                continue;
            }

            // Find title from TOC or generate one
            const title = tocMap.get(item.href) ||
                          tocMap.get(item.href.split('#')[0]) ||
                          `Chapter ${chapters.length + 1}`;

            chapters.push({
                id: item.idref || `chapter-${i}`,
                title,
                href: item.href,
                sentences
            });
        }

        return chapters;
    }

    /**
     * Flatten TOC structure into a map
     * @param {Array} toc
     * @param {Map} map
     */
    _flattenToc(toc, map) {
        for (const item of toc) {
            if (item.href) {
                // Store with and without fragment
                map.set(item.href, item.label?.trim() || '');
                const hrefWithoutFragment = item.href.split('#')[0];
                if (!map.has(hrefWithoutFragment)) {
                    map.set(hrefWithoutFragment, item.label?.trim() || '');
                }
            }
            if (item.subitems && item.subitems.length > 0) {
                this._flattenToc(item.subitems, map);
            }
        }
    }

    /**
     * Extract text content from a document
     * @param {Document} doc
     * @returns {string}
     */
    _extractText(doc) {
        if (!doc || !doc.body) {
            return '';
        }

        // Clone the body to avoid modifying the original
        const body = doc.body.cloneNode(true);

        // Remove elements that shouldn't be read
        const removeSelectors = [
            'script',
            'style',
            'nav',
            'aside',
            '[role="navigation"]',
            '[role="banner"]',
            '.pagebreak',
            '.page-break'
        ];

        body.querySelectorAll(removeSelectors.join(',')).forEach(el => el.remove());

        // Get text content
        let text = '';

        // Process block elements to maintain paragraph structure
        const blockElements = body.querySelectorAll('p, h1, h2, h3, h4, h5, h6, div, li, blockquote');

        if (blockElements.length > 0) {
            const processed = new Set();

            blockElements.forEach(el => {
                // Skip if already processed as part of a parent
                if (processed.has(el)) return;

                // Mark nested elements as processed
                el.querySelectorAll('p, div').forEach(nested => processed.add(nested));

                const elText = el.textContent?.trim();
                if (elText) {
                    text += elText + '\n\n';
                }
            });
        } else {
            // Fallback: get all text content
            text = body.textContent || '';
        }

        // Clean up whitespace
        text = text
            .replace(/[\t ]+/g, ' ')           // Collapse horizontal whitespace
            .replace(/\n{3,}/g, '\n\n')        // Max 2 newlines
            .replace(/^\s+|\s+$/gm, '')        // Trim lines
            .trim();

        return text;
    }

    /**
     * Get chapter content by index (for lazy loading)
     * @param {BookState} book
     * @param {number} chapterIndex
     * @returns {string[]}
     */
    getChapterSentences(book, chapterIndex) {
        if (chapterIndex < 0 || chapterIndex >= book.chapters.length) {
            return [];
        }
        return book.chapters[chapterIndex].sentences;
    }

    /**
     * Destroy the book instance and free resources
     */
    destroy() {
        if (this._book) {
            this._book.destroy();
            this._book = null;
        }
    }
}

// Export singleton instance
export const epubParser = new EPUBParser();
