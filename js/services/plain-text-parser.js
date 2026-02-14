/**
 * Plain Text Parser Service
 * Handles loading and parsing plain text content.
 * Converts plain text to HTML by turning double newlines into paragraphs
 * and single newlines into <br> tags, then splits into chapters by blank-line-separated sections.
 */

import { FormatParser } from './format-parser.js';
import { splitIntoSentences } from '../utils/sentence-splitter.js';
import { hashString } from '../utils/helpers.js';

export class PlainTextParser extends FormatParser {
    constructor() {
        super();
        this._rawText = null;
    }

    /**
     * Load a plain text file
     * @param {File} file
     * @returns {Promise<import('./format-parser.js').BookState>}
     */
    async loadFromFile(file) {
        const text = await file.text();
        return this.loadFromText(text, file.name);
    }

    /**
     * Load from raw text string (used for pasted content)
     * @param {string} text
     * @param {string} [title='Pasted Text']
     * @returns {Promise<import('./format-parser.js').BookState>}
     */
    async loadFromText(text, title = 'Pasted Text') {
        console.time('PlainTextParser.loadFromText');
        this._rawText = text;

        const bookId = await hashString(title + text.length + Date.now());

        const chapters = this._splitIntoChapters(text);

        console.timeEnd('PlainTextParser.loadFromText');
        console.log(`Plain text loaded: ${chapters.length} chapters`);

        return {
            id: bookId,
            title,
            author: 'Unknown Author',
            coverImage: null,
            chapters,
            fileData: text,
            fileType: 'plaintext',
            lastOpened: Date.now()
        };
    }

    /**
     * Initialize from stored text data
     * @param {string} fileData
     * @returns {Promise<void>}
     */
    async initFromStoredData(fileData) {
        this._rawText = fileData;
        console.log('PlainTextParser reinitialized from stored data');
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

        console.time(`PlainTextParser.loadChapter[${chapterIndex}]`);

        const htmlContent = this._textToHtml(chapter._plainTextContent || '');
        const { html, sentences } = this._processHtmlWithSentences(htmlContent);

        chapter.sentences = sentences;
        chapter.html = html;
        chapter.loaded = true;

        console.timeEnd(`PlainTextParser.loadChapter[${chapterIndex}]`);
        console.log(`Chapter ${chapterIndex} loaded: ${sentences.length} sentences`);

        return sentences;
    }

    /**
     * Convert plain text to HTML.
     * Double newlines become paragraph breaks, single newlines become <br>.
     * @param {string} text
     * @returns {string}
     */
    _textToHtml(text) {
        const paragraphs = text.split(/\n{2,}/);
        return paragraphs
            .map(p => p.trim())
            .filter(p => p.length > 0)
            .map(p => {
                const escaped = this._escapeHtml(p);
                const withBreaks = escaped.replace(/\n/g, '<br>');
                return `<p>${withBreaks}</p>`;
            })
            .join('\n');
    }

