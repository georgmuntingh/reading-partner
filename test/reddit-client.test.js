import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    parseRedditUrl,
    buildThreadUrl,
    fetchThread,
    isThreadPayload,
    parseThreadJson,
    DEFAULT_SORT
} from '../js/services/reddit-client.js';

/** Minimal valid thread payload. */
function threadPayload() {
    return [
        { kind: 'Listing', data: { children: [{ kind: 't3', data: { title: 'Hi', author: 'a' } }] } },
        { kind: 'Listing', data: { children: [] } }
    ];
}

function jsonResponse(body) {
    return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify(body)
    };
}

describe('parseRedditUrl', () => {
    it('parses a full post URL with a slug', () => {
        expect(parseRedditUrl('https://www.reddit.com/r/AskHistorians/comments/1abc23/why_did_rome_fall/'))
            .toEqual({ threadId: '1abc23', subreddit: 'AskHistorians' });
    });

    it('parses old, np and m subdomains', () => {
        for (const host of ['old', 'np', 'm']) {
            expect(parseRedditUrl(`https://${host}.reddit.com/r/books/comments/1abc23`))
                .toEqual({ threadId: '1abc23', subreddit: 'books' });
        }
    });

    it('parses a URL without a subreddit', () => {
        expect(parseRedditUrl('https://www.reddit.com/comments/1abc23'))
            .toEqual({ threadId: '1abc23', subreddit: null });
    });

    it('parses a redd.it short link', () => {
        expect(parseRedditUrl('https://redd.it/1abc23'))
            .toEqual({ threadId: '1abc23', subreddit: null });
    });

    it('parses a bare thread id', () => {
        expect(parseRedditUrl('1abc23')).toEqual({ threadId: '1abc23', subreddit: null });
    });

    it('accepts a URL without a scheme', () => {
        expect(parseRedditUrl('reddit.com/r/books/comments/1abc23').threadId).toBe('1abc23');
    });

    it('lowercases the thread id', () => {
        expect(parseRedditUrl('https://www.reddit.com/comments/1ABC23').threadId).toBe('1abc23');
    });

    it('rejects /s/ share links with actionable guidance', () => {
        expect(() => parseRedditUrl('https://www.reddit.com/r/books/s/aBcDeFgH'))
            .toThrow(/share links/i);
    });

    it('rejects non-Reddit hosts', () => {
        expect(() => parseRedditUrl('https://example.com/r/books/comments/1abc23'))
            .toThrow(/not a Reddit URL/i);
    });

    it('rejects a Reddit URL that is not a thread', () => {
        expect(() => parseRedditUrl('https://www.reddit.com/r/books/'))
            .toThrow(/not a thread/i);
    });

    it('rejects empty input', () => {
        expect(() => parseRedditUrl('   ')).toThrow(/enter a Reddit thread URL/i);
    });
});

describe('buildThreadUrl', () => {
    it('builds a JSON endpoint with defaults', () => {
        const url = new URL(buildThreadUrl('1abc23'));
        expect(url.pathname).toBe('/comments/1abc23.json');
        expect(url.searchParams.get('raw_json')).toBe('1');
        expect(url.searchParams.get('sort')).toBe(DEFAULT_SORT);
        expect(url.searchParams.get('limit')).toBe('500');
        expect(url.searchParams.get('depth')).toBe('10');
    });

    it('honours explicit options', () => {
        const url = new URL(buildThreadUrl('1abc23', { sort: 'new', limit: 100, depth: 3 }));
        expect(url.searchParams.get('sort')).toBe('new');
        expect(url.searchParams.get('limit')).toBe('100');
        expect(url.searchParams.get('depth')).toBe('3');
    });

    it('falls back to the default for an unknown sort', () => {
        const url = new URL(buildThreadUrl('1abc23', { sort: 'nonsense' }));
        expect(url.searchParams.get('sort')).toBe(DEFAULT_SORT);
    });
});

describe('isThreadPayload', () => {
    it('accepts a two-listing payload with a post', () => {
        expect(isThreadPayload(threadPayload())).toBe(true);
    });

    it('rejects other shapes', () => {
        expect(isThreadPayload(null)).toBe(false);
        expect(isThreadPayload({})).toBe(false);
        expect(isThreadPayload([{ kind: 'Listing', data: { children: [] } }])).toBe(false);
    });
});

