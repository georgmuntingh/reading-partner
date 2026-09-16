import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    loadHistory,
    saveHistory,
    recordVisit,
    removeEntry,
    trimHistory,
    DEFAULT_HISTORY_SIZE
} from '../js/services/reading-history.js';

const STORAGE_KEY = 'readingPartner.history';

/** Minimal saved-state entry. */
function entry(bookId, overrides = {}) {
    return {
        bookId,
        bookTitle: `Title ${bookId}`,
        chapterIndex: 0,
        sentenceIndex: 0,
        bookmarkCount: 0,
        highlightCount: 0,
        source: null,
        fileType: 'epub',
        timestamp: 1000,
        ...overrides
    };
}

function setLegacyCookie(value) {
    document.cookie = `readingPartnerState=${encodeURIComponent(JSON.stringify(value))};path=/`;
}

function clearCookies() {
    for (const cookie of document.cookie.split(';')) {
        const name = cookie.split('=')[0].trim();
        if (name) document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
    }
}

beforeEach(() => {
    localStorage.clear();
    clearCookies();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('loadHistory', () => {
    it('returns an empty array when nothing is stored', () => {
        expect(loadHistory()).toEqual([]);
    });

    it('reads entries back from localStorage', () => {
        saveHistory([entry('a'), entry('b')]);
        expect(loadHistory().map((h) => h.bookId)).toEqual(['a', 'b']);
    });

    it('returns an empty array for malformed stored JSON', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        localStorage.setItem(STORAGE_KEY, 'not json');
        expect(loadHistory()).toEqual([]);
    });

    it('returns an empty array when the stored value is not an array', () => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ bookId: 'a' }));
        expect(loadHistory()).toEqual([]);
    });

    it('survives localStorage throwing, as in private browsing', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('denied');
        });
        expect(loadHistory()).toEqual([]);
    });

    it('does not throw when localStorage refuses a write', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('quota');
        });
        expect(() => saveHistory([entry('a')])).not.toThrow();
    });
});

describe('cookie migration', () => {
    it('migrates the legacy cookie array into localStorage and expires the cookie', () => {
        setLegacyCookie([entry('a'), entry('b')]);

        expect(loadHistory().map((h) => h.bookId)).toEqual(['a', 'b']);
        expect(JSON.parse(localStorage.getItem(STORAGE_KEY)).map((h) => h.bookId))
            .toEqual(['a', 'b']);
        expect(document.cookie).not.toContain('readingPartnerState=%5B');
    });

    it('migrates the even older single-object cookie format', () => {
        setLegacyCookie(entry('solo'));
        expect(loadHistory().map((h) => h.bookId)).toEqual(['solo']);
    });

    it('ignores the cookie once localStorage holds a value', () => {
        saveHistory([entry('fresh')]);
        setLegacyCookie([entry('stale')]);
        expect(loadHistory().map((h) => h.bookId)).toEqual(['fresh']);
    });

    it('treats an emptied history as authoritative over a leftover cookie', () => {
        saveHistory([]);
        setLegacyCookie([entry('stale')]);
        expect(loadHistory()).toEqual([]);
    });
});

describe('recordVisit', () => {
    it('puts the newest book at the front', () => {
        recordVisit(entry('a'));
        recordVisit(entry('b'));
        expect(loadHistory().map((h) => h.bookId)).toEqual(['b', 'a']);
    });

    it('moves a re-read book to the front instead of duplicating it', () => {
        recordVisit(entry('a'));
        recordVisit(entry('b'));
        recordVisit(entry('a', { chapterIndex: 4 }));

        const history = loadHistory();
        expect(history.map((h) => h.bookId)).toEqual(['a', 'b']);
        expect(history[0].chapterIndex).toBe(4);
    });

    it('keeps at most maxSize entries', () => {
        for (const id of ['a', 'b', 'c', 'd']) recordVisit(entry(id), 3);
        expect(loadHistory().map((h) => h.bookId)).toEqual(['d', 'c', 'b']);
    });

    it('defaults to seven entries', () => {
        expect(DEFAULT_HISTORY_SIZE).toBe(7);
        for (let i = 0; i < 9; i++) recordVisit(entry(`book-${i}`));
        expect(loadHistory()).toHaveLength(7);
    });

    it('ignores an entry with no bookId', () => {
        recordVisit(entry('a'));
        recordVisit({ bookTitle: 'orphan' });
        expect(loadHistory().map((h) => h.bookId)).toEqual(['a']);
    });
});

describe('removeEntry', () => {
    it('drops just the named book and persists the result', () => {
        saveHistory([entry('a'), entry('b'), entry('c')]);

        expect(removeEntry('b').map((h) => h.bookId)).toEqual(['a', 'c']);
        expect(loadHistory().map((h) => h.bookId)).toEqual(['a', 'c']);
    });

    it('is a no-op for a book that is not in the list', () => {
        saveHistory([entry('a')]);
        expect(removeEntry('zzz').map((h) => h.bookId)).toEqual(['a']);
    });

    it('can empty the list entirely', () => {
        saveHistory([entry('a')]);
        expect(removeEntry('a')).toEqual([]);
        expect(loadHistory()).toEqual([]);
    });
});

describe('trimHistory', () => {
    it('cuts the list down when the size setting shrinks', () => {
        saveHistory([entry('a'), entry('b'), entry('c'), entry('d')]);
        expect(trimHistory(2).map((h) => h.bookId)).toEqual(['a', 'b']);
        expect(loadHistory()).toHaveLength(2);
    });

    it('leaves a short list alone', () => {
        saveHistory([entry('a')]);
        expect(trimHistory(7).map((h) => h.bookId)).toEqual(['a']);
    });
});
