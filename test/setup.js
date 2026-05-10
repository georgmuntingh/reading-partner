import 'fake-indexeddb/auto';
import { afterEach } from 'vitest';

afterEach(async () => {
    await new Promise((resolve) => {
        const req = indexedDB.deleteDatabase('reading-partner-db');
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
});

if (!globalThis.crypto?.randomUUID) {
    let i = 0;
    globalThis.crypto = { ...globalThis.crypto, randomUUID: () => `uuid-${++i}` };
}
