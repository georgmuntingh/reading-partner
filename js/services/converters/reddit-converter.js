/**
 * Reddit Converter
 *
 * Turns a raw Reddit thread JSON payload into chapter-sized HTML fragments.
 *
 * Two rules shape the output:
 *
 *  1. Chapter mapping — chapter 0 is the post, then one chapter per top-level
 *     comment and its entire reply subtree.
 *  2. TTS friendliness — anything that reads badly aloud (scores, timestamps,
 *     the `u/` and `r/` prefixes, bare URLs, media markers) is wrapped in
 *     `<span class="tts-skip">`, which `sentence-wrapper.js` keeps out of the
 *     sentence stream while still rendering it. Code blocks need no handling;
 *     the wrapper already skips CODE/PRE.
 */

import { marked } from 'marked';

/** Replies deeper than this are rendered at the same indentation. */
export const MAX_VISUAL_DEPTH = 5;

/** How much of a comment body to use as its chapter title. */
const TITLE_SNIPPET_LENGTH = 50;

const DELETED_BODIES = new Set(['[deleted]', '[removed]']);

const IMAGE_EXTENSIONS = /\.(jpe?g|png|gif|webp|bmp|avif)(\?|$)/i;

/**
 * @typedef {Object} RedditChapter
 * @property {string} title
 * @property {string} html
 */

/**
 * @typedef {Object} RedditThread
 * @property {string} title
 * @property {string} author
 * @property {string|null} subreddit
 * @property {string} url
 * @property {number} commentCount
 * @property {RedditChapter[]} chapters
 */

/**
 * Convert a raw thread payload into a thread model with rendered chapters.
 *
 * @param {Array} payload - `[postListing, commentListing]` from reddit-client
 * @returns {RedditThread}
 */
export function convertThread(payload) {
    const post = payload?.[0]?.data?.children?.[0]?.data;
    if (!post) {
        throw new Error('Thread payload contains no post');
    }

    const commentNodes = payload?.[1]?.data?.children || [];

    const chapters = [renderPostChapter(post)];
    let commentCount = 0;

    for (const node of commentNodes) {
        const chapter = renderCommentChapter(node);
        if (chapter) {
            chapters.push(chapter);
            commentCount += chapter.commentCount;
        }
    }

    return {
        title: post.title || 'Reddit thread',
        author: post.author || 'unknown',
        subreddit: post.subreddit || null,
        url: post.permalink ? `https://www.reddit.com${post.permalink}` : '',
        commentCount,
        chapters: chapters.map(({ title, html }) => ({ title, html }))
    };
}

/**
 * Render the post itself as the opening chapter.
 * @param {Object} post
 * @returns {{ title: string, html: string, commentCount: number }}
 */
function renderPostChapter(post) {
    const parts = [`<h1>${escapeHtml(post.title || 'Reddit thread')}</h1>`];

    parts.push(byline(post, { subreddit: post.subreddit }));

    if (post.selftext) {
        parts.push(renderBody(post.selftext));
    }

    parts.push(renderPostMedia(post));

    return {
        title: post.title || 'Post',
        html: `<div class="reddit-post">${parts.filter(Boolean).join('\n')}</div>`,
        commentCount: 0
    };
}

/**
 * Render one top-level comment and its whole subtree as a chapter.
 * @param {Object} node - a `{ kind, data }` listing child
 * @returns {{ title: string, html: string, commentCount: number }|null}
 */
function renderCommentChapter(node) {
    if (node?.kind === 'more') {
        // A top-level "more comments" stub has no readable content of its own.
        return null;
    }
    const comment = node?.data;
    if (!comment || isDeleted(comment)) {
        return null;
    }

    const counter = { count: 0 };
    const html = renderComment(comment, 0, counter);
    if (!html) {
        return null;
    }

    return {
        title: chapterTitle(comment),
        html: `<div class="reddit-thread">${html}</div>`,
        commentCount: counter.count
    };
}

/**
 * Render a comment and, recursively, its replies.
 * @param {Object} comment
 * @param {number} depth
 * @param {{count: number}} counter
 * @returns {string}
 */
