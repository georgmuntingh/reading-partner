/**
 * CORS Proxy Helper
 *
 * The app is a static site with no backend, so any cross-origin fetch to a host
 * that does not send CORS headers has to go through a public proxy. This module
 * is the single place where that proxy list lives.
 */

/**
 * Public CORS proxies, tried in order.
 * @type {Array<(url: string) => string>}
 */
export const CORS_PROXIES = [
    (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
    (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`
];

/**
 * @typedef {Object} ProxyFetchResult
 * @property {Response} response
 * @property {string} url - The URL that actually succeeded (proxied or direct)
 * @property {boolean} direct - Whether the direct (unproxied) attempt was the one that worked
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
 * @returns {Promise<ProxyFetchResult>}
 */
export async function fetchWithProxyFallback(url, { direct = false, init, validate } = {}) {
    const attempts = [];
    if (direct) {
        attempts.push({ url, direct: true });
    }
    for (const proxyFn of CORS_PROXIES) {
        attempts.push({ url: proxyFn(url), direct: false });
    }

    let lastError = null;

    for (const attempt of attempts) {
        try {
            const response = await fetch(attempt.url, init);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            if (validate) {
                await validate(response);
            }

            console.log(
                `Fetched ${url} via ${attempt.direct ? 'direct request' : attempt.url.split('/?')[0]}`
            );
            return { response, url: attempt.url, direct: attempt.direct };
        } catch (error) {
            lastError = error;
            console.log(
                `Fetch failed (${attempt.direct ? 'direct' : 'proxy'}) for ${url}:`,
                error.message
            );
        }
    }

    throw lastError || new Error(`Could not fetch ${url}`);
}
