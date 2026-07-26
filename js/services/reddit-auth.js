/**
 * Reddit Auth
 *
 * Application-only OAuth for an "installed app" — the Reddit app type meant for
 * clients that cannot keep a secret (mobile apps, browser SPAs). The client id
 * is not a secret; there is no client secret, and no user login is involved.
 *
 *   POST https://www.reddit.com/api/v1/access_token
 *     Authorization: Basic base64("<clientId>:")
 *     grant_type=https://oauth.reddit.com/grants/installed_client
 *     &device_id=DO_NOT_TRACK_THIS_DEVICE
 *   → { access_token, expires_in }   // ~1 hour
 *
 * Whether Reddit sends CORS headers for this from a static-site origin is not
 * something we can verify up front — the caller treats this as one tier of a
 * ladder and falls through when it fails.
 */

import { storage } from './storage.js';

const TOKEN_ENDPOINT = 'https://www.reddit.com/api/v1/access_token';
const GRANT_TYPE = 'https://oauth.reddit.com/grants/installed_client';

/** Reddit's documented value for clients that do not track devices. */
const DEVICE_ID = 'DO_NOT_TRACK_THIS_DEVICE';

/** Refresh this many seconds before the token actually expires. */
const EXPIRY_MARGIN_SECONDS = 60;

const TOKEN_SETTING_KEY = 'redditToken';

/** In-memory cache, so repeated fetches in one session skip storage. */
let cachedToken = null;

/**
 * @typedef {Object} RedditToken
 * @property {string} accessToken
 * @property {number} expiresAt - epoch milliseconds
 * @property {string} clientId - which client id minted it
 */

/**
 * Get a valid app-only access token, minting a new one when needed.
 *
 * @param {string} clientId
 * @returns {Promise<string>} the bearer token
 */
export async function getAccessToken(clientId) {
    if (!clientId) {
        throw new Error('No Reddit client ID configured');
    }

    const existing = cachedToken || (await readStoredToken());
    if (isUsable(existing, clientId)) {
        cachedToken = existing;
        return existing.accessToken;
    }

    const token = await requestToken(clientId);
    cachedToken = token;
    await storage.saveSetting(TOKEN_SETTING_KEY, token).catch((error) => {
        console.warn('Could not persist Reddit token:', error.message);
    });

    return token.accessToken;
}

/**
 * Drop the cached token — used when a request comes back 401.
 * @returns {Promise<void>}
 */
export async function clearAccessToken() {
    cachedToken = null;
    await storage.saveSetting(TOKEN_SETTING_KEY, null).catch(() => {});
}

/**
 * Mint a fresh token.
 * @param {string} clientId
 * @returns {Promise<RedditToken>}
 */
async function requestToken(clientId) {
    const body = new URLSearchParams({
        grant_type: GRANT_TYPE,
        device_id: DEVICE_ID
    });

    const response = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
            // Basic auth with an empty password — an installed app has no secret.
            Authorization: `Basic ${base64(`${clientId}:`)}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: body.toString()
    });

    if (!response.ok) {
        throw new Error(
            response.status === 401
                ? 'Reddit rejected the client ID (check it is an "installed app")'
                : `Reddit token request failed: HTTP ${response.status}`
        );
    }

    const data = await response.json();
    if (!data?.access_token) {
        throw new Error('Reddit token response had no access_token');
    }

    return {
        accessToken: data.access_token,
        expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
        clientId
    };
}

/**
 * @param {RedditToken|null} token
 * @param {string} clientId
 * @returns {boolean}
 */
function isUsable(token, clientId) {
    return Boolean(
        token?.accessToken &&
        token.clientId === clientId &&
        token.expiresAt > Date.now() + EXPIRY_MARGIN_SECONDS * 1000
    );
}

/**
 * @returns {Promise<RedditToken|null>}
 */
async function readStoredToken() {
    try {
        return (await storage.getSetting(TOKEN_SETTING_KEY)) || null;
    } catch {
        return null;
    }
}

/**
 * btoa over a UTF-8 string.
 * @param {string} text
 * @returns {string}
 */
function base64(text) {
    if (typeof btoa === 'function') {
        return btoa(text);
    }
    // Non-browser (test) environments
    return Buffer.from(text, 'utf-8').toString('base64');
}
