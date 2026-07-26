/**
 * Reddit Client
 *
 * Resolves Reddit thread URLs and fetches the thread as JSON.
 *
 * There is no single reliable way to reach Reddit from a static site, so the
 * fetch is a ladder and every rung records why it failed:
 *
 *   0. Capacitor native HTTP — Android only; no CORS, device's own IP
 *   1. oauth.reddit.com     — official API, only when a client ID is configured
 *   2. direct .json         — works if Reddit still sends CORS headers
 *   3. public CORS proxies  — cloud IPs, which Reddit may block
 *
 * When all of them fail the caller can still fall back to a pasted JSON body,
 * which uses the user's own browser and cannot be blocked.
 */

import { fetchWithProxyFallback, ProxyFetchError } from '../utils/cors-proxy.js';
import { getAccessToken, clearAccessToken } from './reddit-auth.js';

/** Comment sort orders Reddit accepts on a thread. */
export const SORT_OPTIONS = ['top', 'best', 'new', 'controversial', 'old', 'qa'];

export const DEFAULT_SORT = 'top';
export const DEFAULT_LIMIT = 500;
export const DEFAULT_DEPTH = 10;

/** Cheaper retry when a full-size fetch fails everywhere. */
const SMALL_RETRY_LIMIT = 100;
const SMALL_RETRY_DEPTH = 5;

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
 * Build the OAuth endpoint URL for a thread.
 *
 * @param {string} threadId
 * @param {Object} [options]
 * @returns {string}
 */
export function buildOAuthThreadUrl(threadId, { sort = DEFAULT_SORT, limit = DEFAULT_LIMIT, depth = DEFAULT_DEPTH } = {}) {
    const params = new URLSearchParams({
        raw_json: '1',
        limit: String(limit),
        depth: String(depth),
        sort: SORT_OPTIONS.includes(sort) ? sort : DEFAULT_SORT
    });
    return `https://oauth.reddit.com/comments/${threadId}?${params}`;
}

/**
 * Parse a thread response body, rejecting anything that is not a thread.
 *
 * @param {string} text
 * @returns {Array} `[postListing, commentListing]`
 * @throws {Error} with a user-facing message
 */
export function parseThreadJson(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        // Proxies return HTML error pages on failure, and Reddit serves an HTML
        // block page to datacenter IPs — both land here.
        throw new Error('Response was not JSON (an HTML error or block page was returned)');
    }
    if (!isThreadPayload(parsed)) {
        throw new Error(describePayloadError(parsed));
    }
    return parsed;
}

/**
 * Fetch a thread as its raw two-listing JSON payload.
 *
 * Tries, in order: Capacitor native HTTP (Android), Reddit OAuth (when a client
 * ID is configured), the direct `.json` endpoint, then the public CORS proxies.
 * Each tier can fail for a different reason, so every attempt is recorded and
 * carried on the thrown error.
 *
 * @param {string} threadId
 * @param {Object} [options]
 * @param {string} [options.sort]
 * @param {number} [options.limit]
 * @param {number} [options.depth]
 * @param {string} [options.clientId] - Reddit installed-app client ID, if set
 * @returns {Promise<Array>} `[postListing, commentListing]`
 * @throws {ProxyFetchError}
 */
export async function fetchThread(threadId, options = {}) {
    const attempts = [];

    const payload = await attemptAllTiers(threadId, options, attempts);
    if (payload) {
        return payload;
    }

    // A very large thread can blow past proxy size and time limits. One cheaper
    // retry costs little and rescues the common case.
    const limit = options.limit ?? DEFAULT_LIMIT;
    if (limit > SMALL_RETRY_LIMIT) {
        console.log(`All tiers failed at limit=${limit}; retrying smaller`);
        const firstPassCount = attempts.length;
        const retried = await attemptAllTiers(
            threadId,
            { ...options, limit: SMALL_RETRY_LIMIT, depth: SMALL_RETRY_DEPTH },
            attempts
        );
        // Distinguish the second pass, or the diagnostics read as every tier
        // mysteriously failing twice.
        for (let i = firstPassCount; i < attempts.length; i++) {
            attempts[i].tier = `${attempts[i].tier} (retry, limit ${SMALL_RETRY_LIMIT})`;
        }
        if (retried) {
            return retried;
        }
    }

    const failure = new ProxyFetchError(
        'Could not load that thread from Reddit',
        attempts,
        buildThreadUrl(threadId, options)
    );
    console.warn(`${failure.message}\n${failure.describeAttempts()}`);
    throw failure;
}