function renderComment(comment, depth, counter) {
    if (isDeleted(comment)) {
        // Drop deleted bodies, but keep any surviving replies at this depth so
        // the conversation does not lose its tail.
        return renderReplies(comment, depth, counter);
    }

    counter.count += 1;

    const depthClass = `reddit-depth-${Math.min(depth, MAX_VISUAL_DEPTH)}`;
    const parts = [
        byline(comment),
        renderBody(comment.body || '')
    ];

    const own = `<div class="reddit-comment ${depthClass}">${parts.filter(Boolean).join('\n')}</div>`;
    return own + renderReplies(comment, depth + 1, counter);
}

/**
 * Render a comment's replies (including "more comments" markers).
 * @param {Object} comment
 * @param {number} depth
 * @param {{count: number}} counter
 * @returns {string}
 */
function renderReplies(comment, depth, counter) {
    const children = comment?.replies?.data?.children;
    if (!Array.isArray(children)) {
        return '';
    }

    const out = [];
    for (const child of children) {
        if (child?.kind === 'more') {
            const remaining = child.data?.count || 0;
            if (remaining > 0) {
                out.push(
                    `<p class="reddit-more tts-skip">[${remaining} more ${remaining === 1 ? 'reply' : 'replies'} not loaded]</p>`
                );
            }
            continue;
        }
        if (child?.data) {
            out.push(renderComment(child.data, depth, counter));
        }
    }
    return out.join('');
}

/**
 * The attribution line. The author name is spoken; everything around it
 * (the `u/` prefix, score, age, flags) is marked tts-skip.
 *
 * @param {Object} item - post or comment
 * @param {Object} [extra]
 * @returns {string}
 */
function byline(item, { subreddit } = {}) {
    const author = item.author && item.author !== '[deleted]' ? item.author : 'deleted user';

    const meta = [];
    if (typeof item.score === 'number') {
        meta.push(`${formatScore(item.score)} ${Math.abs(item.score) === 1 ? 'point' : 'points'}`);
    }
    if (item.created_utc) {
        meta.push(formatAge(item.created_utc));
    }
    if (subreddit) {
        meta.unshift(`r/${subreddit}`);
    }
    if (item.stickied) {
        meta.push('pinned');
    }
    if (item.distinguished === 'moderator') {
        meta.push('mod');
    }

    const metaHtml = meta.length
        ? `<span class="tts-skip"> · ${escapeHtml(meta.join(' · '))}</span>`
        : '';

    return `<p class="reddit-byline"><span class="tts-skip">u/</span>${escapeHtml(author)}${metaHtml}</p>`;
}

/**
 * Render a markdown body to TTS-friendly HTML.
 * @param {string} markdown
 * @returns {string}
 */
export function renderBody(markdown) {
    if (!markdown || !markdown.trim()) {
        return '';
    }

    const html = marked.parse(unescapeRedditMarkdown(markdown), { gfm: true, breaks: false });
    return cleanBodyHtml(html);
}

/**
 * Post-process rendered markdown so it reads well aloud:
 *  - links collapse to their anchor text; bare-URL links become "link"
 *  - `u/name` and `r/sub` keep their visible prefix but do not speak it
 *
 * Runs as string transforms so the converter stays usable without a DOM.
 *
 * @param {string} html
 * @returns {string}
 */
