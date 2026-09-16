import 'fake-indexeddb/auto';
import { afterEach } from 'vitest';

afterEach(async () => {
    await new Promise((resolve) => {
        const req = indexedDB.deleteDatabase('reading-partner-db');
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
});

// happy-dom builds its document without a doctype and does not implement
// `document.compatMode` at all, so libraries that check it see `undefined` and
// treat the page as quirks mode -- KaTeX outright refuses to render. The real
// app is standards mode (index.html opens with <!DOCTYPE html>), so give the
// test document both a doctype and the matching compatMode.
if (typeof document !== 'undefined') {
    if (!document.doctype) {
        document.insertBefore(
            document.implementation.createDocumentType('html', '', ''),
            document.documentElement
        );
    }
    if (document.compatMode === undefined) {
        Object.defineProperty(document, 'compatMode', {
            value: 'CSS1Compat',
            configurable: true
        });
    }
}

if (!globalThis.crypto?.randomUUID) {
    let i = 0;
    globalThis.crypto = { ...globalThis.crypto, randomUUID: () => `uuid-${++i}` };
}
