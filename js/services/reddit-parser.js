/**
 * Reddit Parser Service
 *
 * Turns a fetched Reddit thread into a BookState: chapter 0 is the post,
 * then one chapter per top-level comment subtree.
 *
 * The raw thread JSON is kept as `book.fileData` so re-opening works offline
 * and a rendering change only needs a re-parse, not a re-fetch. Chapter HTML is
 * produced lazily in `loadChapter()`, matching the other format parsers.
 */

import { FormatParser } from './format-parser.js';
import { wrapSentencesInElement } from '../utils/sentence-wrapper.js';
import { convertThread } from './converters/reddit-converter.js';

export class RedditParser extends FormatParser {
    constructor() {
        super();
        /** @type {import('./converters/reddit-converter.js').RedditThread|null} */
        this._thread = null;
    }

    /**
     * Build a book from a raw thread payload.
     *
     * @param {Array} payload - `[postListing, commentListing]`
     * @param {Object} [meta]
     * @param {string} [meta.url] - canonical thread URL
     * @param {string} [meta.threadId]
     * @returns {Promise<import('./format-parser.js').BookState>}
     */
    async loadFromJson(payload, { url = '', threadId = '' } = {}) {
        console.time('RedditParser.loadFromJson');

        const thread = convertThread(payload);
        this._thread = thread;

        const chapters = thread.chapters.map((chapter, i) => ({
            id: `chapter-${i}`,
            title: chapter.title,
            href: '',
            sentences: null,
            html: null,
            loaded: false
        }));

        console.timeEnd('RedditParser.loadFromJson');
        console.log(
            `Reddit thread loaded: ${chapters.length} chapters, ${thread.commentCount} comments`
        );

        return {
            id: threadId ? `reddit_${threadId}` : `reddit_${Date.now()}`,
            title: thread.title,
            author: `u/${thread.author}${thread.subreddit ? ` in r/${thread.subreddit}` : ''}`,
            coverImage: null,
            chapters,
            fileData: JSON.stringify(payload),
            fileType: 'reddit',
            lastOpened: Date.now()
        };
    }

    /**
     * Load a hand-saved thread `.json` file.
     * @param {File} file
     * @returns {Promise<import('./format-parser.js').BookState>}
     */
    async loadFromFile(file) {
        const text = await file.text();
        let payload;
        try {
            payload = JSON.parse(text);
        } catch {
            throw new Error('That file is not valid Reddit thread JSON');
        }
        return this.loadFromJson(payload);
    }

    /**
     * Re-hydrate from the stored raw JSON.
     * @param {string} fileData
     * @returns {Promise<void>}
     */
    async initFromStoredData(fileData) {
        const payload = typeof fileData === 'string' ? JSON.parse(fileData) : fileData;
        this._thread = convertThread(payload);
        console.log('RedditParser reinitialized from stored data');
    }

    /**
     * Render a chapter on demand.
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

        if (!this._thread) {
            await this.initFromStoredData(book.fileData);
        }

        const source = this._thread?.chapters?.[chapterIndex];
        if (!source) {
            console.warn(`RedditParser: no rendered content for chapter ${chapterIndex}`);
            chapter.sentences = [];
            chapter.html = '<div class="reddit-content"></div>';
            chapter.loaded = true;
            return [];
        }

        const { html, sentences } = this._processHtmlWithSentences(source.html);

        chapter.sentences = sentences;
        chapter.html = html;
        chapter.loaded = true;

        return sentences;
    }

    destroy() {
        this._thread = null;
    }

    /**
     * Parse an HTML fragment and wrap its sentences in indexed spans.
     * @param {string} rawHtml
     * @returns {{ html: string, sentences: string[] }}
     */
    _processHtmlWithSentences(rawHtml) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(rawHtml, 'text/html');
        const body = doc.body;

        if (!body || !body.textContent?.trim()) {
            return { html: '<div class="reddit-content"></div>', sentences: [] };
        }

        const sentences = [];
        wrapSentencesInElement(body, sentences);

        const wrapper = document.createElement('div');
        wrapper.className = 'reddit-content';
        wrapper.innerHTML = body.innerHTML;

        return { html: wrapper.outerHTML, sentences };
    }
}
