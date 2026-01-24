/**
 * EPUB Parser Service
 * Handles loading and parsing EPUB files using epub.js
 * Uses lazy loading - chapters are parsed on-demand
 */

import { splitIntoSentences } from '../utils/sentence-splitter.js';
import { hashString } from '../utils/helpers.js';

/**
 * @typedef {Object} Chapter
 * @property {string} id
 * @property {string} title
 * @property {string} href
 * @property {string[]|null} sentences - null until loaded
 * @property {boolean} loaded
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
     * Load an EPUB file (metadata only, chapters are lazy-loaded)
     * @param {File} file
     * @returns {Promise<BookState>}
     */
    async loadFromFile(file) {
        console.time('EPUBParser.loadFromFile');

        // Validate file type
        if (!file.name.toLowerCase().endsWith('.epub')) {
            throw new Error('Invalid file type. Please select an EPUB file.');
        }

        // Create array buffer from file
        console.time('EPUBParser.readFile');
        const arrayBuffer = await file.arrayBuffer();
        console.timeEnd('EPUBParser.readFile');

        // Generate book ID from content hash
        const idSource = file.name + file.size + file.lastModified;
        const bookId = await hashString(idSource);

        // Initialize epub.js book
        console.time('EPUBParser.initBook');
        // @ts-ignore - ePub is loaded globally
        this._book = ePub(arrayBuffer);
        await this._book.ready;
        console.timeEnd('EPUBParser.initBook');

        // Extract metadata
        const metadata = await this._extractMetadata();

        // Get chapter metadata only (NOT content)
        console.time('EPUBParser.getChapterMetadata');
        const chapters = await this._getChapterMetadata();
        console.timeEnd('EPUBParser.getChapterMetadata');

        // Get cover image
        const coverImage = await this._extractCover();

        console.timeEnd('EPUBParser.loadFromFile');
        console.log(`Book loaded: ${chapters.length} chapters (content will be loaded on-demand)`);

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
     * Get chapter metadata without parsing content
     * @returns {Promise<Chapter[]>}
     */
    async _getChapterMetadata() {
        const spine = this._book.spine;
        const toc = this._book.navigation?.toc || [];
        const chapters = [];

        // Create a map of href to toc title
        const tocMap = new Map();
        this._flattenToc(toc, tocMap);

        // Just get metadata, don't parse content
        for (let i = 0; i < spine.items.length; i++) {
            const item = spine.items[i];

            const title = tocMap.get(item.href) ||
                          tocMap.get(item.href.split('#')[0]) ||
                          `Chapter ${i + 1}`;

            chapters.push({
                id: item.idref || `chapter-${i}`,
                title,
                href: item.href,
                sentences: null, // Not loaded yet
                loaded: false
            });
        }

        return chapters;
    }

    /**
     * Load chapter content (lazy loading)
     * @param {BookState} book
     * @param {number} chapterIndex
     * @returns {Promise<string[]>}
     */
    async loadChapter(book, chapterIndex) {
        if (chapterIndex < 0 || chapterIndex >= book.chapters.length) {
            return [];
        }

        const chapter = book.chapters[chapterIndex];

        // Return cached if already loaded
        if (chapter.loaded && chapter.sentences) {
            console.log(`Chapter ${chapterIndex} already loaded (${chapter.sentences.length} sentences)`);
            return chapter.sentences;
        }

        console.time(`EPUBParser.loadChapter[${chapterIndex}]`);
        console.log(`Loading chapter ${chapterIndex}: "${chapter.title}"`);

        try {
            // Load chapter HTML
            const doc = await this._book.load(chapter.href);

            // Extract text content
            const textContent = this._extractText(doc);

            if (!textContent.trim()) {
                chapter.sentences = [];
                chapter.loaded = true;
                console.timeEnd(`EPUBParser.loadChapter[${chapterIndex}]`);
                return [];
            }

            // Split into sentences
            const sentences = splitIntoSentences(textContent);

            // Cache the result
            chapter.sentences = sentences;
            chapter.loaded = true;

            console.timeEnd(`EPUBParser.loadChapter[${chapterIndex}]`);
            console.log(`Chapter ${chapterIndex} loaded: ${sentences.length} sentences`);

            return sentences;

        } catch (error) {
            console.error(`Failed to load chapter ${chapterIndex}:`, error);
            chapter.sentences = [];
            chapter.loaded = true;
            return [];
        }
    }

    /**
     * Flatten TOC structure into a map
     * @param {Array} toc
     * @param {Map} map
     */
    _flattenToc(toc, map) {
        for (const item of toc) {
            if (item.href) {
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
            'script', 'style', 'nav', 'aside',
            '[role="navigation"]', '[role="banner"]',
            '.pagebreak', '.page-break'
        ];

        body.querySelectorAll(removeSelectors.join(',')).forEach(el => el.remove());

        // Get text content
        let text = '';

        // Process block elements to maintain paragraph structure
        const blockElements = body.querySelectorAll('p, h1, h2, h3, h4, h5, h6, div, li, blockquote');

        if (blockElements.length > 0) {
            const processed = new Set();

            blockElements.forEach(el => {
                if (processed.has(el)) return;
                el.querySelectorAll('p, div').forEach(nested => processed.add(nested));

                const elText = el.textContent?.trim();
                if (elText) {
                    text += elText + '\n\n';
                }
            });
        } else {
            text = body.textContent || '';
        }

        // Clean up whitespace
        text = text
            .replace(/[\t ]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .replace(/^\s+|\s+$/gm, '')
            .trim();

        return text;
    }

    /**
     * Get chapter sentences (for compatibility)
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