describe('fetchThread', () => {
    let originalFetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('uses the direct request when it succeeds', async () => {
        const payload = threadPayload();
        globalThis.fetch = vi.fn(async () => jsonResponse(payload));

        const result = await fetchThread('1abc23');

        expect(result).toEqual(payload);
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        expect(globalThis.fetch.mock.calls[0][0]).toContain('www.reddit.com/comments/1abc23.json');
    });

    it('falls back through the proxies when the direct request fails', async () => {
        const payload = threadPayload();
        globalThis.fetch = vi.fn(async (url) => {
            if (url.includes('allorigins')) {
                return jsonResponse(payload);
            }
            throw new Error('CORS blocked');
        });

        const result = await fetchThread('1abc23');

        expect(result).toEqual(payload);
        expect(globalThis.fetch).toHaveBeenCalledTimes(3);
        expect(globalThis.fetch.mock.calls[1][0]).toContain('corsproxy.io');
        expect(globalThis.fetch.mock.calls[2][0]).toContain('allorigins');
    });

    it('rejects a proxy that returns an HTML error page and tries the next', async () => {
        const payload = threadPayload();
        globalThis.fetch = vi.fn(async (url) => {
            if (url.includes('allorigins')) {
                return jsonResponse(payload);
            }
            return { ok: true, status: 200, statusText: 'OK', text: async () => '<html>nope</html>' };
        });

        const result = await fetchThread('1abc23');

        expect(result).toEqual(payload);
        expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    });

    it('records a Reddit error payload against every tier it tried', async () => {
        globalThis.fetch = vi.fn(async () => jsonResponse({ error: 403, message: 'Forbidden' }));

        const error = await fetchThread('1abc23').catch((e) => e);

        expect(error.name).toBe('ProxyFetchError');
        expect(error.attempts.length).toBeGreaterThan(1);
        expect(error.describeAttempts()).toMatch(/403/);
        // Every tier is reported, not just the last one.
        expect(error.attempts.every((a) => a.error)).toBe(true);
    });

    it('reports a deleted thread in the attempt log', async () => {
        globalThis.fetch = vi.fn(async () => jsonResponse([
            { kind: 'Listing', data: { children: [] } },
            { kind: 'Listing', data: { children: [] } }
        ]));

        const error = await fetchThread('1abc23').catch((e) => e);

        expect(error.describeAttempts()).toMatch(/could not be found|Unexpected/i);
    });

    it('labels the smaller-limit retry pass distinctly', async () => {
        globalThis.fetch = vi.fn(async () => {
            throw new Error('CORS blocked');
        });

        const error = await fetchThread('1abc23', { limit: 500 }).catch((e) => e);
        const tiers = error.attempts.map((a) => a.tier);

        expect(tiers).toContain('direct');
        expect(tiers).toContain('direct (retry, limit 100)');
        // No tier name appears twice unlabelled.
        const plain = tiers.filter((t) => !t.includes('retry'));
        expect(new Set(plain).size).toBe(plain.length);
    });

    it('names each tier it tried', async () => {
        globalThis.fetch = vi.fn(async () => {
            throw new Error('CORS blocked');
        });

        const error = await fetchThread('1abc23').catch((e) => e);
        const tiers = error.attempts.map((a) => a.tier);

        expect(tiers).toContain('direct');
        expect(tiers).toContain('corsproxy.io');
        expect(tiers).toContain('allorigins/raw');
        expect(tiers).toContain('allorigins/get');
    });

    it('retries once at a smaller limit when everything fails', async () => {
        globalThis.fetch = vi.fn(async () => {
            throw new Error('CORS blocked');
        });

        await fetchThread('1abc23', { limit: 500 }).catch(() => {});

        const requested = globalThis.fetch.mock.calls.map((c) => decodeURIComponent(c[0]));
        expect(requested.some((u) => u.includes('limit=500'))).toBe(true);
        expect(requested.some((u) => u.includes('limit=100'))).toBe(true);
        // Exactly one retry pass, not a loop.
        expect(requested.filter((u) => u.includes('limit=100')).length)
            .toBe(requested.filter((u) => u.includes('limit=500')).length);
    });

    it('does not retry when the limit is already small', async () => {
        globalThis.fetch = vi.fn(async () => {
            throw new Error('CORS blocked');
        });

        await fetchThread('1abc23', { limit: 50 }).catch(() => {});

        const requested = globalThis.fetch.mock.calls.map((c) => decodeURIComponent(c[0]));
        expect(requested.every((u) => u.includes('limit=50'))).toBe(true);
    });

    describe('OAuth tier', () => {
        it('is skipped when no client ID is configured', async () => {
            globalThis.fetch = vi.fn(async () => jsonResponse(threadPayload()));

            await fetchThread('1abc23');

            const requested = globalThis.fetch.mock.calls.map((c) => c[0]);
            expect(requested.some((u) => u.includes('oauth.reddit.com'))).toBe(false);
        });

        it('is tried first when a client ID is configured', async () => {
            const payload = threadPayload();
            globalThis.fetch = vi.fn(async (url) => {
                if (url.includes('access_token')) {
                    return { ok: true, status: 200, json: async () => ({ access_token: 't0k', expires_in: 3600 }) };
                }
                if (url.includes('oauth.reddit.com')) {
                    return jsonResponse(payload);
                }
                throw new Error('should not reach the ladder');
            });

            const result = await fetchThread('1abc23', { clientId: 'abc123' });

            expect(result).toEqual(payload);
            const requested = globalThis.fetch.mock.calls.map((c) => c[0]);
            expect(requested[0]).toContain('access_token');
            expect(requested[1]).toContain('oauth.reddit.com');
        });

        it('falls through to the ladder when OAuth fails', async () => {
            const payload = threadPayload();
            globalThis.fetch = vi.fn(async (url) => {
                if (url.includes('access_token')) {
                    return { ok: false, status: 401, json: async () => ({}) };
                }
                if (url.includes('oauth.reddit.com')) {
                    throw new Error('unreachable');
                }
                return jsonResponse(payload);
            });

            const result = await fetchThread('1abc23', { clientId: 'abc123' });

            expect(result).toEqual(payload);
        });
    });

    describe('native tier', () => {
        afterEach(() => {
            delete window.Capacitor;
        });

        it('is skipped on the web build', async () => {
            globalThis.fetch = vi.fn(async () => jsonResponse(threadPayload()));

            await fetchThread('1abc23');

            expect(globalThis.fetch).toHaveBeenCalled();
        });
    });
});

describe('parseThreadJson', () => {
    it('returns a valid payload', () => {
        const payload = threadPayload();
        expect(parseThreadJson(JSON.stringify(payload))).toEqual(payload);
    });

    it('rejects an HTML block page', () => {
        expect(() => parseThreadJson('<html>blocked</html>'))
            .toThrow(/was not JSON/i);
    });

    it('rejects a valid-JSON non-thread', () => {
        expect(() => parseThreadJson(JSON.stringify({ error: 403, message: 'Forbidden' })))
            .toThrow(/403/);
    });
});
