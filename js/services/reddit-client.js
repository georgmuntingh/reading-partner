/**
 * Reddit Client
 *
 * Resolves Reddit thread URLs and fetches the thread as JSON.
 *
 * Reddit's public `.json` endpoint may or may not send CORS headers to a
 * browser origin (this has changed over the years), so the fetch is a ladder:
 * direct request first, then the shared public CORS proxies. The console log
 * from `fetchWithProxyFallback` says which tier won.
 */

import { fetchWithProxyFallback } from '../utils/cors-proxy.js';

/** Comment sort orders Reddit accepts on a thread. */
export const SORT_OPTIONS = ['top', 'best', 'new', 'controversial', 'old', 'qa'];

export const DEFAULT_SORT = 'top';
export const DEFAULT_LIMIT = 500;
export const DEFAULT_DEPTH = 10;

/** Reddit thread ids are base-36, historically 5-8 characters. */
const THREAD_ID_PATTERN = /^[a-z0-9]{5,8}$/i;

const REDDIT_HOSTS = new Set([
    'reddit.com', 'www.reddit.com', 'old.reddit.com', 'new.reddit.com',
    'np.reddit.com', 'i.reddit.com', 'm.reddit.com', 'amp.reddit.com',
    'redd.it', 'www.redd.it'
]);

/**
 * @typedef {Object} RedditThreadRef
 * @property {string} threadId - base-36 post id, without the `t3_` prefix
 * @property {string|null} subreddit
 */

/**
 * Parse a Reddit thread URL (or a bare thread id) into a thread reference.
 *
 * Accepts:
 *   https://www.reddit.com/r/<sub>/comments/<id>/<slug>/
 *   https://old.reddit.com/r/<sub>/comments/<id>
 *   https://www.reddit.com/comments/<id>
 *   https://redd.it/<id>
 *   <id>
 *
 * @param {string} input
 * @returns {RedditThreadRef}
 * @throws {Error} with a user-facing message when the input is not usable
 */
export function parseRedditUrl(input) {
    const trimmed = (input || '').trim();
    if (!trimmed) {
        throw new Error('Please enter a Reddit thread URL');
    }

    // Bare thread id
    if (!trimmed.includes('/') && !trimmed.includes('.')) {
        if (THREAD_ID_PATTERN.test(trimmed)) {
            return { threadId: trimmed.toLowerCase(), subreddit: null };
        }
        throw new Error(`"${trimmed}" is not a valid Reddit thread id`);
    }

    let url;
    try {
        url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    } catch {
        throw new Error('Please enter a valid Reddit thread URL');
    }

    const host = url.hostname.toLowerCase();
    if (!REDDIT_HOSTS.has(host)) {
        throw new Error(`${url.hostname} is not a Reddit URL`);
    }

    const segments = url.pathname.split('/').filter(Boolean);

    // Short share links (/r/<sub>/s/<code>) resolve via an HTTP redirect that a
    // browser cannot observe cross-origin, so they cannot be expanded here.
    if (segments.includes('s') && !segments.includes('comments')) {
        throw new Error(
            'Reddit share links (/s/…) cannot be expanded from the browser. ' +
            'Open the link and paste the full /comments/ URL instead.'
        );
    }

    // redd.it/<id>
    if (host === 'redd.it' || host === 'www.redd.it') {
        const id = segments[0];
        if (id && THREAD_ID_PATTERN.test(id)) {
            return { threadId: id.toLowerCase(), subreddit: null };
        }
        throw new Error('Could not find a thread id in that redd.it link');
    }

    const commentsIndex = segments.indexOf('comments');
    if (commentsIndex === -1 || !segments[commentsIndex + 1]) {
        throw new Error(
            'That looks like a Reddit link, but not a thread. ' +
            'Use a post URL containing /comments/.'
        );
    }

    const threadId = segments[commentsIndex + 1];
    if (!THREAD_ID_PATTERN.test(threadId)) {
        throw new Error(`"${threadId}" is not a valid Reddit thread id`);
    }

    const subredditIndex = segments.indexOf('r');
    const subreddit = subredditIndex !== -1 ? segments[subredditIndex + 1] || null : null;

    return { threadId: threadId.toLowerCase(), subreddit };
}

/**
 * Build the JSON endpoint URL for a thread.
 *
 * @param {string} threadId
 * @param {Object} [options]
 * @returns {string}
 */
export function buildThreadUrl(threadId, { sort = DEFAULT_SORT, limit = DEFAULT_LIMIT, depth = DEFAULT_DEPTH } = {}) {
    const params = new URLSearchParams({
        raw_json: '1',
        limit: String(limit),
        depth: String(depth),
        sort: SORT_OPTIONS.includes(sort) ? sort : DEFAULT_SORT
    });
    return `https://www.reddit.com/comments/${threadId}.json?${params}`;
}

/**
 * Fetch a thread as its raw two-listing JSON payload.
 *
 * @param {string} threadId
 * @param {Object} [options]
 * @param {string} [options.sort]
 * @param {number} [options.limit]
 * @param {number} [options.depth]
 * @returns {Promise<Array>} `[postListing, commentListing]`
 */
export async function fetchThread(threadId, options = {}) {
    const url = buildThreadUrl(threadId, options);

    let payload = null;
    await fetchWithProxyFallback(url, {
        direct: true,
        validate: async (response) => {
            const text = await response.text();
            let parsed;
            try {
                parsed = JSON.parse(text);
            } catch {
                // Proxies return HTML error pages on failure — reject and fall through.
                throw new Error('Response was not JSON (the proxy may have returned an error page)');
            }
            if (!isThreadPayload(parsed)) {
                throw new Error(describePayloadError(parsed));
            }
            payload = parsed;
        }
    });

    return payload;
}

/**
 * Check that a parsed payload looks like a Reddit thread response.
 * @param {*} payload
 * @returns {boolean}
 */
export function isThreadPayload(payload) {
    return (
        Array.isArray(payload) &&
        payload.length >= 2 &&
        payload[0]?.kind === 'Listing' &&
        payload[1]?.kind === 'Listing' &&
        Array.isArray(payload[0]?.data?.children) &&
        payload[0].data.children.length > 0
    );
}

/**
 * Turn an unexpected payload into a user-facing message.
 * @param {*} payload
 * @returns {string}
 */
function describePayloadError(payload) {
    if (payload?.error) {
        return `Reddit returned an error (${payload.error}${payload.message ? `: ${payload.message}` : ''})`;
    }
    if (payload?.reason === 'private' || payload?.reason === 'quarantined') {
        return `This thread is in a ${payload.reason} subreddit and cannot be read`;
    }
    if (Array.isArray(payload) && payload[0]?.data?.children?.length === 0) {
        return 'That thread could not be found — it may have been deleted';
    }
    return 'Unexpected response from Reddit';
}
