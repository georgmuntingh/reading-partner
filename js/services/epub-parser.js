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
            epubData: arrayBuffer, // Store for persistence across sessions
            lastOpened: Date.now()
        };
    }

    /**
     * Initialize epub.js from a stored ArrayBuffer (for resuming sessions)
     * @param {ArrayBuffer} arrayBuffer
     * @returns {Promise<void>}
     */
    async initFromArrayBuffer(arrayBuffer) {
        if (this._book) {
            this._book.destroy();
        }
        // @ts-ignore - ePub is loaded globally
        this._book = ePub(arrayBuffer);
        await this._book.ready;
        console.log('EPUBParser reinitialized from stored data');
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
        // Method 1: Use the already-resolved cover path from epub.js directly
        // book.cover is set via book.resolve(packaging.cover) which produces
        // a path like "/OEBPS/cover.jpeg" — suitable for archive.getBlob()
        try {
            if (this._book.cover) {
                const blob = await this._book.archive.getBlob(this._book.cover).catch(() => null);
                if (blob && blob.size > 0) {
                    return this._ensureBlobMimeType(blob, this._book.cover);
                }
            }
        } catch (e) {
            // Direct archive access failed, try fallback
        }

        // Method 2: Use coverUrl() which creates a blob URL, then fetch it
        try {
            const coverUrl = await this._book.coverUrl();
            if (coverUrl) {
                const response = await fetch(coverUrl);
                if (response.ok) {
                    return await response.blob();
                }
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
                html: null, // Not loaded yet
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

            // Debug: log what we got
            console.log('Loaded doc type:', typeof doc, doc);
            console.log('Doc has body:', !!doc?.body);
            if (doc?.body) {
                console.log('Body innerHTML length:', doc.body.innerHTML?.length);
                console.log('Body textContent length:', doc.body.textContent?.length);
            }

            // Process HTML and wrap sentences
            const { html, sentences } = await this._processHtmlWithSentences(doc, chapter.href);
            console.log(`Processed HTML length: ${html.length}, sentences: ${sentences.length}`);

            if (sentences.length === 0) {
                console.warn('Chapter has no text content');
                chapter.sentences = [];
                chapter.html = html || '<div class="epub-content"></div>';
                chapter.loaded = true;
                console.timeEnd(`EPUBParser.loadChapter[${chapterIndex}]`);
                return [];
            }

            // Cache the result
            chapter.sentences = sentences;
            chapter.html = html;
            chapter.loaded = true;

            console.timeEnd(`EPUBParser.loadChapter[${chapterIndex}]`);
            console.log(`Chapter ${chapterIndex} loaded: ${sentences.length} sentences`);

            return sentences;

        } catch (error) {
            console.error(`Failed to load chapter ${chapterIndex}:`, error);
            chapter.sentences = [];
            chapter.html = '<div class="epub-content"></div>';
            chapter.loaded = true;
            return [];
        }
    }

    /**
     * Process HTML document and wrap sentences in spans
     * @param {Document|Element|string} doc
     * @param {string} chapterHref - href for resolving relative URLs
     * @returns {Promise<{html: string, sentences: string[]}>}
     */
    async _processHtmlWithSentences(doc, chapterHref) {
        // Get the body element
        let body = this._getBodyElement(doc);
        if (!body) {
            return { html: '<div class="epub-content"></div>', sentences: [] };
        }

        // Clone to avoid modifying original
        body = body.cloneNode(true);

        // Remove elements that shouldn't be displayed
        const removeSelectors = [
            'script', 'style', 'nav', 'aside',
            '[role="navigation"]', '[role="banner"]',
            '.pagebreak', '.page-break'
        ];
        body.querySelectorAll(removeSelectors.join(',')).forEach(el => el.remove());

        // Fix image sources to use blob URLs from epub.js (wait for all images to load)
        await this._fixImageSources(body, chapterHref);

        // Wrap sentences in spans
        const sentences = [];
        this._wrapSentencesInElement(body, sentences);

        // Wrap in epub-content div
        const wrapper = document.createElement('div');
        wrapper.className = 'epub-content';
        wrapper.innerHTML = body.innerHTML;

        return { html: wrapper.outerHTML, sentences };
    }

    /**
     * Get body element from various document types
     * @param {Document|Element|string} doc
     * @returns {Element|null}
     */
    _getBodyElement(doc) {
        if (!doc) return null;

        // If doc is a string (HTML), parse it
        if (typeof doc === 'string') {
            const parser = new DOMParser();
            const parsed = parser.parseFromString(doc, 'text/html');
            return parsed.body;
        }
        // If doc has a body property (Document)
        if (doc.body) {
            return doc.body;
        }
        // If doc is an Element itself
        if (doc.nodeType === Node.ELEMENT_NODE) {
            return doc;
        }
        // If doc has documentElement (XML document)
        if (doc.documentElement) {
            return doc.documentElement;
        }
        return null;
    }

    /**
     * Fix image sources in HTML to use proper URLs
     * @param {Element} element
     * @param {string} chapterHref
     * @returns {Promise<void>}
     */
    async _fixImageSources(element, chapterHref) {
        const imagePromises = [];

        // Handle regular img elements
        const images = element.querySelectorAll('img');
        images.forEach(img => {
            const src = img.getAttribute('src');
            if (src && !src.startsWith('data:') && !src.startsWith('blob:') && !src.startsWith('http')) {
                const promise = this._loadImageBlob(src, chapterHref)
                    .then(blob => {
                        if (blob) {
                            img.src = URL.createObjectURL(blob);
                        }
                    })
                    .catch(e => {
                        console.warn('Failed to load image:', src, e);
                    });
                imagePromises.push(promise);
            }
        });

        // Also handle SVG images and image elements within SVG
        const svgImages = element.querySelectorAll('image');
        svgImages.forEach(img => {
            // Try both namespaced and non-namespaced href attributes
            const href = img.getAttribute('href') ||
                        img.getAttribute('xlink:href') ||
                        img.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
            if (href && !href.startsWith('data:') && !href.startsWith('blob:') && !href.startsWith('http')) {
                const promise = this._loadImageBlob(href, chapterHref)
                    .then(blob => {
                        if (blob) {
                            const blobUrl = URL.createObjectURL(blob);
                            // Set both href and xlink:href for compatibility
                            img.setAttribute('href', blobUrl);
                            img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', blobUrl);
                        }
                    })
                    .catch(e => {
                        console.warn('Failed to load SVG image:', href, e);
                    });
                imagePromises.push(promise);
            }
        });

        // Wait for all images to load
        if (imagePromises.length > 0) {
            console.log(`Loading ${imagePromises.length} images...`);
            await Promise.all(imagePromises);
            console.log('All images loaded');
        }
    }

    /**
     * Try multiple strategies to load an image blob from the EPUB archive.
     * epub.js archive.getBlob(url) internally does url.substr(1) to strip a
     * leading "/" before looking up zip entries, so all paths must start with "/".
     * @param {string} src - The image source path from the HTML
     * @param {string} chapterHref - The chapter's href for resolving relative paths
     * @returns {Promise<Blob|null>}
     */
    async _loadImageBlob(src, chapterHref) {
        // Strategy 1: Resolve using full archive path (book directory + chapter href)
        // e.g., book dir "/OEBPS/" + chapter "text/ch1.xhtml" + src "../images/fig.jpg"
        //   → "/OEBPS/images/fig.jpg" → getBlob strips "/" → "OEBPS/images/fig.jpg" ✓
        try {
            const bookDir = this._book?.path?.directory || '/';
            const fullChapterPath = bookDir + chapterHref;
            const archivePath = this._resolveToArchivePath(src, fullChapterPath);
            if (archivePath) {
                const blob = await this._book.archive.getBlob(archivePath).catch(() => null);
                if (blob && blob.size > 0) {
                    return this._ensureBlobMimeType(blob, src);
                }
            }
        } catch (e) {
            // Full path resolution failed
        }

        // Strategy 2: Resolve relative to chapter href only (without book directory prefix)
        // Handles EPUBs where the OPF is at the root
        try {
            const archivePath = this._resolveToArchivePath(src, chapterHref);
            if (archivePath) {
                const blob = await this._book.archive.getBlob(archivePath).catch(() => null);
                if (blob && blob.size > 0) {
                    return this._ensureBlobMimeType(blob, src);
                }
            }
        } catch (e) {
            // Relative resolution failed
        }

        // Strategy 3: Try the raw src path with leading "/"
        try {
            const rawPath = src.startsWith('/') ? src : '/' + src;
            const blob = await this._book.archive.getBlob(rawPath).catch(() => null);
            if (blob && blob.size > 0) {
                return this._ensureBlobMimeType(blob, src);
            }
        } catch (e) {
            // Raw path failed
        }

        // Strategy 4: Use epub.js resolve() with absolute=false (path-only resolution)
        try {
            const resolvedPath = this._book.resolve(src, false);
            if (resolvedPath) {
                const blob = await this._book.archive.getBlob(resolvedPath).catch(() => null);
                if (blob && blob.size > 0) {
                    return this._ensureBlobMimeType(blob, src);
                }
            }
        } catch (e) {
            // resolve() failed
        }

        console.warn('All image loading strategies failed for:', src);
        return null;
    }

    /**
     * Resolve a relative source path against a context file path, returning
     * a normalized path with leading "/" suitable for archive.getBlob().
     * @param {string} src - The relative source path (e.g., "../images/fig.jpg")
     * @param {string} contextPath - The context file path (e.g., "/OEBPS/text/ch1.xhtml")
     * @returns {string|null}
     */
    _resolveToArchivePath(src, contextPath) {
        if (!contextPath) return null;

        // Get the directory of the context path
        const lastSlash = contextPath.lastIndexOf('/');
        const contextDir = lastSlash >= 0 ? contextPath.substring(0, lastSlash) : '';

        // Combine context directory with the source path
        const combined = contextDir ? contextDir + '/' + src : src;

        // Normalize the path (resolve ".." and "." segments)
        const parts = combined.split('/');
        const resolved = [];
        for (const part of parts) {
            if (part === '..' && resolved.length > 0 && resolved[resolved.length - 1] !== '') {
                resolved.pop();
            } else if (part !== '.' && part !== '') {
                resolved.push(part);
            }
        }

        // Return with leading "/" for archive.getBlob() which does url.substr(1)
        return '/' + resolved.join('/');
    }

    /**
     * Ensure a blob has the correct MIME type based on file extension.
     * Some EPUB archives return blobs with empty or generic MIME types,
     * which prevents the browser from displaying images correctly.
     * @param {Blob} blob
     * @param {string} filename
     * @returns {Blob}
     */
    _ensureBlobMimeType(blob, filename) {
        // If the blob already has a specific image MIME type, keep it
        if (blob.type && blob.type.startsWith('image/')) {
            return blob;
        }

        // Infer MIME type from file extension
        const ext = filename.split('.').pop()?.toLowerCase().split('?')[0];
        const mimeTypes = {
            'png': 'image/png',
            'jpg': 'image/jpeg',
            'jpeg': 'image/jpeg',
            'gif': 'image/gif',
            'svg': 'image/svg+xml',
            'webp': 'image/webp',
            'bmp': 'image/bmp',
            'tif': 'image/tiff',
            'tiff': 'image/tiff',
            'avif': 'image/avif',
            'jxl': 'image/jxl',
        };

        const type = mimeTypes[ext];
        if (type) {
            return new Blob([blob], { type });
        }
        return blob;
    }

    /**
     * Walk through element and wrap text content in sentence spans
     * @param {Element} element
     * @param {string[]} sentences - array to collect sentences
     */
    _wrapSentencesInElement(element, sentences) {
        // Elements that should not have their text split
        const skipTags = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA']);
        // Inline elements where we should process children
        const inlineTags = new Set(['A', 'SPAN', 'EM', 'STRONG', 'I', 'B', 'U', 'S', 'MARK', 'SUB', 'SUP', 'SMALL', 'BIG', 'CITE', 'Q', 'ABBR', 'TIME']);

        const walker = document.createTreeWalker(
            element,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode: (node) => {
                    // Skip if parent is a skip tag
                    let parent = node.parentNode;
                    while (parent && parent !== element) {
                        if (skipTags.has(parent.tagName)) {
                            return NodeFilter.FILTER_REJECT;
                        }
                        parent = parent.parentNode;
                    }
                    // Skip if empty or whitespace only
                    if (!node.textContent?.trim()) {
                        return NodeFilter.FILTER_REJECT;
                    }
                    return NodeFilter.FILTER_ACCEPT;
                }
            }
        );

        // Collect all text nodes first (to avoid modifying while iterating)
        const textNodes = [];
        while (walker.nextNode()) {
            textNodes.push(walker.currentNode);
        }

        // Process each text node
        for (const textNode of textNodes) {
            this._wrapTextNodeSentences(textNode, sentences);
        }
    }

    /**
     * Wrap sentences within a text node
     * @param {Text} textNode
     * @param {string[]} sentences - array to collect sentences
     */
    _wrapTextNodeSentences(textNode, sentences) {
        const text = textNode.textContent;
        if (!text?.trim()) return;

        // Split text into sentences
        const nodeSentences = splitIntoSentences(text);
        if (nodeSentences.length === 0) return;

        // Create a document fragment to hold the new nodes
        const fragment = document.createDocumentFragment();

        let remainingText = text;

        for (const sentence of nodeSentences) {
            const trimmedSentence = sentence.trim();
            if (!trimmedSentence) continue;

            // Find where this sentence starts in remaining text
            const sentenceIndex = remainingText.indexOf(trimmedSentence);
            if (sentenceIndex === -1) {
                // Sentence not found - might be normalized differently, try to match
                const normalizedRemaining = remainingText.replace(/\s+/g, ' ');
                const normalizedSentence = trimmedSentence.replace(/\s+/g, ' ');
                const normalizedIndex = normalizedRemaining.indexOf(normalizedSentence);

                if (normalizedIndex === -1) {
                    // Still not found, add as plain text
                    continue;
                }

                // Found in normalized version, find approximate position in original
                const beforeText = remainingText.substring(0, normalizedIndex);
                if (beforeText) {
                    fragment.appendChild(document.createTextNode(beforeText));
                }

                // Create sentence span
                const span = document.createElement('span');
                span.className = 'sentence';
                span.dataset.index = sentences.length.toString();
                span.textContent = trimmedSentence;
                fragment.appendChild(span);

                // Add space after sentence
                fragment.appendChild(document.createTextNode(' '));

                sentences.push(trimmedSentence);

                remainingText = remainingText.substring(normalizedIndex + normalizedSentence.length);
                continue;
            }

            // Add any text before the sentence
            if (sentenceIndex > 0) {
                const beforeText = remainingText.substring(0, sentenceIndex);
                fragment.appendChild(document.createTextNode(beforeText));
            }

            // Create sentence span
            const span = document.createElement('span');
            span.className = 'sentence';
            span.dataset.index = sentences.length.toString();
            span.textContent = trimmedSentence;
            fragment.appendChild(span);

            // Add space after sentence if there was whitespace
            const afterIndex = sentenceIndex + trimmedSentence.length;
            if (afterIndex < remainingText.length && /\s/.test(remainingText[afterIndex])) {
                fragment.appendChild(document.createTextNode(' '));
            }

            sentences.push(trimmedSentence);

            // Update remaining text
            remainingText = remainingText.substring(afterIndex).replace(/^\s+/, '');
        }

        // Add any remaining text
        if (remainingText.trim()) {
            fragment.appendChild(document.createTextNode(remainingText));
        }

        // Replace the text node with the fragment
        textNode.parentNode.replaceChild(fragment, textNode);
    }

    /**
     * Get chapter HTML (for compatibility)
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
     * @param {Document|Element|string} doc
     * @returns {string}
     */
    _extractText(doc) {
        // Handle different types of input
        let body;

        if (!doc) {
            console.warn('_extractText: doc is null/undefined');
            return '';
        }

        // If doc is a string (HTML), parse it
        if (typeof doc === 'string') {
            console.log('_extractText: doc is a string, parsing as HTML');
            const parser = new DOMParser();
            const parsed = parser.parseFromString(doc, 'text/html');
            body = parsed.body;
        }
        // If doc has a body property (Document)
        else if (doc.body) {
            body = doc.body.cloneNode(true);
        }
        // If doc is an Element itself
        else if (doc.nodeType === Node.ELEMENT_NODE) {
            console.log('_extractText: doc is an Element');
            body = doc.cloneNode(true);
        }
        // If doc has documentElement (XML document)
        else if (doc.documentElement) {
            console.log('_extractText: doc has documentElement');
            body = doc.documentElement.cloneNode(true);
        }
        else {
            console.warn('_extractText: unknown doc type', typeof doc, doc);
            return '';
        }

        if (!body) {
            console.warn('_extractText: could not get body');
            return '';
        }

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
        const blockElements = body.querySelectorAll('p, h1, h2, h3, h4, h5, h6, div, li, blockquote, span');
        console.log(`Found ${blockElements.length} block elements`);

        if (blockElements.length > 0) {
            const processed = new Set();

            blockElements.forEach(el => {
                if (processed.has(el)) return;
                el.querySelectorAll('p, div, span').forEach(nested => processed.add(nested));

                const elText = el.textContent?.trim();
                if (elText) {
                    text += elText + '\n\n';
                }
            });
        }

        // Fallback: if no text from block elements, use full body text
        if (!text.trim()) {
            console.log('No text from block elements, using body.textContent');
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
