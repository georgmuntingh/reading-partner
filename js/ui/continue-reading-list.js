/**
 * Continue Reading List
 *
 * Shared renderer for the "Continue reading" list. Used by both the start
 * screen (js/app.js) and the Load-book modal (js/ui/book-loader-modal.js) so
 * the two lists cannot drift apart.
 *
 * Each row offers three actions:
 *   - Resume        — reopen the book where you left off.
 *   - x             — drop the entry from the list. Non-destructive and
 *                     instant: the book, its position, bookmarks and
 *                     highlights all stay put, so there is nothing to confirm.
 *   - ... (overflow) — "Delete book from device", behind a confirm dialog.
 */

import { FORMAT_LABELS } from '../services/parser-factory.js';
import { openContextMenu } from './kg-context-menu.js';
import { confirmAction } from './confirm-modal.js';

/**
 * Expanded/collapsed state per container, so a re-render (after a removal,
 * say) does not silently collapse a list the reader had opened up.
 * @type {WeakMap<Element, boolean>}
 */
const expandedByContainer = new WeakMap();

/** Class names per call site, so each keeps its existing CSS. */
const VARIANTS = {
    page: {
        title: 'resume-section-title',
        list: null, // banners sit directly in the section
        item: 'resume-banner'
    },
    modal: {
        title: 'modal-continue-reading-title',
        list: 'modal-continue-reading-list',
        item: 'modal-resume-item'
    }
};

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

/**
 * Format a timestamp as a relative time string.
 * @param {number} timestamp
 * @returns {string}
 */
