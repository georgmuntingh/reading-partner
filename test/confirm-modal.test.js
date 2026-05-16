import { describe, it, expect, beforeEach } from 'vitest';
import { confirmAction } from '../js/ui/confirm-modal.js';

beforeEach(() => {
    document.body.innerHTML = '';
});

describe('confirmAction', () => {
    it('mounts a modal with the supplied title and message', async () => {
        const p = confirmAction({
            title: 'Clear KG?',
            message: 'This will delete every node and edge.',
            danger: true
        });
        const overlay = document.querySelector('.confirm-modal-overlay');
        expect(overlay).toBeTruthy();
        expect(overlay.textContent).toContain('Clear KG?');
        expect(overlay.textContent).toContain('This will delete every node and edge.');
        const confirmBtn = overlay.querySelector('[data-action="confirm"]');
        // danger=true → primary action gets the destructive class.
        expect(confirmBtn.classList.contains('btn-danger')).toBe(true);

        // Resolve the open promise so subsequent specs can mount a fresh modal.
        overlay.querySelector('[data-action="cancel"]').click();
        await p;
    });

    it('resolves true when the confirm button is clicked and removes the overlay', async () => {
        const p = confirmAction({ title: 'X', message: 'Y' });
        document.querySelector('[data-action="confirm"]').click();
        await expect(p).resolves.toBe(true);
        expect(document.querySelector('.confirm-modal-overlay')).toBeNull();
    });

    it('resolves false when the cancel button is clicked', async () => {
        const p = confirmAction({ title: 'X', message: 'Y' });
        document.querySelector('[data-action="cancel"]').click();
        await expect(p).resolves.toBe(false);
    });

    it('resolves false when the user clicks the overlay backdrop', async () => {
        const p = confirmAction({ title: 'X', message: 'Y' });
        // Click the overlay itself (not a descendant).
        const overlay = document.querySelector('.confirm-modal-overlay');
        overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await expect(p).resolves.toBe(false);
    });

    it('escapes HTML in title and message', async () => {
        const p = confirmAction({
            title: '<img src=x onerror=alert(1)>',
            message: '<script>bad()</script>'
        });
        const overlay = document.querySelector('.confirm-modal-overlay');
        expect(overlay.innerHTML).not.toContain('<img src=x onerror');
        expect(overlay.innerHTML).not.toContain('<script>bad()');
        expect(overlay.innerHTML).toContain('&lt;img');
        overlay.querySelector('[data-action="cancel"]').click();
        await p;
    });
});