    /**
     * Escape HTML special characters
     * @param {string} str
     * @returns {string}
     */
    _escapeHtml(str) {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /**
     * Split text into chapters.
     * Strategy: Look for lines that look like chapter headings (all-caps lines,
     * lines with "Chapter N" patterns, or lines preceded/followed by multiple blank lines).
     * Falls back to a single chapter if no structure found.
     * @param {string} text
     * @returns {Array}
     */
    _splitIntoChapters(text) {
        // Try to find chapter-like headings
        const chapterRegex = /^(chapter\s+\w+|part\s+\w+|section\s+\w+|\d+\.\s+.+)$/gmi;
        const matches = [...text.matchAll(chapterRegex)];

        if (matches.length >= 2) {
            return this._splitByMatches(text, matches);
        }

        // Single chapter
        return [{
            id: 'chapter-0',
            title: 'Content',
            href: '',
            sentences: null,
            html: null,
            loaded: false,
            _plainTextContent: text
        }];
    }

    /**
     * Split text into chapters using heading match positions
     * @param {string} text
     * @param {RegExpMatchArray[]} matches
     * @returns {Array}
     */
    _splitByMatches(text, matches) {
        const chapters = [];

        // Content before first heading
        if (matches[0].index > 0) {
            const preamble = text.substring(0, matches[0].index).trim();
            if (preamble) {
                chapters.push({
                    id: 'chapter-0',
                    title: 'Preamble',
                    href: '',
                    sentences: null,
                    html: null,
                    loaded: false,
                    _plainTextContent: preamble
                });
            }
        }

        for (let i = 0; i < matches.length; i++) {
            const match = matches[i];
            const title = match[1].trim();
            const startIndex = match.index;
            const endIndex = i + 1 < matches.length ? matches[i + 1].index : text.length;
            const content = text.substring(startIndex, endIndex).trim();

            chapters.push({
                id: `chapter-${chapters.length}`,
                title,
                href: '',
                sentences: null,
                html: null,
                loaded: false,
                _plainTextContent: content
            });
        }

        return chapters;
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
            return { html: '<div class="plaintext-content"></div>', sentences: [] };
        }

        const sentences = [];
        this._wrapSentencesInElement(body, sentences);

        const wrapper = document.createElement('div');
        wrapper.className = 'plaintext-content';
        wrapper.innerHTML = body.innerHTML;

        return { html: wrapper.outerHTML, sentences };
    }

    /**
     * Walk through element and wrap text content in sentence spans
     * @param {Element} element
     * @param {string[]} sentences
     */
    _wrapSentencesInElement(element, sentences) {
        const skipTags = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA']);

        const walker = document.createTreeWalker(
            element,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode: (node) => {
                    let parent = node.parentNode;
                    while (parent && parent !== element) {
                        if (skipTags.has(parent.tagName)) {
                            return NodeFilter.FILTER_REJECT;
                        }
                        parent = parent.parentNode;
                    }
                    if (!node.textContent?.trim()) {
                        return NodeFilter.FILTER_REJECT;
                    }
                    return NodeFilter.FILTER_ACCEPT;
                }
            }
        );

        const textNodes = [];
        while (walker.nextNode()) {
            textNodes.push(walker.currentNode);
        }

        for (const textNode of textNodes) {
            this._wrapTextNodeSentences(textNode, sentences);
        }
    }

    /**
     * Wrap sentences within a text node
     * @param {Text} textNode
     * @param {string[]} sentences
     */
    _wrapTextNodeSentences(textNode, sentences) {
        const text = textNode.textContent;
        if (!text?.trim()) return;

        const nodeSentences = splitIntoSentences(text);
        if (nodeSentences.length === 0) return;

        const fragment = document.createDocumentFragment();
        let remainingText = text;

        for (const sentence of nodeSentences) {
            const trimmedSentence = sentence.trim();
            if (!trimmedSentence) continue;

            const sentenceIndex = remainingText.indexOf(trimmedSentence);
            if (sentenceIndex === -1) continue;

            if (sentenceIndex > 0) {
                fragment.appendChild(document.createTextNode(remainingText.substring(0, sentenceIndex)));
            }

            const span = document.createElement('span');
            span.className = 'sentence';
            span.dataset.index = sentences.length.toString();
            span.textContent = trimmedSentence;
            fragment.appendChild(span);

            const afterIndex = sentenceIndex + trimmedSentence.length;
            if (afterIndex < remainingText.length && /\s/.test(remainingText[afterIndex])) {
                fragment.appendChild(document.createTextNode(' '));
            }

            sentences.push(trimmedSentence);
            remainingText = remainingText.substring(afterIndex).replace(/^\s+/, '');
        }

        if (remainingText.trim()) {
            fragment.appendChild(document.createTextNode(remainingText));
        }

        textNode.parentNode.replaceChild(fragment, textNode);
    }
}
