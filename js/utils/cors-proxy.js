/**
 * CORS Proxy Helper
 *
 * The app is a static site with no backend, so any cross-origin fetch to a host
 * that does not send CORS headers has to go through a public proxy. This module
 * is the single place where that proxy list lives.
 *
 * Every attempt is recorded (status, content-type, a short body preview) and
 * carried on the thrown ProxyFetchError, because "it failed" is useless when
 * four tiers can each fail for a different reason.
 */

/** How much of a failing response body to keep for diagnostics. */
const BODY_PREVIEW_LENGTH = 200;

/**
 * Public CORS proxies, tried in order.
 *
 * `unwrap` handles proxies that wrap the upstream body in an envelope rather
 * than returning it raw.
 *
 * @type {Array<{name: string, build: (url: string) => string, unwrap?: (text: string) => string}>}
 */
export const CORS_PROXIES = [
    {
        name: 'corsproxy.io',
        build: (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`
    },
    {
        name: 'allorigins/raw',
        build: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`
    },
    {
        // Returns {contents: "…"}. This is the endpoint the Gutenberg search
        // already uses successfully, so it is worth trying separately from /raw.
        name: 'allorigins/get',
        build: (u) => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`,
        unwrap: (text) => {
            const envelope = JSON.parse(text);
            if (typeof envelope?.contents !== 'string') {
                throw new Error('allorigins/get envelope had no contents');
            }
            return envelope.contents;
        }
    },
    {
        name: 'codetabs',
        build: (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`
    }
];

/**
 * @typedef {Object} FetchAttempt
 * @property {string} tier - human-readable label ('direct', 'corsproxy.io', …)
 * @property {string} url - the URL actually requested
 * @property {boolean} ok
 * @property {number|null} status
 * @property {string|null} contentType
 * @property {string|null} bodyPreview - first ~200 chars, when a body was read
 * @property {string|null} error - failure message, when the attempt failed
 */

/**
 * Error carrying the full attempt log, so callers can show the user which tiers
 * were tried and how each one failed.
 */
export class ProxyFetchError extends Error {
    /**
     * @param {string} message
     * @param {FetchAttempt[]} attempts
     * @param {string} targetUrl
     */
    constructor(message, attempts, targetUrl) {
        super(message);
        this.name = 'ProxyFetchError';
        this.attempts = attempts;
        this.targetUrl = targetUrl;
    }

    /**
     * One line per tier, for logs and for the error panel.
     * @returns {string}
     */
    describeAttempts() {
        return this.attempts
            .map((a) => {
                const status = a.status ? `HTTP ${a.status}` : 'no response';
                const type = a.contentType ? ` ${a.contentType.split(';')[0]}` : '';
                const detail = a.error ? ` — ${a.error}` : '';
                return `${a.tier}: ${status}${type}${detail}`;
            })
            .join('\n');
    }
}

/**
 * @typedef {Object} ProxyFetchResult
 * @property {Response} response
 * @property {string} url - The URL that actually succeeded (proxied or direct)
 * @property {boolean} direct - Whether the direct (unproxied) attempt worked
 * @property {string} tier - Which tier succeeded
 * @property {FetchAttempt[]} attempts - Every attempt, including the winner
 */

/**
 * Fetch a URL, falling back through the CORS proxies when the request fails.
 *
 * @param {string} url - The target URL
 * @param {Object} [options]
 * @param {boolean} [options.direct=false] - Try the bare URL before any proxy
 * @param {RequestInit} [options.init] - Passed through to fetch()
 * @param {(response: Response) => (void|Promise<void>)} [options.validate] -
 *        Optional extra check; throw from it to reject an otherwise-OK response
 *        and move on to the next tier.
 * @param {(text: string, tier: string) => (void|Promise<void>)} [options.validateText] -
 *        Like `validate`, but receives the body as text with any proxy envelope
 *        already unwrapped. Use this when the payload shape matters.
 * @returns {Promise<ProxyFetchResult>}
 * @throws {ProxyFetchError}
 */
export async function fetchWithProxyFallback(url, { direct = false, init, validate, validateText } = {}) {
    const tiers = [];
    if (direct) {
        tiers.push({ tier: 'direct', url, direct: true, unwrap: null });
    }
    for (const proxy of CORS_PROXIES) {
        tiers.push({ tier: proxy.name, url: proxy.build(url), direct: false, unwrap: proxy.unwrap });
    }

    /** @type {FetchAttempt[]} */
    const attempts = [];

    for (const candidate of tiers) {
        /** @type {FetchAttempt} */
        const attempt = {
            tier: candidate.tier,
            url: candidate.url,
            ok: false,
            status: null,
            contentType: null,
            bodyPreview: null,
            error: null
        };
        attempts.push(attempt);

        try {
            const response = await fetch(candidate.url, init);
            attempt.status = response.status;
            attempt.contentType = response.headers?.get?.('content-type') || null;

            if (!response.ok) {
                attempt.bodyPreview = await previewBody(response);
                throw new Error(`HTTP ${response.status}${response.statusText ? `: ${response.statusText}` : ''}`);
            }

            if (validateText) {
                const raw = await response.text();
                const text = candidate.unwrap ? candidate.unwrap(raw) : raw;
                attempt.bodyPreview = text.slice(0, BODY_PREVIEW_LENGTH);
                await validateText(text, candidate.tier);
            } else if (validate) {
                await validate(response);
            }

            attempt.ok = true;
            console.log(`Fetched ${url} via ${candidate.tier}`);
            return {
                response,
                url: candidate.url,
                direct: candidate.direct,
                tier: candidate.tier,
                attempts
            };
        } catch (error) {
            attempt.error = error.message;
            console.log(`Fetch failed via ${candidate.tier} for ${url}: ${error.message}`);
        }
    }

    const failure = new ProxyFetchError(
        `Could not fetch ${url} — all ${attempts.length} attempts failed`,
        attempts,
        url
    );
    console.warn(`${failure.message}\n${failure.describeAttempts()}`);
    throw failure;
}

/**
 * Read a short preview of a response body, never throwing.
 * @param {Response} response
 * @returns {Promise<string|null>}
 */
async function previewBody(response) {
    try {
        const text = await response.text();
        return text.slice(0, BODY_PREVIEW_LENGTH);
    } catch {
        return null;
    }
}
