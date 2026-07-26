import { describe, it, expect, beforeEach } from 'vitest';
import { RedditParser } from '../js/services/reddit-parser.js';
import { getParser, FORMAT_LABELS } from '../js/services/parser-factory.js';

function comment(data, replies = []) {
    return {
        kind: 't1',
        data: {
            author: 'someone',
            body: 'A comment body.',
            score: 10,
            created_utc: 1700000000,
            ...data,
            replies: replies.length ? { kind: 'Listing', data: { children: replies } } : ''
        }
    };
}

function payload(children = []) {
    return [
        {
            kind: 'Listing',
            data: {
                children: [{
                    kind: 't3',
                    data: {
                        title: 'Why did Rome fall?',
                        author: 'historian',
                        subreddit: 'AskHistorians',
                        selftext: 'I have wondered about this. What is the consensus?',
                        score: 4200,
                        created_utc: 1700000000,
                        permalink: '/r/AskHistorians/comments/1abc23/why_did_rome_fall/',
                        is_self: true
                    }
                }]
            }
        },
        { kind: 'Listing', data: { children } }
    ];
}

describe('RedditParser', () => {
    let parser;

    beforeEach(() => {
        parser = new RedditParser();
    });

    it('builds a book with chapter stubs', async () => {
        const book = await parser.loadFromJson(payload([
            comment({ author: 'alice', body: 'First.' }),
            comment({ author: 'bob', body: 'Second.' })
        ]), { threadId: '1abc23', url: 'https://www.reddit.com/comments/1abc23' });

        expect(book.fileType).toBe('reddit');
        expect(book.title).toBe('Why did Rome fall?');
        expect(book.author).toBe('u/historian in r/AskHistorians');
        expect(book.id).toBe('reddit_1abc23');
        expect(book.chapters).toHaveLength(3);

        for (const chapter of book.chapters) {
            expect(chapter.loaded).toBe(false);
            expect(chapter.sentences).toBeNull();
            expect(chapter.html).toBeNull();
        }
    });

    it('stores the raw payload as fileData', async () => {
        const raw = payload([comment({ body: 'Hi.' })]);
        const book = await parser.loadFromJson(raw);

        expect(JSON.parse(book.fileData)).toEqual(raw);
    });

    it('renders a chapter on demand', async () => {
        const book = await parser.loadFromJson(payload([
            comment({ author: 'alice', body: 'The empire declined slowly.' })
        ]));

        const sentences = await parser.loadChapter(book, 1);

        expect(book.chapters[1].loaded).toBe(true);
        expect(book.chapters[1].html).toContain('reddit-content');
        expect(sentences.join(' ')).toContain('The empire declined slowly.');
        // The author is spoken, the u/ prefix and score are not.
        expect(sentences.join(' ')).toContain('alice');
        expect(sentences.join(' ')).not.toContain('points');
    });

    it('returns the cached sentences on a second load', async () => {
        const book = await parser.loadFromJson(payload([comment({ body: 'Once.' })]));

        const first = await parser.loadChapter(book, 1);
        const second = await parser.loadChapter(book, 1);

        expect(second).toBe(first);
    });

    it('returns an empty array for an out-of-range chapter', async () => {
        const book = await parser.loadFromJson(payload());

        expect(await parser.loadChapter(book, 99)).toEqual([]);
        expect(await parser.loadChapter(book, -1)).toEqual([]);
    });

    it('re-hydrates from stored data after a fresh start', async () => {
        const book = await parser.loadFromJson(payload([
            comment({ author: 'alice', body: 'Persisted comment.' })
        ]));

        // Simulate a page reload: a brand-new parser, chapters stripped of
        // transient state by storage.stripTransientChapterState().
        const reloaded = new RedditParser();
        const storedBook = {
            ...book,
            chapters: book.chapters.map(({ id, title, href }) => ({
                id, title, href, sentences: null, html: null, loaded: false
            }))
        };

        await reloaded.initFromStoredData(storedBook.fileData);
        const sentences = await reloaded.loadChapter(storedBook, 1);

        expect(sentences.join(' ')).toContain('Persisted comment.');
    });

    it('lazily re-hydrates when loadChapter runs before initFromStoredData', async () => {
        const book = await parser.loadFromJson(payload([comment({ body: 'Lazy load.' })]));
        const fresh = new RedditParser();

        const sentences = await fresh.loadChapter(book, 1);

        expect(sentences.join(' ')).toContain('Lazy load.');
    });

    it('loads a hand-saved JSON file', async () => {
        const raw = JSON.stringify(payload([comment({ body: 'From a file.' })]));
        const file = new File([raw], 'thread.json', { type: 'application/json' });

        const book = await parser.loadFromFile(file);

        expect(book.fileType).toBe('reddit');
        expect(book.chapters).toHaveLength(2);
    });

    it('rejects a file that is not JSON', async () => {
        const file = new File(['not json'], 'thread.json', { type: 'application/json' });

        await expect(parser.loadFromFile(file)).rejects.toThrow(/not valid Reddit thread JSON/i);
    });

    it('clears its thread on destroy', async () => {
        await parser.loadFromJson(payload());
        parser.destroy();
        expect(parser._thread).toBeNull();
    });
});

describe('parser factory registration', () => {
    it('returns a RedditParser for the reddit format', () => {
        expect(getParser('reddit')).toBeInstanceOf(RedditParser);
    });

    it('memoizes the instance', () => {
        expect(getParser('reddit')).toBe(getParser('reddit'));
    });

    it('has a human-readable label', () => {
        expect(FORMAT_LABELS.reddit).toBe('Reddit');
    });
});
