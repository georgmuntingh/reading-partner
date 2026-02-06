/**
 * Markdown Parser Service
 * Handles loading and parsing Markdown files.
 * Converts Markdown to HTML, then splits into chapters by heading level.
 */

import { FormatParser } from './format-parser.js';
import { splitIntoSentences } from '../utils/sentence-splitter.js';
import { hashString } from '../utils/helpers.js';
import { marked } from 'marked';

export class MarkdownParser extends FormatParser {
    constructor() {
        super();
        this._rawText = null;

        // Configure marked for safe output
        marked.setOptions({
            gfm: true,
            breaks: false,
        });
    }

    /**
     * Load a Markdown file
     * @param {File} file
     * @returns {Promise<import('./format-parser.js').BookState>}
     */
    async loadFromFile(file) {
        console.time('MarkdownParser.loadFromFile');

        const text = await file.text();
        this._rawText = text;

        // Generate book ID
        const idSource = file.name + file.size + file.lastModified;
        const bookId = await hashString(idSource);

        // Extract metadata
        const title = this._extractTitle(text) || file.name.replace(/\.(md|markdown)$/i, '');

        // Split into chapters
        const chapters = this._splitIntoChapters(text);

        console.timeEnd('MarkdownParser.loadFromFile');
        console.log(`Markdown loaded: ${chapters.length} chapters`);

        return {
            id: bookId,
            title,
            author: 'Unknown Author',
            coverImage: null,
            chapters,
            fileData: text,
            fileType: 'markdown',
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
        console.log('MarkdownParser reinitialized from stored data');
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

        console.time(`MarkdownParser.loadChapter[${chapterIndex}]`);

        // Convert chapter markdown to HTML
        const rawHtml = marked.parse(chapter._markdownContent || '');

        // Process HTML through DOM to wrap sentences
        const { html, sentences } = this._processHtmlWithSentences(rawHtml);

        chapter.sentences = sentences;
        chapter.html = html;
        chapter.loaded = true;

        console.timeEnd(`MarkdownParser.loadChapter[${chapterIndex}]`);
        console.log(`Chapter ${chapterIndex} loaded: ${sentences.length} sentences`);

        return sentences;
    }

    /**
     * Replace fenced code block contents with whitespace of equal length.
     * This preserves character offsets so heading regex matches on the
     * masked string correspond to the correct positions in the original.
     * @param {string} text
     * @returns {string}
     */
    _maskCodeBlocks(text) {
        // Match fenced code blocks: ``` or ~~~ with optional language tag
        return text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, (match) => {
            // Replace every character except newlines with a space
            return match.replace(/[^\n]/g, ' ');
        });
    }

    /**
     * Extract title from the first H1 heading (ignoring code blocks)
     * @param {string} text
     * @returns {string|null}
     */
    _extractTitle(text) {
        const masked = this._maskCodeBlocks(text);
        const match = masked.match(/^#\s+(.+)$/m);
        if (!match) return null;
        // Read the title from the original text at the same position
        const titleStart = match.index + match[0].indexOf(match[1]);
        return text.substring(titleStart, titleStart + match[1].length).trim();
    }

    /**
     * Split markdown text into chapters by heading level.
     * Strategy: split on H1 (#), or if no H1s exist, split on H2 (##), etc.
     * If no headings exist, treat the entire file as one chapter.
     * Headings inside fenced code blocks are ignored.
     * @param {string} text
     * @returns {Array}
     */
    _splitIntoChapters(text) {
        // Mask code blocks so # inside them doesn't match as headings
        const masked = this._maskCodeBlocks(text);

        // Try heading levels 1 through 6
        for (let level = 1; level <= 6; level++) {
            const prefix = '#'.repeat(level);
            // Match lines that start with exactly `level` hashes followed by a space
            const regex = new RegExp(`^${prefix}\\s+(.+)$`, 'gm');
            const matches = [...masked.matchAll(regex)];

            if (matches.length >= 2 || (matches.length === 1 && level === 1)) {
                // Re-read match titles from original text (masked has spaces)
                const originalMatches = matches.map(m => {
                    const fullLine = text.substring(m.index, m.index + m[0].length);
                    const titleMatch = fullLine.match(/^#{1,6}\s+(.+)$/);
                    return {
                        index: m.index,
                        0: m[0],
                        1: titleMatch ? titleMatch[1] : m[1]
                    };
                });
                return this._splitByMatches(text, originalMatches, prefix.length);
            }
        }

        // No headings found: single chapter
        return [{
            id: 'chapter-0',
            title: 'Content',
            href: '',
            sentences: null,
            html: null,
            loaded: false,
            _markdownContent: text
        }];
    }

    /**
     * Split text into chapters using heading match positions
     * @param {string} text
     * @param {RegExpMatchArray[]} matches
     * @param {number} headingLevel
     * @returns {Array}
     */
    _splitByMatches(text, matches, headingLevel) {
        const chapters = [];

        // Content before the first heading (if any)
        const firstMatchIndex = matches[0].index;
        if (firstMatchIndex > 0) {
            const preamble = text.substring(0, firstMatchIndex).trim();
            if (preamble) {
                chapters.push({
                    id: 'chapter-0',
                    title: 'Preamble',
                    href: '',
                    sentences: null,
                    html: null,
                    loaded: false,
                    _markdownContent: preamble
                });
            }
        }

        // Each heading starts a new chapter
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
                _markdownContent: content
            });
        }

        return chapters;
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
            return { html: '<div class="markdown-content"></div>', sentences: [] };
        }

        // Remove dangerous elements
        body.querySelectorAll('script, style').forEach(el => el.remove());

        // Wrap sentences
        const sentences = [];
        this._wrapSentencesInElement(body, sentences);

        const wrapper = document.createElement('div');
        wrapper.className = 'markdown-content';
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
