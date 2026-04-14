/**
 * LookupSelection
 *
 * Reusable helper that watches text selection inside a given container and
 * shows a small floating toolbar with a single "look up" button. When the
 * button is tapped, it invokes a callback with the selected text and the
 * surrounding context (the textContent of the nearest [data-lookup-context]
 * ancestor, falling back to the container).
 *
 * Used in quiz mode to let the user select an unfamiliar word in the
 * question, an MC option, or the feedback text and look it up.
 */
export class LookupSelection {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.container - Root element to watch for selection
     * @param {(text: string, context: string) => void} options.onLookup
     */
    constructor({ container, onLookup }) {
        this._container = container;
        this._onLookup = onLookup;
        this._toolbar = null;
        this._hideTimeout = null;

        this._onSelectionChange = this._onSelectionChange.bind(this);
        this._onMouseDownOutside = this._onMouseDownOutside.bind(this);
        this._suppressContextMenu = this._suppressContextMenu.bind(this);

        this._buildToolbar();
        this._attachListeners();
    }

    _buildToolbar() {
        const toolbar = document.createElement('div');
        toolbar.className = 'lookup-selection-toolbar hidden';
        toolbar.innerHTML = `
            <button class="lookup-selection-btn" title="Look up" aria-label="Look up">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="11" cy="11" r="8"/>
                    <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
            </button>
        `;
        document.body.appendChild(toolbar);
        this._toolbar = toolbar;

        // Prevent text deselection on toolbar mousedown
        toolbar.addEventListener('mousedown', (e) => e.preventDefault());

        toolbar.addEventListener('click', (e) => {
            const btn = e.target.closest('.lookup-selection-btn');
            if (btn) {
                this._triggerLookup();
            }
        });
    }

    _attachListeners() {
        document.addEventListener('selectionchange', this._onSelectionChange);
        document.addEventListener('mousedown', this._onMouseDownOutside);
        document.addEventListener('contextmenu', this._suppressContextMenu);
    }

    _onSelectionChange() {
        const selection = window.getSelection();

        if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
            this._hideTimeout = setTimeout(() => this._hide(), 200);
            return;
        }

        const range = selection.getRangeAt(0);
        if (!this._container.contains(range.startContainer) ||
            !this._container.contains(range.endContainer)) {
            return;
        }

        if (this._hideTimeout) {
            clearTimeout(this._hideTimeout);
            this._hideTimeout = null;
        }

        this._show(range.getBoundingClientRect());
    }

    _onMouseDownOutside(e) {
        if (!this._toolbar.contains(e.target) && !this._container.contains(e.target)) {
            this._hide();
        }
    }

    _suppressContextMenu(e) {
        if (this._container.contains(e.target) || this._toolbar.contains(e.target)) {
            e.preventDefault();
        }
    }

    _show(selectionRect) {
        const toolbar = this._toolbar;
        toolbar.classList.remove('hidden');

        const toolbarHeight = toolbar.offsetHeight;
        const toolbarWidth = toolbar.offsetWidth;

        let top = selectionRect.top - toolbarHeight - 8 + window.scrollY;
        let left = selectionRect.left + (selectionRect.width / 2) - (toolbarWidth / 2) + window.scrollX;

        if (top < window.scrollY + 4) {
            top = selectionRect.bottom + 8 + window.scrollY;
        }
        left = Math.max(4, Math.min(left, window.innerWidth - toolbarWidth - 4));

        toolbar.style.top = `${top}px`;
        toolbar.style.left = `${left}px`;
    }

    _hide() {
        this._toolbar.classList.add('hidden');
    }

    _findContextElement(node) {
        let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
        while (el && el !== this._container) {
            if (el.dataset && el.dataset.lookupContext !== undefined) {
                return el;
            }
            el = el.parentElement;
        }
        return this._container;
    }

    _triggerLookup() {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
            return;
        }

        const text = selection.toString().trim();
        if (!text) return;

        const range = selection.getRangeAt(0);
        const contextEl = this._findContextElement(range.startContainer);
        const context = (contextEl?.textContent || '').trim();

        selection.removeAllRanges();
        this._hide();

        this._onLookup?.(text, context);
    }

    destroy() {
        document.removeEventListener('selectionchange', this._onSelectionChange);
        document.removeEventListener('mousedown', this._onMouseDownOutside);
        document.removeEventListener('contextmenu', this._suppressContextMenu);
        if (this._toolbar) {
            this._toolbar.remove();
            this._toolbar = null;
        }
    }
}