function cleanBodyHtml(html) {
    let out = html;

    // <a href="…">text</a> → text (or "link" when the text is just the URL)
    out = out.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, (match, text) => {
        const plain = text.replace(/<[^>]+>/g, '').trim();
        if (!plain) return '';
        return isBareUrl(plain) ? 'link' : text;
    });

    // Bare URLs left in the text (marked leaves them alone without gfm autolink)
    out = out.replace(/(^|[\s(])https?:\/\/\S+/gi, '$1link');

    // u/name and r/sub — keep the prefix visible, keep it out of the audio.
    out = out.replace(
        /(^|[\s(>])(\/?)([ur])\/([A-Za-z0-9_-]+)/g,
        (match, lead, slash, kind, name) =>
            `${lead}<span class="tts-skip">${slash}${kind}/</span>${name}`
    );

    return out;
}

/**
 * Render post media: images inline, everything else as a silent marker.
 * @param {Object} post
 * @returns {string}
 */
function renderPostMedia(post) {
    const parts = [];

    // Gallery posts
    if (post.is_gallery && post.media_metadata) {
        for (const meta of Object.values(post.media_metadata)) {
            const src = meta?.s?.u || meta?.s?.gif;
            if (src) {
                parts.push(image(src));
            }
        }
        if (parts.length) {
            return `<div class="reddit-media">${parts.join('\n')}</div>`;
        }
    }

    const url = post.url_overridden_by_dest || post.url;
    if (!url || post.is_self) {
        return '';
    }

    if (post.post_hint === 'image' || IMAGE_EXTENSIONS.test(url)) {
        parts.push(image(url));
    } else if (post.is_video || post.post_hint === 'hosted:video' || post.post_hint === 'rich:video') {
        parts.push(`<p class="reddit-media-note tts-skip">[Video] <a href="${escapeHtml(url)}" rel="noopener">${escapeHtml(url)}</a></p>`);
    } else {
        parts.push(
            `<p class="reddit-media-note tts-skip">[Link: ${escapeHtml(hostOf(url))}] ` +
            `<a href="${escapeHtml(url)}" rel="noopener">${escapeHtml(url)}</a></p>`
        );
    }

    return parts.length ? `<div class="reddit-media">${parts.join('\n')}</div>` : '';
}

/**
 * @param {string} src
 * @returns {string}
 */
function image(src) {
    return `<img src="${escapeHtml(src)}" alt="" loading="lazy">`;
}

/**
 * `u/author — first words of the comment`, for the navigation panel.
 * @param {Object} comment
 * @returns {string}
 */
function chapterTitle(comment) {
    const author = comment.author && comment.author !== '[deleted]' ? comment.author : 'deleted';
    const body = (comment.body || '')
        .replace(/\s+/g, ' ')
        .replace(/[#*_>`~]/g, '')
        .trim();

    if (!body) {
        return `u/${author}`;
    }

    let snippet = body;
    if (body.length > TITLE_SNIPPET_LENGTH) {
        const cut = body.slice(0, TITLE_SNIPPET_LENGTH);
        // Back off to the last word boundary so titles don't end mid-word.
        const lastSpace = cut.lastIndexOf(' ');
        snippet = `${(lastSpace > TITLE_SNIPPET_LENGTH / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
    }

    return `u/${author} — ${snippet}`;
}

/**
 * @param {Object} item
 * @returns {boolean}
 */
function isDeleted(item) {
    const body = (item?.body || '').trim();
    return DELETED_BODIES.has(body) || item?.removed_by_category != null;
}

/**
 * Reddit escapes `&lt;` `&gt;` `&amp;` inside markdown bodies even with
 * raw_json=1 in some fields; normalise before handing to marked.
 * @param {string} text
 * @returns {string}
 */
function unescapeRedditMarkdown(text) {
    return text
        .replace(/&gt;/g, '>')
        .replace(/&lt;/g, '<')
        .replace(/&amp;/g, '&');
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function isBareUrl(text) {
    return /^https?:\/\/\S+$/i.test(text) || /^www\.\S+$/i.test(text);
}

/**
 * @param {number} score
 * @returns {string}
 */
function formatScore(score) {
    if (Math.abs(score) >= 1000) {
        return `${(score / 1000).toFixed(1).replace(/\.0$/, '')}k`;
    }
    return String(score);
}

/**
 * Relative age, e.g. "3h", "2d".
 * @param {number} createdUtc - seconds since epoch
 * @param {number} [now] - milliseconds since epoch, for testing
 * @returns {string}
 */
export function formatAge(createdUtc, now = Date.now()) {
    const seconds = Math.max(0, Math.floor(now / 1000 - createdUtc));
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 365) return `${days}d`;
    return `${Math.floor(days / 365)}y`;
}

/**
 * @param {string} url
 * @returns {string}
 */
function hostOf(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return 'link';
    }
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
