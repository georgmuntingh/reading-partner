import { describe, it, expect } from 'vitest';
import { convertThread, renderBody, formatAge, MAX_VISUAL_DEPTH } from '../js/services/converters/reddit-converter.js';

/**
 * Build a comment node, nesting `replies` recursively.
 */
function comment(data, replies = []) {
    return {
        kind: 't1',
        data: {
            author: 'someone',
            body: 'A comment body.',
            score: 10,
            created_utc: 1700000000,
            ...data,
            replies: replies.length
                ? { kind: 'Listing', data: { children: replies } }
                : ''
        }
    };
}

/**
 * Build a full thread payload.
 */
function payload(post = {}, children = []) {
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
                        selftext: 'I have wondered about this for years. What is the consensus?',
                        score: 4200,
                        created_utc: 1700000000,
                        permalink: '/r/AskHistorians/comments/1abc23/why_did_rome_fall/',
                        is_self: true,
                        ...post
                    }
                }]
            }
        },
        { kind: 'Listing', data: { children } }
    ];
}

describe('convertThread', () => {
    it('extracts thread metadata', () => {
        const thread = convertThread(payload());

        expect(thread.title).toBe('Why did Rome fall?');
        expect(thread.author).toBe('historian');
        expect(thread.subreddit).toBe('AskHistorians');
        expect(thread.url).toBe('https://www.reddit.com/r/AskHistorians/comments/1abc23/why_did_rome_fall/');
    });

    it('throws on a payload with no post', () => {
        expect(() => convertThread([{ kind: 'Listing', data: { children: [] } }, {}]))
            .toThrow(/no post/i);
    });

    it('makes the post chapter 0 with its selftext', () => {
        const thread = convertThread(payload());

        expect(thread.chapters[0].title).toBe('Why did Rome fall?');
        expect(thread.chapters[0].html).toContain('<h1>Why did Rome fall?</h1>');
        expect(thread.chapters[0].html).toContain('I have wondered about this');
    });

    it('creates one chapter per top-level comment', () => {
        const thread = convertThread(payload({}, [
            comment({ author: 'alice', body: 'First take.' }),
            comment({ author: 'bob', body: 'Second take.' }),
            comment({ author: 'carol', body: 'Third take.' })
        ]));

        expect(thread.chapters).toHaveLength(4); // post + 3
        expect(thread.commentCount).toBe(3);
    });

    it('titles comment chapters with author and a snippet', () => {
        const thread = convertThread(payload({}, [
            comment({ author: 'alice', body: 'The short answer is that it did not fall all at once.' })
        ]));

        // Truncated at a word boundary, never mid-word.
        expect(thread.chapters[1].title).toBe('u/alice — The short answer is that it did not fall all at…');
    });

    it('leaves a short comment title untruncated', () => {
        const thread = convertThread(payload({}, [
            comment({ author: 'alice', body: 'Short answer: yes.' })
        ]));

        expect(thread.chapters[1].title).toBe('u/alice — Short answer: yes.');
    });

    it('falls back to the author alone when a comment has no text', () => {
        const thread = convertThread(payload({}, [comment({ author: 'alice', body: '' })]));

        expect(thread.chapters[1].title).toBe('u/alice');
    });

    it('nests replies inside their top-level comment chapter', () => {
        const thread = convertThread(payload({}, [
            comment({ author: 'alice', body: 'Parent.' }, [
                comment({ author: 'bob', body: 'Child.' }, [
                    comment({ author: 'carol', body: 'Grandchild.' })
                ])
            ])
        ]));

        expect(thread.chapters).toHaveLength(2);
        expect(thread.commentCount).toBe(3);

        const html = thread.chapters[1].html;
        expect(html).toContain('Parent.');
        expect(html).toContain('Child.');
        expect(html).toContain('Grandchild.');
        expect(html).toContain('reddit-depth-0');
        expect(html).toContain('reddit-depth-1');
        expect(html).toContain('reddit-depth-2');
    });

    it(`caps the visual depth class at ${MAX_VISUAL_DEPTH}`, () => {
        // Build an 8-deep chain
        let node = comment({ body: 'Deepest.' });
        for (let i = 0; i < 7; i++) {
            node = comment({ body: `Level ${6 - i}.` }, [node]);
        }

        const thread = convertThread(payload({}, [node]));
        const html = thread.chapters[1].html;

        expect(html).toContain(`reddit-depth-${MAX_VISUAL_DEPTH}`);
        expect(html).not.toContain(`reddit-depth-${MAX_VISUAL_DEPTH + 1}`);
        expect(thread.commentCount).toBe(8);
    });

    describe('bylines', () => {
        it('speaks the author but not the u/ prefix or the metadata', () => {
            const thread = convertThread(payload({}, [
                comment({ author: 'alice', body: 'Hello.', score: 412 })
            ]));
            const html = thread.chapters[1].html;

            expect(html).toContain('<span class="tts-skip">u/</span>alice');
            expect(html).toMatch(/<span class="tts-skip"> · 412 points · .*<\/span>/);
        });

        it('abbreviates large scores', () => {
            const thread = convertThread(payload({}, [comment({ score: 4200 })]));
            expect(thread.chapters[1].html).toContain('4.2k points');
        });

        it('marks moderator and pinned comments', () => {
            const thread = convertThread(payload({}, [
                comment({ stickied: true, distinguished: 'moderator' })
            ]));
            expect(thread.chapters[1].html).toContain('pinned');
            expect(thread.chapters[1].html).toContain('mod');
        });
    });

    describe('deleted content', () => {
        it('drops a deleted top-level comment entirely', () => {
            const thread = convertThread(payload({}, [
                comment({ author: 'alice', body: 'Real.' }),
                comment({ author: '[deleted]', body: '[deleted]' })
            ]));

            expect(thread.chapters).toHaveLength(2);
            expect(thread.commentCount).toBe(1);
        });

        it('keeps surviving replies under a deleted parent', () => {
            const thread = convertThread(payload({}, [
                comment({ author: 'alice', body: 'Parent.' }, [
                    comment({ author: '[deleted]', body: '[removed]' }, [
                        comment({ author: 'carol', body: 'Still here.' })
                    ])
                ])
            ]));

            const html = thread.chapters[1].html;
            expect(html).toContain('Still here.');
            expect(html).not.toContain('[removed]');
            expect(thread.commentCount).toBe(2);
        });
    });

    describe('more-comments stubs', () => {
        it('renders a silent marker for unloaded replies', () => {
            const thread = convertThread(payload({}, [
                comment({ body: 'Parent.' }, [
                    { kind: 'more', data: { count: 12, children: [] } }
                ])
            ]));

            expect(thread.chapters[1].html)
                .toContain('<p class="reddit-more tts-skip">[12 more replies not loaded]</p>');
        });

        it('uses the singular for one remaining reply', () => {
            const thread = convertThread(payload({}, [
                comment({ body: 'Parent.' }, [{ kind: 'more', data: { count: 1 } }])
            ]));

            expect(thread.chapters[1].html).toContain('[1 more reply not loaded]');
        });

        it('skips a top-level more stub instead of making it a chapter', () => {
            const thread = convertThread(payload({}, [
                comment({ body: 'Real.' }),
                { kind: 'more', data: { count: 300 } }
            ]));

            expect(thread.chapters).toHaveLength(2);
        });
    });

    describe('media', () => {
        it('embeds an image post', () => {
            const thread = convertThread(payload({
                is_self: false,
                post_hint: 'image',
                url: 'https://i.redd.it/abc.jpg',
                selftext: ''
            }));

            expect(thread.chapters[0].html).toContain('<img src="https://i.redd.it/abc.jpg"');
        });

        it('embeds every image in a gallery', () => {
            const thread = convertThread(payload({
                is_self: false,
                is_gallery: true,
                media_metadata: {
                    a: { s: { u: 'https://i.redd.it/one.jpg' } },
                    b: { s: { u: 'https://i.redd.it/two.jpg' } }
                }
            }));

            expect(thread.chapters[0].html).toContain('one.jpg');
            expect(thread.chapters[0].html).toContain('two.jpg');
        });

        it('renders an external link as a silent marker', () => {
            const thread = convertThread(payload({
                is_self: false,
                url: 'https://www.bbc.co.uk/news/story',
                selftext: ''
            }));

            const html = thread.chapters[0].html;
            expect(html).toContain('tts-skip');
            expect(html).toContain('[Link: bbc.co.uk]');
        });

        it('renders a video post as a silent marker', () => {
            const thread = convertThread(payload({
                is_self: false,
                is_video: true,
                url: 'https://v.redd.it/xyz',
                selftext: ''
            }));

            expect(thread.chapters[0].html).toContain('[Video]');
        });

        it('adds no media block to a text post', () => {
            const thread = convertThread(payload());
            expect(thread.chapters[0].html).not.toContain('reddit-media');
        });
    });

    it('escapes HTML in titles and author names', () => {
        const thread = convertThread(payload({ title: 'Tags <script>alert(1)</script>' }));
        expect(thread.chapters[0].html).not.toContain('<script>');
        expect(thread.chapters[0].html).toContain('&lt;script&gt;');
    });
});

