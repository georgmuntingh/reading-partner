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

const BOX_COUNT = 6;

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

        this._totalChapters = 0;
        this._chapterTitles = null;
        this._chapterFilter = null;          // null = all chapters
        this._histogram = [];                // cached _computeHistogram() result
        this._tooltip = null;                // lazily-created tooltip element
        this._activeTooltipChapter = null;

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
                        <span class="fc-chapter-chip hidden" id="fc-chapter-chip">
                            <span id="fc-chapter-chip-label"></span>
                            <button type="button" class="fc-chapter-chip-clear" id="fc-chapter-chip-clear" aria-label="Clear chapter filter">×</button>
                        </span>
                        <button class="btn btn-primary fc-review-btn" id="fc-review-btn" disabled>Review Selection</button>
                    </div>
                    <button class="fc-close-btn" id="fc-close-btn" aria-label="Close">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="18" y1="6" x2="6" y2="18"/>
                            <line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </button>
                </div>
                <div class="fc-histogram hidden" id="fc-histogram" aria-label="Card mastery by chapter"></div>
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
            footer: this._container.querySelector('#fc-footer'),
            histogram: this._container.querySelector('#fc-histogram'),
            chapterChip: this._container.querySelector('#fc-chapter-chip'),
            chapterChipLabel: this._container.querySelector('#fc-chapter-chip-label'),
            chapterChipClear: this._container.querySelector('#fc-chapter-chip-clear')
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

        // Histogram interactions (delegated).
        this._elements.histogram.addEventListener('click', (e) => this._onHistogramClick(e));
        this._elements.histogram.addEventListener('mouseover', (e) => this._onHistogramHover(e));
        this._elements.histogram.addEventListener('mouseout', (e) => this._onHistogramOut(e));

        this._elements.chapterChipClear.addEventListener('click', () => this._setChapterFilter(null));
    }

    // ---------- show / hide / refresh ----------

    show({ cards, nodesById, scrollToCardId = null, totalChapters = 0, chapterTitles = null }) {
        this._cards = Array.isArray(cards) ? cards.slice() : [];
        this._nodesById = nodesById instanceof Map ? nodesById : new Map();
        this._scrollToCardId = scrollToCardId;
        this._totalChapters = Math.max(0, Number(totalChapters) || 0);
        this._chapterTitles = Array.isArray(chapterTitles) ? chapterTitles : null;
        this._chapterFilter = null;
        this._updateChapterChip();
        this._renderHistogram();
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
        this._hideTooltip();
    }

    refresh({ cards, nodesById, totalChapters, chapterTitles }) {
        if (Array.isArray(cards)) this._cards = cards.slice();
        if (nodesById instanceof Map) this._nodesById = nodesById;
        if (Number.isFinite(totalChapters)) this._totalChapters = Math.max(0, totalChapters);
        if (Array.isArray(chapterTitles)) this._chapterTitles = chapterTitles;
        this._renderHistogram();
        this._renderList();
    }

    // ---------- visible-cards pipeline ----------

    _visibleCards() {
        const filtered = this._cards.filter((c) => {
            if (!matchesQuery(c, this._nodesById, this._query)) return false;
            if (this._chapterFilter !== null && c.primaryChapterIndex !== this._chapterFilter) return false;
            return true;
        });
        filtered.sort((a, b) => comparators(a, b, this._sortBy));
        return filtered;
    }

    // ---------- chapter histogram ----------

    /**
     * Compute one row per chapter from the full `_cards` set (NOT the
     * search-filtered set). Each row exposes total + per-box + per-level
     * + dueNow counts so the histogram and tooltip can share one pass.
     */
    _computeHistogram(now = Date.now()) {
        const rows = [];
        for (let i = 0; i < this._totalChapters; i++) {
            rows.push({
                chapterIndex: i,
                total: 0,
                byBox: new Array(BOX_COUNT).fill(0),
                byLevel: { 1: 0, 2: 0, 3: 0 },
                dueNow: 0
            });
        }
        for (const card of this._cards) {
            const ci = Number.isFinite(card.primaryChapterIndex) ? card.primaryChapterIndex : -1;
            if (ci < 0 || ci >= rows.length) continue;
            const row = rows[ci];
            row.total += 1;
            const box = Number.isFinite(card.srsBox) ? Math.max(0, Math.min(BOX_COUNT - 1, card.srsBox)) : 0;
            row.byBox[box] += 1;
            const level = (card.cognitiveLevel === 2 || card.cognitiveLevel === 3) ? card.cognitiveLevel : 1;
            row.byLevel[level] += 1;
            if (Number.isFinite(card.nextReviewAt) && card.nextReviewAt <= now) row.dueNow += 1;
        }
        return rows;
    }

    _chapterLabel(i) {
        const title = this._chapterTitles?.[i];
        return title ? String(title) : `Chapter ${i + 1}`;
    }

    _renderHistogram() {
        const panel = this._elements.histogram;
        if (this._totalChapters <= 0) {
            panel.classList.add('hidden');
            panel.innerHTML = '';
            this._histogram = [];
            return;
        }
        // Preserve horizontal scroll so clicks on later chapters don't snap
        // the histogram back to chapter 1 on every re-render.
        const prevBars = panel.querySelector('.fc-bars');
        const prevScrollLeft = prevBars ? prevBars.scrollLeft : 0;

        this._histogram = this._computeHistogram();
        const maxTotal = this._histogram.reduce((m, r) => Math.max(m, r.total), 0);
        const denom = maxTotal > 0 ? maxTotal : 1;

        const bars = this._histogram.map((row) => {
            // Build six segments — Box 0 at top, Box 5 at bottom — so the
            // mastered foundation reads as the base of the bar.
            const segs = [];
            for (let box = BOX_COUNT - 1; box >= 0; box--) {
                const count = row.byBox[box];
                segs.push(`<div class="fc-bar-seg fc-box-${box}" data-count="${count}" style="flex: ${count}"></div>`);
            }
            const heightPct = Math.round((row.total / denom) * 100);
            const selected = this._chapterFilter === row.chapterIndex ? ' fc-bar-selected' : '';
            const empty = row.total === 0 ? ' fc-bar-empty' : '';
            return `
                <div class="fc-bar-col" data-chapter-index="${row.chapterIndex}">
                    <div class="fc-bar-stack-wrap">
                        <div class="fc-bar${selected}${empty}" style="height: ${heightPct}%">
                            ${segs.join('')}
                        </div>
                    </div>
                    <div class="fc-bar-label">${ESCAPE(String(row.chapterIndex + 1))}</div>
                </div>
            `;
        }).join('');

        panel.innerHTML = `<div class="fc-bars">${bars}</div>`;
        panel.classList.remove('hidden');

        if (prevScrollLeft > 0) {
            const nextBars = panel.querySelector('.fc-bars');
            if (nextBars) nextBars.scrollLeft = prevScrollLeft;
        }
    }

    // ---------- chapter filter chip ----------

    _setChapterFilter(chapterIndex) {
        this._chapterFilter = chapterIndex;
        this._updateChapterChip();
        this._renderHistogram();   // re-render so the selected bar highlights
        this._renderList();
    }

    _updateChapterChip() {
        const chip = this._elements.chapterChip;
        const label = this._elements.chapterChipLabel;
        if (this._chapterFilter === null) {
            chip.classList.add('hidden');
            label.textContent = '';
            return;
        }
        label.textContent = this._chapterLabel(this._chapterFilter);
        chip.classList.remove('hidden');
    }

    _onHistogramClick(e) {
        const col = e.target.closest('.fc-bar-col');
        if (!col) return;
        const idx = Number(col.dataset.chapterIndex);
        if (!Number.isFinite(idx)) return;
        // Toggle: clicking the active chapter clears the filter.
        this._setChapterFilter(this._chapterFilter === idx ? null : idx);
    }

    // ---------- tooltip ----------

    _onHistogramHover(e) {
        const col = e.target.closest('.fc-bar-col');
        if (!col) return;
        const idx = Number(col.dataset.chapterIndex);
        if (!Number.isFinite(idx)) return;
        if (this._activeTooltipChapter === idx) return;
        this._activeTooltipChapter = idx;
        const row = this._histogram[idx];
        if (!row) return;
        this._showTooltipFor(col, row);
    }

    _onHistogramOut(e) {
        const col = e.target.closest('.fc-bar-col');
        if (!col) return;
        // mouseout fires when moving between children; only hide when leaving
        // the column entirely (relatedTarget outside this column).
        if (col.contains(e.relatedTarget)) return;
        this._activeTooltipChapter = null;
        this._hideTooltip();
    }

    _ensureTooltip() {
        if (this._tooltip) return this._tooltip;
        const el = document.createElement('div');
        el.className = 'fc-tooltip hidden';
        this._container.appendChild(el);
        this._tooltip = el;
        return el;
    }

    _showTooltipFor(colEl, row) {
        const tip = this._ensureTooltip();
        const title = this._chapterLabel(row.chapterIndex);
        const boxLine = row.byBox
            .map((n, i) => `<span class="fc-tt-box fc-box-${i}" data-count="${n}">B${i}:${n}</span>`)
            .join('');
        tip.innerHTML = `
            <div class="fc-tooltip-title">${ESCAPE(title)}</div>
            <div class="fc-tooltip-total">${row.total} card${row.total === 1 ? '' : 's'} · ${row.dueNow} due now</div>
            <div class="fc-tooltip-levels">L1: ${row.byLevel[1]} · L2: ${row.byLevel[2]} · L3: ${row.byLevel[3]}</div>
            <div class="fc-tooltip-boxes">${boxLine}</div>
            <div class="fc-tooltip-hint">${row.total === 0 ? 'No cards in this chapter.' : 'Click bar to filter the list.'}</div>
        `;
        tip.classList.remove('hidden');

        // Position above the column, clamped inside the modal.
        const colRect = colEl.getBoundingClientRect();
        const containerRect = this._container.getBoundingClientRect();
        const tipRect = tip.getBoundingClientRect();
        let left = colRect.left - containerRect.left + (colRect.width / 2) - (tipRect.width / 2);
        let top = colRect.top - containerRect.top - tipRect.height - 8;
        if (top < 4) top = colRect.bottom - containerRect.top + 8;
        const maxLeft = containerRect.width - tipRect.width - 4;
        if (maxLeft >= 0) left = Math.max(4, Math.min(left, maxLeft));
        tip.style.left = `${left}px`;
        tip.style.top = `${top}px`;
    }

    _hideTooltip() {
        if (this._tooltip) this._tooltip.classList.add('hidden');
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
            expandedIds: Array.from(this._expandedIds),
            chapterFilter: this._chapterFilter,
            totalChapters: this._totalChapters
        };
    }
}
