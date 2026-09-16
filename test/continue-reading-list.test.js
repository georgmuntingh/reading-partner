import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderContinueReading, formatTimeAgo } from '../js/ui/continue-reading-list.js';

function entry(bookId, overrides = {}) {
    return {
        bookId,
        bookTitle: `Title ${bookId}`,
        chapterIndex: 2,
        sentenceIndex: 0,
        bookmarkCount: 0,
        highlightCount: 0,
        source: null,
        fileType: 'epub',
        timestamp: Date.now(),
        ...overrides
    };
}

function history(n) {
    return Array.from({ length: n }, (_, i) => entry(`book-${i}`));
}

let container;

beforeEach(() => {
    document.body.innerHTML = '<div id="host"></div>';
    container = document.getElementById('host');
});

/** Stubs that skip the real menu + confirm dialogs. */
function stubs({ pick = 'delete', confirmed = true } = {}) {
    return {
        openMenu: vi.fn().mockResolvedValue(pick),
        confirm: vi.fn().mockResolvedValue(confirmed)
    };
}

describe('renderContinueReading', () => {
    it('renders one row per entry with a title heading', () => {
        const count = renderContinueReading(container, { history: history(7) });

        expect(count).toBe(7);
        expect(container.querySelectorAll('.resume-banner')).toHaveLength(7);
        expect(container.querySelector('.resume-section-title').textContent)
            .toBe('Continue reading');
    });

    it('renders nothing and reports zero for an empty history', () => {
        expect(renderContinueReading(container, { history: [] })).toBe(0);
        expect(container.innerHTML).toBe('');
    });

    it('skips entries with no bookId', () => {
        const count = renderContinueReading(container, {
            history: [entry('a'), { bookTitle: 'orphan' }]
        });
        expect(count).toBe(1);
    });

    it('uses the modal class names for the modal variant', () => {
        renderContinueReading(container, { history: history(2), variant: 'modal' });

        expect(container.querySelector('.modal-continue-reading-list')).toBeTruthy();
        expect(container.querySelectorAll('.modal-resume-item')).toHaveLength(2);
    });

    it('shows the chapter number, format badge and relative time', () => {
        renderContinueReading(container, {
            history: [entry('a', { bookTitle: 'Moby Dick', bookmarkCount: 2 })]
        });

        const row = container.querySelector('.resume-banner');
        expect(row.textContent).toContain('Moby Dick');
        expect(row.textContent).toContain('Chapter 3');
        expect(row.textContent).toContain('2 bookmarks');
        expect(row.textContent).toContain('Last read just now');
        expect(row.querySelector('.format-badge')).toBeTruthy();
    });

    it('escapes titles rather than interpreting them as markup', () => {
        renderContinueReading(container, {
            history: [entry('a', { bookTitle: '<img src=x onerror=alert(1)>' })]
        });

        expect(container.querySelector('img')).toBeNull();
        expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    });
});

describe('collapsing', () => {
    it('shows only the first collapseAfter rows behind a toggle', () => {
        const count = renderContinueReading(container, {
            history: history(7),
            collapseAfter: 3
        });

        expect(count).toBe(3);
        expect(container.querySelectorAll('.resume-banner')).toHaveLength(3);
        expect(container.querySelector('.resume-toggle-btn').textContent).toBe('Show all 7');
    });

    it('expands and collapses again when the toggle is clicked', () => {
        renderContinueReading(container, { history: history(7), collapseAfter: 3 });

        container.querySelector('.resume-toggle-btn').click();
        expect(container.querySelectorAll('.resume-banner')).toHaveLength(7);
        expect(container.querySelector('.resume-toggle-btn').textContent).toBe('Show fewer');

        container.querySelector('.resume-toggle-btn').click();
        expect(container.querySelectorAll('.resume-banner')).toHaveLength(3);
    });

    it('stays expanded across a re-render, as after a removal', () => {
        renderContinueReading(container, { history: history(7), collapseAfter: 3 });
        container.querySelector('.resume-toggle-btn').click();

        renderContinueReading(container, { history: history(6), collapseAfter: 3 });
        expect(container.querySelectorAll('.resume-banner')).toHaveLength(6);
    });

    it('omits the toggle when the list already fits', () => {
        renderContinueReading(container, { history: history(3), collapseAfter: 3 });
        expect(container.querySelector('.resume-toggle-btn')).toBeNull();
    });

    it('does not collapse when collapseAfter is 0', () => {
        renderContinueReading(container, { history: history(7), collapseAfter: 0 });
        expect(container.querySelectorAll('.resume-banner')).toHaveLength(7);
    });
});

