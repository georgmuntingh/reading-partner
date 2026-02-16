/**
 * PDF Parser Service
 * Handles loading and parsing PDF files.
 * Uses the modular pdf-converter to extract Markdown, then processes
 * it through the same HTML/sentence pipeline as other formats.
 */

import { FormatParser } from './format-parser.js';
import { wrapSentencesInElement } from '../utils/sentence-wrapper.js';
import { hashString } from '../utils/helpers.js';
import { convertPdfToMarkdown } from './converters/pdf-converter.js';
import { marked } from 'marked';

export class PDFParser extends FormatParser {
    constructor() {
        super();
        this._rawData = null;

        // Configure marked for safe output
        marked.setOptions({
            gfm: true,
            breaks: false,
        });
    }

    /**
     * Load a PDF file
     * @param {File} file
     * @returns {Promise<import('./format-parser.js').BookState>}
     */
    async loadFromFile(file) {
        console.time('PDFParser.loadFromFile');

        const arrayBuffer = await file.arrayBuffer();
        // Copy the buffer before pdf.js detaches it during processing
        const storageCopy = arrayBuffer.slice(0);
        this._rawData = storageCopy;

        // Generate book ID
        const idSource = file.name + file.size + file.lastModified;
        const bookId = await hashString(idSource);

        // Convert PDF to Markdown via the modular converter
        const result = await convertPdfToMarkdown(arrayBuffer);

        const title = result.title || file.name.replace(/\.pdf$/i, '');

        // Build chapter stubs with Markdown content for lazy loading
        const chapters = result.chapters.map((ch, i) => ({
            id: `chapter-${i}`,
            title: ch.title,
            href: '',
            sentences: null,
            html: null,
            loaded: false,
            _markdownContent: ch.markdown
        }));

        console.timeEnd('PDFParser.loadFromFile');
        console.log(`PDF loaded: ${chapters.length} pages/chapters`);

        return {
            id: bookId,
            title,
            author: 'Unknown Author',
            coverImage: null,
            chapters,
            fileData: storageCopy,
            fileType: 'pdf',
            lastOpened: Date.now()
        };
    }

    /**
     * Initialize from stored PDF data
     * @param {ArrayBuffer} fileData
     * @returns {Promise<void>}
     */
    async initFromStoredData(fileData) {
        this._rawData = fileData;
        console.log('PDFParser reinitialized from stored data');
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

        console.time(`PDFParser.loadChapter[${chapterIndex}]`);

        // Convert the chapter's Markdown to HTML, then process sentences
        const rawHtml = marked.parse(chapter._markdownContent || '');
        const { html, sentences } = this._processHtmlWithSentences(rawHtml);

        chapter.sentences = sentences;
        chapter.html = html;
        chapter.loaded = true;

        console.timeEnd(`PDFParser.loadChapter[${chapterIndex}]`);
        console.log(`Chapter ${chapterIndex} loaded: ${sentences.length} sentences`);

        return sentences;
    }

    /**
     * Process HTML string: sanitize, create DOM, wrap sentences in spans
     * @param {string} rawHtml
     * @returns {{ html: string, sentences: string[] }}
     */
    _processHtmlWithSentences(rawHtml) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(rawHtml, 'text/html');
        const body = doc.body;

        if (!body || !body.textContent?.trim()) {
            return { html: '<div class="pdf-content"></div>', sentences: [] };
        }

        // Remove dangerous elements
        body.querySelectorAll('script, style').forEach(el => el.remove());

        // Wrap sentences
        const sentences = [];
        wrapSentencesInElement(body, sentences);

        const wrapper = document.createElement('div');
        wrapper.className = 'pdf-content';
        wrapper.innerHTML = body.innerHTML;

        return { html: wrapper.outerHTML, sentences };
    }

}
