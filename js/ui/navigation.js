/**
 * Navigation Panel UI Component
 * Shows chapters and bookmarks with navigation controls
 */

export class NavigationPanel {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.panel - Navigation panel element
     * @param {HTMLElement} options.overlay - Overlay element
     * @param {HTMLElement} options.menuBtn - Menu button to open panel
     * @param {Object} callbacks
     * @param {(chapterIndex: number) => void} callbacks.onChapterSelect
     * @param {(bookmark: Object) => void} callbacks.onBookmarkSelect
     * @param {(bookmarkId: string) => void} callbacks.onBookmarkDelete
     * @param {() => void} callbacks.onAddBookmark
     */
    constructor(options, callbacks) {
        this._panel = options.panel;
        this._overlay = options.overlay;
        this._menuBtn = options.menuBtn;
        this._callbacks = callbacks;

        this._currentBook = null;
        this._currentChapterIndex = 0;
        this._bookmarks = [];

        this._setupEventListeners();
    }

    /**
     * Setup event listeners
     */
    _setupEventListeners() {
        // Menu button - open panel
        this._menuBtn.addEventListener('click', () => {
            this.open();
        });

        // Overlay - close panel
        this._overlay.addEventListener('click', () => {
            this.close();
        });

        // Close button in panel
        const closeBtn = this._panel.querySelector('.nav-close-btn');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                this.close();
            });
        }

        // Add bookmark button
        const addBookmarkBtn = this._panel.querySelector('#add-bookmark-btn');
        if (addBookmarkBtn) {
            addBookmarkBtn.addEventListener('click', () => {
                this._callbacks.onAddBookmark?.();
            });
        }
    }

    /**
     * Set book data
     * @param {Object} book
     * @param {number} currentChapterIndex
     */
    setBook(book, currentChapterIndex = 0) {
        this._currentBook = book;
        this._currentChapterIndex = currentChapterIndex;
        this.render();
    }

    /**
     * Set bookmarks
     * @param {Object[]} bookmarks
     */
    setBookmarks(bookmarks) {
        this._bookmarks = bookmarks;
        this._renderBookmarks();
    }

    /**
     * Update current chapter
     * @param {number} chapterIndex
     */
    setCurrentChapter(chapterIndex) {
        this._currentChapterIndex = chapterIndex;
        this._renderChapters();
    }

    /**
     * Render the navigation panel
     */
    render() {
        if (!this._currentBook) {
            return;
        }

        this._renderChapters();
        this._renderBookmarks();
    }

    /**
     * Render chapters list
     */
    _renderChapters() {
        const chaptersList = this._panel.querySelector('#chapters-list');
        if (!chaptersList || !this._currentBook) {
            return;
        }

        chaptersList.innerHTML = '';

        this._currentBook.chapters.forEach((chapter, index) => {
            const item = document.createElement('div');
            item.className = 'nav-item';
            if (index === this._currentChapterIndex) {
                item.classList.add('active');
            }

            item.innerHTML = `
                <span class="chapter-number">${index + 1}.</span>
                <span class="chapter-title">${this._escapeHtml(chapter.title)}</span>
            `;

            item.addEventListener('click', () => {
                this._callbacks.onChapterSelect?.(index);
                this.close();
            });

            chaptersList.appendChild(item);
        });
    }

    /**
     * Render bookmarks list
     */
    _renderBookmarks() {
        const bookmarksList = this._panel.querySelector('#bookmarks-list');
        if (!bookmarksList) {
            return;
        }

        if (this._bookmarks.length === 0) {
            bookmarksList.innerHTML = '<div class="nav-empty">No bookmarks yet</div>';
            return;
        }

        bookmarksList.innerHTML = '';

        this._bookmarks.forEach(bookmark => {
            const item = document.createElement('div');
            item.className = 'nav-item bookmark-item';

            const chapterTitle = this._currentBook?.chapters[bookmark.chapterIndex]?.title || 'Unknown';

            item.innerHTML = `
                <div class="bookmark-content">
                    <div class="bookmark-icon">📑</div>
                    <div class="bookmark-details">
                        <div class="bookmark-chapter">Ch. ${bookmark.chapterIndex + 1}: ${this._escapeHtml(chapterTitle)}</div>
                        ${bookmark.note ? `<div class="bookmark-note">${this._escapeHtml(bookmark.note)}</div>` : ''}
                    </div>
                </div>
                <button class="bookmark-delete-btn" aria-label="Delete bookmark">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"/>
                        <line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                </button>
            `;

            // Click on bookmark - navigate
            const content = item.querySelector('.bookmark-content');
            content.addEventListener('click', () => {
                this._callbacks.onBookmarkSelect?.(bookmark);
                this.close();
            });

            // Delete button
            const deleteBtn = item.querySelector('.bookmark-delete-btn');
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (confirm('Delete this bookmark?')) {
                    this._callbacks.onBookmarkDelete?.(bookmark.id);
                }
            });

            bookmarksList.appendChild(item);
        });
    }

    /**
     * Open the navigation panel
     */
    open() {
        this._panel.classList.add('active');
        this._overlay.classList.add('active');
        document.body.style.overflow = 'hidden';
    }

    /**
     * Close the navigation panel
     */
    close() {
        this._panel.classList.remove('active');
        this._overlay.classList.remove('active');
        document.body.style.overflow = '';
    }

    /**
     * Escape HTML to prevent XSS
     * @param {string} text
     * @returns {string}
     */
    _escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}
