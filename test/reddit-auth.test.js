import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getAccessToken, clearAccessToken } from '../js/services/reddit-auth.js';
import { storage } from '../js/services/storage.js';

function tokenResponse(body, { ok = true, status = 200 } = {}) {
    return { ok, status, json: async () => body };
}

describe('reddit-auth', () => {
    let originalFetch;

    beforeEach(async () => {
        originalFetch = globalThis.fetch;
        await storage.init();
        await clearAccessToken();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('requires a client ID', async () => {
        await expect(getAccessToken('')).rejects.toThrow(/no reddit client id/i);
    });

    it('requests an app-only token with the installed-client grant', async () => {
        globalThis.fetch = vi.fn(async () => tokenResponse({ access_token: 't0k', expires_in: 3600 }));

        const token = await getAccessToken('my-client-id');

        expect(token).toBe('t0k');
        const [url, init] = globalThis.fetch.mock.calls[0];
        expect(url).toBe('https://www.reddit.com/api/v1/access_token');
        expect(init.method).toBe('POST');
        expect(init.body).toContain('grant_type=https%3A%2F%2Foauth.reddit.com%2Fgrants%2Finstalled_client');
        expect(init.body).toContain('device_id=DO_NOT_TRACK_THIS_DEVICE');
    });

    it('sends Basic auth with an empty password', async () => {
        globalThis.fetch = vi.fn(async () => tokenResponse({ access_token: 't0k', expires_in: 3600 }));

        await getAccessToken('my-client-id');

        const header = globalThis.fetch.mock.calls[0][1].headers.Authorization;
        expect(header.startsWith('Basic ')).toBe(true);
        expect(atob(header.slice(6))).toBe('my-client-id:');
    });

    it('reuses a cached token instead of minting a second one', async () => {
        globalThis.fetch = vi.fn(async () => tokenResponse({ access_token: 't0k', expires_in: 3600 }));

        await getAccessToken('my-client-id');
        await getAccessToken('my-client-id');

        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('mints a fresh token when the cached one is near expiry', async () => {
        let issued = 0;
        globalThis.fetch = vi.fn(async () =>
            tokenResponse({ access_token: `t0k${++issued}`, expires_in: 10 })
        );

        const first = await getAccessToken('my-client-id');
        const second = await getAccessToken('my-client-id');

        // expires_in of 10s is inside the refresh margin, so it is not reused.
        expect(first).toBe('t0k1');
        expect(second).toBe('t0k2');
    });

    it('mints a fresh token when the client ID changes', async () => {
        let issued = 0;
        globalThis.fetch = vi.fn(async () =>
            tokenResponse({ access_token: `t0k${++issued}`, expires_in: 3600 })
        );

        await getAccessToken('client-a');
        const second = await getAccessToken('client-b');

        expect(second).toBe('t0k2');
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('explains a rejected client ID', async () => {
        globalThis.fetch = vi.fn(async () => tokenResponse({}, { ok: false, status: 401 }));

        await expect(getAccessToken('bad-id')).rejects.toThrow(/installed app/i);
    });

    it('reports other token failures by status', async () => {
        globalThis.fetch = vi.fn(async () => tokenResponse({}, { ok: false, status: 503 }));

        await expect(getAccessToken('my-client-id')).rejects.toThrow(/503/);
    });

    it('rejects a response with no access_token', async () => {
        globalThis.fetch = vi.fn(async () => tokenResponse({ nope: true }));

        await expect(getAccessToken('my-client-id')).rejects.toThrow(/no access_token/i);
    });

    it('clearAccessToken forces the next call to mint again', async () => {
        globalThis.fetch = vi.fn(async () => tokenResponse({ access_token: 't0k', expires_in: 3600 }));

        await getAccessToken('my-client-id');
        await clearAccessToken();
        await getAccessToken('my-client-id');

        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('survives a token that cannot be persisted', async () => {
        globalThis.fetch = vi.fn(async () => tokenResponse({ access_token: 't0k', expires_in: 3600 }));
        const saveSetting = vi.spyOn(storage, 'saveSetting').mockRejectedValue(new Error('quota'));

        await expect(getAccessToken('my-client-id')).resolves.toBe('t0k');

        saveSetting.mockRestore();
    });
});