export function formatTimeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days} day${days > 1 ? 's' : ''} ago`;
    const months = Math.floor(days / 30);
    return `${months} month${months > 1 ? 's' : ''} ago`;
}

const PASTE_ICON = '<svg class="resume-paste-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg> ';
const LLM_ICON = '<svg class="resume-paste-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg> ';

/**
 * Build the descriptive line for one entry.
 * @param {Object} entry
 * @returns {string} HTML
 */
function buildDetail(entry) {
    const ft = entry.fileType || 'epub';
    const ftLabel = FORMAT_LABELS[ft] || ft.toUpperCase();
    const formatBadge = `<span class="format-badge format-badge-sm format-${escapeHtml(ft)}">${escapeHtml(ftLabel)}</span>`;

    let sourceIcon = '';
    let sourceText = '';
    if (entry.source?.type === 'gutenberg') {
        sourceText = ' <span class="resume-source">from Project Gutenberg</span>';
    } else if (entry.source?.type === 'pasted') {
        sourceIcon = PASTE_ICON;
        sourceText = ' <span class="resume-source">pasted</span>';
    } else if (entry.source?.type === 'llm-generated') {
        sourceIcon = LLM_ICON;
        sourceText = ' <span class="resume-source">AI generated</span>';
    }

    const stats = [];
    if (entry.bookmarkCount > 0) {
        stats.push(`${entry.bookmarkCount} bookmark${entry.bookmarkCount > 1 ? 's' : ''}`);
    }
    if (entry.highlightCount > 0) {
        stats.push(`${entry.highlightCount} highlight${entry.highlightCount > 1 ? 's' : ''}`);
    }
    const statsText = stats.length > 0 ? ` (${stats.join(', ')})` : '';

    return `${formatBadge} ${sourceIcon}"${escapeHtml(entry.bookTitle)}"${sourceText} - Chapter ${entry.chapterIndex + 1}${statsText}`;
}

/**
 * Render the "Continue reading" list into a container.
 *
 * The container is cleared first. The caller owns the visibility of whatever
 * wraps it — check the return value to decide whether to show it at all.
 *
 * @param {Element} container - Element to render into.
 * @param {Object} options
 * @param {Object[]} options.history - Saved book states, most recent first.
 * @param {'page'|'modal'} [options.variant='page']
 * @param {string} [options.title='Continue reading']
 * @param {number} [options.collapseAfter=0] - Show at most this many rows behind
 *   a "Show all" toggle. 0 disables collapsing.
 * @param {(entry: Object) => void} [options.onResume]
 * @param {(bookId: string) => void} [options.onRemove]
 * @param {(bookId: string) => void} [options.onDelete]
 * @param {Function} [options.confirm=confirmAction] - Injectable for tests.
 * @param {Function} [options.openMenu=openContextMenu] - Injectable for tests.
 * @returns {number} How many rows were rendered.
 */
export function renderContinueReading(container, {
    history = [],
    variant = 'page',
    title = 'Continue reading',
    collapseAfter = 0,
    onResume,
    onRemove,
    onDelete,
    confirm = confirmAction,
    openMenu = openContextMenu
} = {}) {
    if (!container) return 0;

    const classes = VARIANTS[variant] || VARIANTS.page;
    const entries = history.filter((entry) => entry?.bookId);

    container.innerHTML = '';
    if (entries.length === 0) {
        expandedByContainer.delete(container);
        return 0;
    }

    const collapsible = collapseAfter > 0 && entries.length > collapseAfter;
    const expanded = collapsible ? (expandedByContainer.get(container) || false) : true;
    const visible = collapsible && !expanded ? entries.slice(0, collapseAfter) : entries;

    const heading = document.createElement('div');
    heading.className = classes.title;
    heading.textContent = title;
    container.appendChild(heading);

    let list = container;
    if (classes.list) {
        list = document.createElement('div');
        list.className = classes.list;
        container.appendChild(list);
    }

    for (const entry of visible) {
        const item = document.createElement('div');
        item.className = classes.item;
        item.dataset.bookId = entry.bookId;

        const label = escapeHtml(entry.bookTitle || 'this book');
        item.innerHTML = `
            <div class="resume-info">
                <div class="resume-detail">${buildDetail(entry)}</div>
                <div class="resume-time">Last read ${escapeHtml(formatTimeAgo(entry.timestamp))}</div>
            </div>
            <button type="button" class="btn btn-primary btn-sm resume-btn">Resume</button>
            <button type="button" class="resume-remove-btn" aria-label="Remove &quot;${label}&quot; from Continue reading" title="Remove from Continue reading">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"/>
                    <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
            </button>
            <button type="button" class="resume-menu-btn" aria-label="More actions for &quot;${label}&quot;" aria-haspopup="menu" title="More actions">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="12" cy="5" r="1.75"/>
                    <circle cx="12" cy="12" r="1.75"/>
                    <circle cx="12" cy="19" r="1.75"/>
                </svg>
            </button>
        `;

        item.querySelector('.resume-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            onResume?.(entry);
        });

        item.querySelector('.resume-remove-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            onRemove?.(entry.bookId);
        });

        item.querySelector('.resume-menu-btn').addEventListener('click', async (e) => {
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            const picked = await openMenu({
                x: rect.left,
                y: rect.bottom + 4,
                items: [{ id: 'delete', label: 'Delete book from device', danger: true }]
            });
            if (picked !== 'delete') return;

            const ok = await confirm({
                title: 'Delete book from device?',
                message: `"${entry.bookTitle}" will be permanently deleted from this device, along with its reading position, bookmarks, highlights and notes.`,
                confirmLabel: 'Delete',
                danger: true
            });
            if (ok) onDelete?.(entry.bookId);
        });

        list.appendChild(item);
    }

    if (collapsible) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'resume-toggle-btn';
        toggle.setAttribute('aria-expanded', String(expanded));
        toggle.textContent = expanded ? 'Show fewer' : `Show all ${entries.length}`;
        toggle.addEventListener('click', () => {
            expandedByContainer.set(container, !expanded);
            renderContinueReading(container, {
                history, variant, title, collapseAfter,
                onResume, onRemove, onDelete, confirm, openMenu
            });
        });
        container.appendChild(toggle);
    }

    return visible.length;
}
