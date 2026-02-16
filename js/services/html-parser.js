/**
 * HTML Parser Service
 * Handles loading and parsing HTML files.
 * Splits into chapters by <section>/<article> structure first,
 * then falls back to heading-based splitting.
 */

import { FormatParser } from './format-parser.js';
import { wrapSentencesInElement } from '../utils/sentence-wrapper.js';
import { hashString } from '../utils/helpers.js';

export class HTMLParser extends FormatParser {
    constructor() {
        super();
        this._rawHtml = null;
    }

    /**
     * Load an HTML file
     * @param {File} file
     * @returns {Promise<import('./format-parser.js').BookState>}
     */
    async loadFromFile(file) {
        console.time('HTMLParser.loadFromFile');

        const text = await file.text();
        this._rawHtml = text;

        // Generate book ID
        const idSource = file.name + file.size + file.lastModified;
        const bookId = await hashString(idSource);

        // Parse the HTML to extract metadata
        const parser = new DOMParser();
        const doc = parser.parseFromString(text, 'text/html');

        const title = this._extractTitle(doc) || file.name.replace(/\.(html|htm)$/i, '');
        const author = this._extractAuthor(doc) || 'Unknown Author';

        // Split into chapters
        const chapters = this._splitIntoChapters(doc);

        console.timeEnd('HTMLParser.loadFromFile');
        console.log(`HTML loaded: ${chapters.length} chapters`);

        return {
            id: bookId,
            title,
            author,
            coverImage: null,
            chapters,
            fileData: text,
            fileType: 'html',
            lastOpened: Date.now()
        };
    }

    /**
     * Initialize from stored HTML text
     * @param {string} fileData
     * @returns {Promise<void>}
     */
    async initFromStoredData(fileData) {
        this._rawHtml = fileData;
        console.log('HTMLParser reinitialized from stored data');
    }

    /**
     * Load chapter content on demand
     * @param {import('./format-parser.js').BookState} book
     * @param {number} chapterIndex
     * @returns {Promise<string[]>}
     */
    async loadChapter(book, chapterIndex) {
        if (chapterIndex < 0 || chapterIndex >= book.chapters.length) {
            return [];
        }

        const chapter = book.chapters[chapterIndex];

        if (chapter.loaded && chapter.sentences) {
            return chapter.sentences;
        }

        console.time(`HTMLParser.loadChapter[${chapterIndex}]`);

        // Process the stored HTML fragment
        const { html, sentences } = this._processHtmlWithSentences(chapter._htmlContent || '');

        chapter.sentences = sentences;
        chapter.html = html;
        chapter.loaded = true;

        console.timeEnd(`HTMLParser.loadChapter[${chapterIndex}]`);
        console.log(`Chapter ${chapterIndex} loaded: ${sentences.length} sentences`);

        return sentences;
    }

    /**
     * Extract title from <title> tag or first <h1>
     * @param {Document} doc
     * @returns {string|null}
     */
    _extractTitle(doc) {
        // Try <title> first
        const titleEl = doc.querySelector('title');
        if (titleEl?.textContent?.trim()) {
            return titleEl.textContent.trim();
        }
        // Fall back to first <h1>
        const h1 = doc.querySelector('h1');
        return h1?.textContent?.trim() || null;
    }

    /**
     * Extract author from <meta name="author">
     * @param {Document} doc
     * @returns {string|null}
     */
    _extractAuthor(doc) {
        const meta = doc.querySelector('meta[name="author"]');
        return meta?.getAttribute('content')?.trim() || null;
    }

    /**
     * Split HTML document into chapters.
     * Strategy:
     *  1. Look for <section> or <article> elements with content
     *  2. If not found, split by <h1>, then <h2>, etc.
     *  3. If no structure, treat entire body as one chapter
     * @param {Document} doc
     * @returns {Array}
     */
    _splitIntoChapters(doc) {
        const body = doc.body;
        if (!body) {
            return [{
                id: 'chapter-0',
                title: 'Content',
                href: '',
                sentences: null,
                html: null,
                loaded: false,
                _htmlContent: ''
            }];
        }

        // Strategy 1: <section> or <article> elements
        const sections = body.querySelectorAll(':scope > section, :scope > article');
        if (sections.length >= 2) {
            return this._chaptersFromElements(sections);
        }

        // Also check one level deeper (e.g., <main><section>...</section></main>)
        const deepSections = body.querySelectorAll('main > section, main > article, div > section, div > article');
        if (deepSections.length >= 2) {
            return this._chaptersFromElements(deepSections);
        }

        // Strategy 2: Split by heading levels
        for (let level = 1; level <= 6; level++) {
            const headings = body.querySelectorAll(`h${level}`);
            if (headings.length >= 2 || (headings.length === 1 && level === 1)) {
                return this._chaptersFromHeadings(body, headings, level);
            }
        }

        // Strategy 3: Entire body as a single chapter
        return [{
            id: 'chapter-0',
            title: 'Content',
            href: '',
            sentences: null,
            html: null,
            loaded: false,
            _htmlContent: this._sanitizeHtml(body.innerHTML)
        }];
    }

