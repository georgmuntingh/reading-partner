/**
 * Flashcard Overview Modal
 *
 * Wider full-screen overlay (max-width 900px) that lists every card
 * for the current book. Search, sort, per-row inspect, jump-to-
 * passage, delete, and "Review Selection" actions. Driven entirely
 * by the host via callbacks — owns no storage logic except calling
 * the injected confirm dialog.
 *
 * Public API:
 *   new FlashcardOverview({ container, confirmAction? },
 *                         { onClose, onJumpToPassage, onCardDeleted, onReviewSelection })
 *   show({ cards, nodesById, scrollToCardId? })
 *   hide()
 *   refresh({ cards, nodesById })           — re-render after a host-side mutation
 */

import { confirmAction as defaultConfirm } from './confirm-modal.js';
import { bandFor, bandColor, dueLabel } from '../services/srs-mastery.js';

const ESCAPE = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const SORT_OPTIONS = [
    { value: 'box-asc',   label: 'Box (failing first)' },
    { value: 'due-asc',   label: 'Due (soonest first)' },
    { value: 'level-asc', label: 'Level (L1 first)' }
];

function comparators(a, b, by) {
    if (by === 'box-asc') {
        return (a.srsBox ?? 0) - (b.srsBox ?? 0) ||
               (a.nextReviewAt ?? 0) - (b.nextReviewAt ?? 0);
    }
    if (by === 'due-asc') {
        return (a.nextReviewAt ?? Infinity) - (b.nextReviewAt ?? Infinity);
    }
    // level-asc
    return (a.cognitiveLevel ?? 1) - (b.cognitiveLevel ?? 1) ||
           (a.srsBox ?? 0) - (b.srsBox ?? 0);
}

function nodeNames(card, nodesById) {
    const ids = Array.isArray(card.targetNodeIds) ? card.targetNodeIds : [];
    return ids
        .map((id) => nodesById?.get?.(id)?.canonicalName ?? id)
        .filter(Boolean);
}

function matchesQuery(card, nodesById, q) {
    if (!q) return true;
    const needle = q.toLowerCase();
    const hay = [
        card.question ?? '',
        card.explanation ?? '',
        ...nodeNames(card, nodesById)
    ].join(' ').toLowerCase();
    return hay.includes(needle);
}

export class FlashcardOverview {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.container
     * @param {(args: Object) => Promise<boolean>} [options.confirmAction]  injected for testability
     * @param {Object} callbacks
     * @param {() => void} [callbacks.onClose]
     * @param {({chapterIndex,sentenceIndex,card}: Object) => void} [callbacks.onJumpToPassage]
     * @param {(card: Object) => void} [callbacks.onCardDeleted]
     * @param {(cards: Object[]) => void} [callbacks.onReviewSelection]
     */
    constructor(options, callbacks = {}) {
        this._container = options.container;
        this._confirmAction = options.confirmAction ?? defaultConfirm;
        this._callbacks = callbacks;

        this._cards = [];
        this._nodesById = new Map();
        this._query = '';
        this._sortBy = 'box-asc';
        this._expandedIds = new Set();
        this._scrollToCardId = null;

        this._buildShell();
        this._setupEventListeners();
    }

    // ---------- DOM construction ----------

    _buildShell() {
        this._container.innerHTML = `
            <div class="fc-dialog" role="dialog" aria-modal="true" aria-label="Flashcard overview">
                <div class="fc-header">
                    <h2 class="fc-title">Flashcards</h2>
                    <div class="fc-header-controls">
                        <input type="search" class="fc-search" id="fc-search" placeholder="Search cards, nodes, explanations…" autocomplete="off" aria-label="Search flashcards">
                        <select class="fc-sort" id="fc-sort" aria-label="Sort flashcards">
                            ${SORT_OPTIONS.map((o) => `<option value="${o.value}">${ESCAPE(o.label)}</option>`).join('')}
                        </select>
                        <button class="btn btn-primary fc-review-btn" id="fc-review-btn" disabled>Review Selection</button>
                    </div>
                    <button class="fc-close-btn" id="fc-close-btn" aria-label="Close">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="18" y1="6" x2="6" y2="18"/>
                            <line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </button>
                </div>
                <div class="fc-body" id="fc-body"></div>
                <div class="fc-footer" id="fc-footer"></div>
            </div>
        `;
        this._elements = {
            dialog: this._container.querySelector('.fc-dialog'),
            search: this._container.querySelector('#fc-search'),
            sort: this._container.querySelector('#fc-sort'),
            reviewBtn: this._container.querySelector('#fc-review-btn'),
            closeBtn: this._container.querySelector('#fc-close-btn'),
            body: this._container.querySelector('#fc-body'),
            footer: this._container.querySelector('#fc-footer')
        };
    }

    _setupEventListeners() {
        this._elements.closeBtn.addEventListener('click', () => {
            this.hide();
            this._callbacks.onClose?.();
        });
        this._elements.search.addEventListener('input', () => {
            this._query = this._elements.search.value;
            this._renderList();
        });
        this._elements.sort.addEventListener('change', () => {
            this._sortBy = this._elements.sort.value;
            this._renderList();
        });
        this._elements.reviewBtn.addEventListener('click', () => {
            const visible = this._visibleCards();
            if (visible.length === 0) return;
            this._callbacks.onReviewSelection?.(visible);
        });
        // Row events delegated.
        this._elements.body.addEventListener('click', (e) => this._onBodyClick(e));
    }

    // ---------- show / hide / refresh ----------