describe('renderBody', () => {
    it('returns nothing for empty input', () => {
        expect(renderBody('')).toBe('');
        expect(renderBody('   ')).toBe('');
    });

    it('renders markdown', () => {
        expect(renderBody('Some **bold** text.')).toContain('<strong>bold</strong>');
    });

    it('turns Reddit-escaped quotes into blockquotes', () => {
        expect(renderBody('&gt; quoted line')).toContain('<blockquote>');
    });

    it('collapses a link to its anchor text', () => {
        expect(renderBody('See [the paper](https://example.com/paper) for details.'))
            .toContain('See the paper for details.');
    });

    it('replaces a bare-URL link with the word "link"', () => {
        const html = renderBody('Source: [https://example.com/a](https://example.com/a)');
        expect(html).toContain('Source: link');
        expect(html).not.toContain('example.com');
    });

    it('replaces a loose bare URL with the word "link"', () => {
        const html = renderBody('Source: https://example.com/a and more.');
        expect(html).toContain('Source: link');
    });

    it('keeps u/ and r/ visible but unspoken', () => {
        const html = renderBody('Ask u/spez about r/books.');
        expect(html).toContain('<span class="tts-skip">u/</span>spez');
        expect(html).toContain('<span class="tts-skip">r/</span>books');
    });

    it('leaves code blocks intact for the sentence wrapper to skip', () => {
        const html = renderBody('Run this:\n\n    npm run build\n');
        expect(html).toContain('<code>');
        expect(html).toContain('npm run build');
    });
});

describe('formatAge', () => {
    const now = 1_700_000_000_000; // ms

    it('formats recent times', () => {
        expect(formatAge(now / 1000 - 10, now)).toBe('just now');
        expect(formatAge(now / 1000 - 300, now)).toBe('5m');
        expect(formatAge(now / 1000 - 7200, now)).toBe('2h');
        expect(formatAge(now / 1000 - 86400 * 3, now)).toBe('3d');
        expect(formatAge(now / 1000 - 86400 * 800, now)).toBe('2y');
    });

    it('never goes negative for clock skew', () => {
        expect(formatAge(now / 1000 + 500, now)).toBe('just now');
    });
});