    /**
     * Create chapter objects from <section>/<article> elements
     * @param {NodeList} elements
     * @returns {Array}
     */
    _chaptersFromElements(elements) {
        const chapters = [];

        elements.forEach((el, i) => {
            // Try to extract a title from the first heading in the section
            const heading = el.querySelector('h1, h2, h3, h4, h5, h6');
            const title = heading?.textContent?.trim() || `Section ${i + 1}`;

            chapters.push({
                id: `chapter-${i}`,
                title,
                href: '',
                sentences: null,
                html: null,
                loaded: false,
                _htmlContent: this._sanitizeHtml(el.innerHTML)
            });
        });

        return chapters;
    }

    /**
     * Split body content by heading elements into chapters.
     * Each heading starts a new chapter that includes all content
     * until the next heading of the same level.
     * @param {Element} body
     * @param {NodeList} headings
     * @param {number} level
     * @returns {Array}
     */
    _chaptersFromHeadings(body, headings, level) {
        const chapters = [];
        const headingTag = `H${level}`;

        // Collect all direct children or use a flat view
        // We'll work with the serialized HTML and use heading positions
        const allHtml = body.innerHTML;

        // Get positions of each heading in the HTML
        const headingPositions = [];
        for (const heading of headings) {
            // Create a temporary marker to find the heading in the HTML string
            const headingHtml = heading.outerHTML;
            const idx = allHtml.indexOf(headingHtml, headingPositions.length > 0
                ? headingPositions[headingPositions.length - 1].end
                : 0);
            if (idx !== -1) {
                headingPositions.push({
                    start: idx,
                    end: idx + headingHtml.length,
                    title: heading.textContent?.trim() || `Chapter ${headingPositions.length + 1}`
                });
            }
        }

        if (headingPositions.length === 0) {
            return [{
                id: 'chapter-0',
                title: 'Content',
                href: '',
                sentences: null,
                html: null,
                loaded: false,
                _htmlContent: this._sanitizeHtml(allHtml)
            }];
        }

        // Content before the first heading
        if (headingPositions[0].start > 0) {
            const preamble = allHtml.substring(0, headingPositions[0].start).trim();
            if (preamble && this._hasTextContent(preamble)) {
                chapters.push({
                    id: 'chapter-0',
                    title: 'Preamble',
                    href: '',
                    sentences: null,
                    html: null,
                    loaded: false,
                    _htmlContent: this._sanitizeHtml(preamble)
                });
            }
        }

        // Each heading starts a chapter
        for (let i = 0; i < headingPositions.length; i++) {
            const pos = headingPositions[i];
            const endPos = i + 1 < headingPositions.length
                ? headingPositions[i + 1].start
                : allHtml.length;
            const content = allHtml.substring(pos.start, endPos).trim();

            chapters.push({
                id: `chapter-${chapters.length}`,
                title: pos.title,
                href: '',
                sentences: null,
                html: null,
                loaded: false,
                _htmlContent: this._sanitizeHtml(content)
            });
        }

        return chapters;
    }

    /**
     * Check if an HTML string has meaningful text content
     * @param {string} html
     * @returns {boolean}
     */
    _hasTextContent(html) {
        const div = document.createElement('div');
        div.innerHTML = html;
        return div.textContent?.trim().length > 0;
    }

    /**
     * Sanitize HTML string - remove scripts, event handlers, etc.
     * @param {string} html
     * @returns {string}
     */
    _sanitizeHtml(html) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const body = doc.body;

        // Remove dangerous elements
        const removeSelectors = [
            'script', 'style', 'link[rel="stylesheet"]',
            'iframe', 'object', 'embed',
            '[role="navigation"]', '[role="banner"]',
            'nav', 'aside'
        ];
        body.querySelectorAll(removeSelectors.join(',')).forEach(el => el.remove());

        // Remove event handler attributes
        const allElements = body.querySelectorAll('*');
        allElements.forEach(el => {
            const attrs = [...el.attributes];
            for (const attr of attrs) {
                if (attr.name.startsWith('on') || attr.name === 'style') {
                    el.removeAttribute(attr.name);
                }
            }
        });

        return body.innerHTML;
    }

    /**
     * Process HTML string: wrap sentences in spans
     * @param {string} rawHtml
     * @returns {{ html: string, sentences: string[] }}
     */
    _processHtmlWithSentences(rawHtml) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(rawHtml, 'text/html');
        const body = doc.body;

        if (!body || !body.textContent?.trim()) {
            return { html: '<div class="html-content"></div>', sentences: [] };
        }

        // Wrap sentences
        const sentences = [];
        wrapSentencesInElement(body, sentences);

        const wrapper = document.createElement('div');
        wrapper.className = 'html-content';
        wrapper.innerHTML = body.innerHTML;

        return { html: wrapper.outerHTML, sentences };
    }

}