    show({ cards, nodesById, scrollToCardId = null }) {
        this._cards = Array.isArray(cards) ? cards.slice() : [];
        this._nodesById = nodesById instanceof Map ? nodesById : new Map();
        this._scrollToCardId = scrollToCardId;
        if (scrollToCardId) this._expandedIds.add(scrollToCardId);
        this._renderList();
        this._container.classList.remove('hidden');
        this._container.offsetHeight; // force reflow for transition
        this._container.classList.add('active');
    }

    hide() {
        this._container.classList.remove('active');
        this._container.classList.add('hidden');
        this._expandedIds.clear();
        this._scrollToCardId = null;
    }

    refresh({ cards, nodesById }) {
        if (Array.isArray(cards)) this._cards = cards.slice();
        if (nodesById instanceof Map) this._nodesById = nodesById;
        this._renderList();
    }

    // ---------- visible-cards pipeline ----------

    _visibleCards() {
        const filtered = this._cards.filter((c) => matchesQuery(c, this._nodesById, this._query));
        filtered.sort((a, b) => comparators(a, b, this._sortBy));
        return filtered;
    }

    // ---------- rendering ----------

    _renderList() {
        const cards = this._visibleCards();
        this._elements.reviewBtn.disabled = cards.length === 0;

        if (this._cards.length === 0) {
            this._elements.body.innerHTML = `<div class="fc-empty">No flashcards yet.</div>`;
            this._elements.footer.textContent = '';
            return;
        }
        if (cards.length === 0) {
            this._elements.body.innerHTML = `<div class="fc-empty">No cards match your search.</div>`;
            this._elements.footer.textContent = `0 of ${this._cards.length} cards`;
            return;
        }

        this._elements.body.innerHTML = cards.map((c) => this._rowHTML(c)).join('');
        this._elements.footer.textContent = `${cards.length} of ${this._cards.length} cards`;

        if (this._scrollToCardId) {
            const row = this._elements.body.querySelector(`[data-fc-id="${this._scrollToCardId}"]`);
            row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            this._scrollToCardId = null;
        }
    }

    _rowHTML(card) {
        const level = card.cognitiveLevel ?? 1;
        const box = Number.isFinite(card.srsBox) ? card.srsBox : 0;
        const band = bandFor(card);
        const due = dueLabel(card);
        const expanded = this._expandedIds.has(card.id);
        const nodes = nodeNames(card, this._nodesById);
        const nodesLine = nodes.length === 0
            ? '<span class="fc-nodes fc-nodes-empty">no linked nodes</span>'
            : `<span class="fc-nodes">${nodes.map(ESCAPE).join(', ')}</span>`;

        const optionsHTML = expanded && Array.isArray(card.options)
            ? `<ol class="fc-options">${
                card.options.map((o, i) => `
                    <li class="${i === card.correctIndex ? 'fc-opt fc-opt-correct' : 'fc-opt'}">${ESCAPE(o)}</li>
                `).join('')
            }</ol>` : '';

        const explanationHTML = expanded && card.explanation
            ? `<p class="fc-explanation">${ESCAPE(card.explanation)}</p>` : '';

        const actionsHTML = expanded
            ? `<div class="fc-row-actions">
                   <button class="btn btn-secondary fc-jump-btn" data-action="jump">Jump to passage</button>
                   <button class="btn btn-danger fc-delete-btn" data-action="delete">Delete</button>
               </div>` : '';

        return `
            <div class="fc-row ${expanded ? 'expanded' : ''}" data-fc-id="${ESCAPE(card.id)}">
                <div class="fc-row-summary" data-action="toggle">
                    <span class="srs-level-chip srs-level-${level}">L${level}</span>
                    <span class="fc-box-badge" style="background-color: ${bandColor(band)}">Box ${box}</span>
                    <span class="fc-due">${ESCAPE(due)}</span>
                    <span class="fc-question">${ESCAPE(card.question ?? '')}</span>
                    ${nodesLine}
                </div>
                ${optionsHTML}
                ${explanationHTML}
                ${actionsHTML}
            </div>
        `;
    }

    // ---------- row interactions ----------

    _onBodyClick(e) {
        const row = e.target.closest('.fc-row');
        if (!row) return;
        const id = row.dataset.fcId;
        const card = this._cards.find((c) => c.id === id);
        if (!card) return;

        const actionEl = e.target.closest('[data-action]');
        const action = actionEl?.dataset.action;

        if (action === 'jump') {
            this._callbacks.onJumpToPassage?.({
                chapterIndex: card.primaryChapterIndex,
                sentenceIndex: card.primarySentenceIndex,
                card
            });
            return;
        }
        if (action === 'delete') {
            this._handleDelete(card);
            return;
        }
        // Anything else (including the summary itself) toggles expansion.
        if (this._expandedIds.has(id)) this._expandedIds.delete(id);
        else this._expandedIds.add(id);
        this._renderList();
    }

    async _handleDelete(card) {
        const nodes = nodeNames(card, this._nodesById);
        const ok = await this._confirmAction({
            title: 'Delete flashcard?',
            message: `Permanently remove this card${
                nodes.length ? ` (covering ${nodes.slice(0, 2).join(', ')}${nodes.length > 2 ? '…' : ''})` : ''
            }? This cannot be undone.`,
            confirmLabel: 'Delete',
            danger: true
        });
        if (!ok) return;
        // Optimistic local removal; the host should still call refresh()
        // after persisting the delete to keep us authoritative.
        this._cards = this._cards.filter((c) => c.id !== card.id);
        this._expandedIds.delete(card.id);
        this._renderList();
        this._callbacks.onCardDeleted?.(card);
    }

    // ---------- introspection for tests ----------

    getState() {
        return {
            cardCount: this._cards.length,
            visibleCount: this._visibleCards().length,
            query: this._query,
            sortBy: this._sortBy,
            expandedIds: Array.from(this._expandedIds)
        };
    }
}