/**
 * Run every tier once, appending to `attempts`.
 *
 * @param {string} threadId
 * @param {Object} options
 * @param {Array} attempts
 * @returns {Promise<Array|null>} the payload, or null when every tier failed
 */
async function attemptAllTiers(threadId, options, attempts) {
    const url = buildThreadUrl(threadId, options);

    const native = await tryNative(url, attempts);
    if (native) {
        return native;
    }

    if (options.clientId) {
        const viaOAuth = await tryOAuth(threadId, options, attempts);
        if (viaOAuth) {
            return viaOAuth;
        }
    }

    return tryLadder(url, attempts);
}

/**
 * Capacitor native HTTP — no CORS, and the request comes from the device's own
 * IP rather than a cloud proxy. Android only; a no-op on the web build.
 *
 * We call the plugin explicitly instead of enabling Capacitor's global fetch
 * patch, because that patch does not expose `response.body` and would break LLM
 * streaming (openrouter-provider.js) and the transformers.js model downloads.
 *
 * @param {string} url
 * @param {Array} attempts
 * @returns {Promise<Array|null>}
 */
async function tryNative(url, attempts) {
    if (!window.Capacitor?.isNativePlatform?.()) {
        return null;
    }

    const attempt = { tier: 'native (Capacitor)', url, ok: false, status: null, contentType: null, bodyPreview: null, error: null };
    attempts.push(attempt);

    try {
        const { CapacitorHttp } = await import('@capacitor/core');
        const response = await CapacitorHttp.request({ url, method: 'GET' });

        attempt.status = response.status;
        attempt.contentType = response.headers?.['content-type'] || response.headers?.['Content-Type'] || null;

        if (response.status < 200 || response.status >= 300) {
            throw new Error(`HTTP ${response.status}`);
        }

        // CapacitorHttp parses JSON responses for us; older versions return text.
        const payload = typeof response.data === 'string'
            ? parseThreadJson(response.data)
            : validatePayload(response.data);

        attempt.ok = true;
        console.log(`Fetched ${url} via native HTTP`);
        return payload;
    } catch (error) {
        attempt.error = error.message;
        console.log(`Fetch failed via native HTTP: ${error.message}`);
        return null;
    }
}

/**
 * Reddit's official API with an app-only token.
 *
 * @param {string} threadId
 * @param {Object} options
 * @param {Array} attempts
 * @returns {Promise<Array|null>}
 */
async function tryOAuth(threadId, options, attempts) {
    const url = buildOAuthThreadUrl(threadId, options);
    const attempt = { tier: 'oauth.reddit.com', url, ok: false, status: null, contentType: null, bodyPreview: null, error: null };
    attempts.push(attempt);

    try {
        const token = await getAccessToken(options.clientId);
        const response = await fetch(url, {
            headers: { Authorization: `Bearer ${token}` }
        });

        attempt.status = response.status;
        attempt.contentType = response.headers?.get?.('content-type') || null;

        if (response.status === 401) {
            // Stale token — drop it so the next run mints a fresh one.
            await clearAccessToken();
            throw new Error('Token rejected (cleared; try again)');
        }
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const text = await response.text();
        attempt.bodyPreview = text.slice(0, 200);
        const payload = parseThreadJson(text);

        attempt.ok = true;
        console.log(`Fetched ${url} via OAuth`);
        return payload;
    } catch (error) {
        attempt.error = error.message;
        console.log(`Fetch failed via OAuth: ${error.message}`);
        return null;
    }
}

/**
 * Direct request, then the public CORS proxies.
 *
 * @param {string} url
 * @param {Array} attempts
 * @returns {Promise<Array|null>}
 */
async function tryLadder(url, attempts) {
    let payload = null;
    try {
        const result = await fetchWithProxyFallback(url, {
            direct: true,
            validateText: (text) => {
                payload = parseThreadJson(text);
            }
        });
        attempts.push(...result.attempts);
        return payload;
    } catch (error) {
        if (error.attempts) {
            attempts.push(...error.attempts);
        } else {
            attempts.push({
                tier: 'proxy ladder', url, ok: false, status: null,
                contentType: null, bodyPreview: null, error: error.message
            });
        }
        return null;
    }
}

/**
 * Validate an already-parsed payload (the native tier hands us objects).
 * @param {*} parsed
 * @returns {Array}
 */
function validatePayload(parsed) {
    if (!isThreadPayload(parsed)) {
        throw new Error(describePayloadError(parsed));
    }
    return parsed;
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