describe('row actions', () => {
    it('calls onResume with the entry when Resume is clicked', () => {
        const onResume = vi.fn();
        renderContinueReading(container, { history: [entry('a')], onResume });

        container.querySelector('.resume-btn').click();
        expect(onResume).toHaveBeenCalledWith(expect.objectContaining({ bookId: 'a' }));
    });

    it('removes without confirming, and without resuming', () => {
        const onRemove = vi.fn();
        const onResume = vi.fn();
        renderContinueReading(container, { history: [entry('a')], onRemove, onResume });

        container.querySelector('.resume-remove-btn').click();
        expect(onRemove).toHaveBeenCalledWith('a');
        expect(onResume).not.toHaveBeenCalled();
        expect(document.querySelector('.confirm-modal-overlay')).toBeNull();
    });

    it('labels the remove button with the book it belongs to', () => {
        renderContinueReading(container, { history: [entry('a', { bookTitle: 'Ulysses' })] });

        expect(container.querySelector('.resume-remove-btn').getAttribute('aria-label'))
            .toBe('Remove "Ulysses" from Continue reading');
    });

    it('deletes only after the menu pick is confirmed', async () => {
        const onDelete = vi.fn();
        const { openMenu, confirm } = stubs();
        renderContinueReading(container, { history: [entry('a')], onDelete, openMenu, confirm });

        container.querySelector('.resume-menu-btn').click();
        await vi.waitFor(() => expect(onDelete).toHaveBeenCalledWith('a'));

        expect(openMenu).toHaveBeenCalled();
        expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ danger: true }));
    });

    it('does not delete when the confirm is cancelled', async () => {
        const onDelete = vi.fn();
        const { openMenu, confirm } = stubs({ confirmed: false });
        renderContinueReading(container, { history: [entry('a')], onDelete, openMenu, confirm });

        container.querySelector('.resume-menu-btn').click();
        await vi.waitFor(() => expect(confirm).toHaveBeenCalled());
        expect(onDelete).not.toHaveBeenCalled();
    });

    it('does not confirm or delete when the menu is dismissed', async () => {
        const onDelete = vi.fn();
        const { openMenu, confirm } = stubs({ pick: null });
        renderContinueReading(container, { history: [entry('a')], onDelete, openMenu, confirm });

        container.querySelector('.resume-menu-btn').click();
        await vi.waitFor(() => expect(openMenu).toHaveBeenCalled());
        expect(confirm).not.toHaveBeenCalled();
        expect(onDelete).not.toHaveBeenCalled();
    });
});

describe('formatTimeAgo', () => {
    it('reports sub-minute gaps as "just now"', () => {
        expect(formatTimeAgo(Date.now() - 5_000)).toBe('just now');
    });

    it('singularises and pluralises units', () => {
        expect(formatTimeAgo(Date.now() - 60 * 60 * 1000)).toBe('1 hour ago');
        expect(formatTimeAgo(Date.now() - 3 * 60 * 60 * 1000)).toBe('3 hours ago');
        expect(formatTimeAgo(Date.now() - 5 * 24 * 60 * 60 * 1000)).toBe('5 days ago');
    });
});
