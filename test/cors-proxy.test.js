import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchWithProxyFallback, ProxyFetchError, CORS_PROXIES } from '../js/utils/cors-proxy.js';

function textResponse(body, { status = 200, contentType = 'application/json' } = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? 'OK' : 'Error',
        headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
        text: async () => body
    };
}

describe('CORS_PROXIES', () => {
    it('uses the current corsproxy.io ?url= format', () => {
        const built = CORS_PROXIES.find((p) => p.name === 'corsproxy.io')
            .build('https://example.com/a?b=c');

        expect(built).toBe('https://corsproxy.io/?url=https%3A%2F%2Fexample.com%2Fa%3Fb%3Dc');
    });

    it('fully encodes the target query string for every proxy', () => {
        for (const proxy of CORS_PROXIES) {
            const built = proxy.build('https://example.com/a?b=c&d=e');
            // The target's own & must not leak into the proxy's query string.
            expect(built.split('?').length).toBe(2);
        }
    });

    it('unwraps the allorigins /get envelope', () => {
        const proxy = CORS_PROXIES.find((p) => p.name === 'allorigins/get');

        expect(proxy.unwrap(JSON.stringify({ contents: '{"a":1}' }))).toBe('{"a":1}');
        expect(() => proxy.unwrap(JSON.stringify({ nope: true }))).toThrow(/no contents/i);
    });
});

describe('fetchWithProxyFallback', () => {
    let originalFetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('tries the direct request first when asked', async () => {
        globalThis.fetch = vi.fn(async () => textResponse('{"ok":true}'));

        const result = await fetchWithProxyFallback('https://example.com/a', { direct: true });

        expect(result.direct).toBe(true);
        expect(result.tier).toBe('direct');
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('skips the direct request by default', async () => {
        globalThis.fetch = vi.fn(async () => textResponse('{"ok":true}'));

        const result = await fetchWithProxyFallback('https://example.com/a');

        expect(result.tier).toBe('corsproxy.io');
    });

    it('walks the tiers in order until one succeeds', async () => {
        globalThis.fetch = vi.fn(async (url) => {
            if (url.includes('allorigins.win/raw')) {
                return textResponse('{"ok":true}');
            }
            throw new Error('blocked');
        });

        const result = await fetchWithProxyFallback('https://example.com/a', { direct: true });

        expect(result.tier).toBe('allorigins/raw');
        expect(result.attempts.map((a) => a.tier))
            .toEqual(['direct', 'corsproxy.io', 'allorigins/raw']);
    });

    it('passes unwrapped text to validateText', async () => {
        globalThis.fetch = vi.fn(async (url) => {
            if (url.includes('allorigins.win/get')) {
                return textResponse(JSON.stringify({ contents: '{"real":"payload"}' }));
            }
            throw new Error('blocked');
        });

        const seen = [];
        await fetchWithProxyFallback('https://example.com/a', {
            validateText: (text) => seen.push(text)
        });

        expect(seen).toEqual(['{"real":"payload"}']);
    });

    it('moves on when validateText rejects the body', async () => {
        globalThis.fetch = vi.fn(async (url) => {
            if (url.includes('codetabs')) {
                return textResponse('{"good":true}');
            }
            return textResponse('<html>error page</html>', { contentType: 'text/html' });
        });

        const result = await fetchWithProxyFallback('https://example.com/a', {
            validateText: (text) => {
                if (!text.startsWith('{')) throw new Error('not JSON');
            }
        });

        expect(result.tier).toBe('codetabs');
    });

    describe('diagnostics', () => {
        it('throws a ProxyFetchError carrying every attempt', async () => {
            globalThis.fetch = vi.fn(async () => textResponse('nope', { status: 403, contentType: 'text/html' }));

            const error = await fetchWithProxyFallback('https://example.com/a', { direct: true })
                .catch((e) => e);

            expect(error).toBeInstanceOf(ProxyFetchError);
            expect(error.targetUrl).toBe('https://example.com/a');
            expect(error.attempts).toHaveLength(CORS_PROXIES.length + 1);
        });

        it('records status, content type and a body preview per tier', async () => {
            globalThis.fetch = vi.fn(async () =>
                textResponse('<html>you are blocked</html>', { status: 403, contentType: 'text/html; charset=utf-8' })
            );

            const error = await fetchWithProxyFallback('https://example.com/a').catch((e) => e);
            const [first] = error.attempts;

            expect(first.status).toBe(403);
            expect(first.contentType).toContain('text/html');
            expect(first.bodyPreview).toContain('you are blocked');
            expect(first.error).toMatch(/403/);
            expect(first.ok).toBe(false);
        });

        it('records the failure message when the request never lands', async () => {
            globalThis.fetch = vi.fn(async () => {
                throw new TypeError('Failed to fetch');
            });

            const error = await fetchWithProxyFallback('https://example.com/a').catch((e) => e);

            expect(error.attempts[0].status).toBeNull();
            expect(error.attempts[0].error).toBe('Failed to fetch');
        });

        it('describes every tier on one line each', async () => {
            globalThis.fetch = vi.fn(async () => {
                throw new Error('blocked');
            });

            const error = await fetchWithProxyFallback('https://example.com/a', { direct: true })
                .catch((e) => e);
            const lines = error.describeAttempts().split('\n');

            expect(lines).toHaveLength(CORS_PROXIES.length + 1);
            expect(lines[0]).toMatch(/^direct: no response — blocked$/);
        });

        it('truncates long body previews', async () => {
            globalThis.fetch = vi.fn(async () => textResponse('x'.repeat(5000), { status: 500 }));

            const error = await fetchWithProxyFallback('https://example.com/a').catch((e) => e);

            expect(error.attempts[0].bodyPreview.length).toBeLessThanOrEqual(200);
        });
    });

    it('still supports the response-based validate hook', async () => {
        // _downloadFromURL and _downloadGutenbergEpub read blobs this way.
        globalThis.fetch = vi.fn(async () => ({
            ok: true,
            status: 200,
            headers: { get: () => 'application/epub+zip' },
            blob: async () => ({ size: 4096 })
        }));

        let captured = null;
        const result = await fetchWithProxyFallback('https://example.com/book.epub', {
            validate: async (response) => {
                captured = await response.blob();
                if (captured.size < 100) throw new Error('too small');
            }
        });

        expect(captured.size).toBe(4096);
        expect(result.response.headers.get('content-type')).toBe('application/epub+zip');
    });
});
