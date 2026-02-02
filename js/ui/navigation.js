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
     * @param {(highlight: Object) => void} callbacks.onHighlightSelect
     * @param {(highlightId: string) => void} callbacks.onHighlightDelete
     */
    constructor(options, callbacks) {
        this._panel = options.panel;
        this._overlay = options.overlay;
        this._menuBtn = options.menuBtn;
        this._callbacks = callbacks;

        this._currentBook = null;
        this._currentChapterIndex = 0;
        this._bookmarks = [];
        this._highlights = [];
        this._quizHistory = []; // Array of { chapterIndex, questions[] }

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
     * Set highlights
     * @param {Object[]} highlights
     */
    setHighlights(highlights) {
        this._highlights = highlights;
        this._renderHighlights();
    }

    /**
     * Set quiz history data
     * @param {Object[]} quizHistory - Array of { chapterIndex, questions[] }
     */
    setQuizHistory(quizHistory) {
        this._quizHistory = quizHistory;
        this._renderQuizHistory();
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
        this._renderHighlights();
        this._renderQuizHistory();
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
     * Render highlights list
     */
    _renderHighlights() {
        const highlightsList = this._panel.querySelector('#highlights-list');
        if (!highlightsList) {
            return;
        }

        if (this._highlights.length === 0) {
            highlightsList.innerHTML = '<div class="nav-empty">No highlights yet</div>';
            return;
        }

        highlightsList.innerHTML = '';

        this._highlights.forEach(highlight => {
            const item = document.createElement('div');
            item.className = 'nav-item highlight-item';

            const chapterTitle = this._currentBook?.chapters[highlight.chapterIndex]?.title || 'Unknown';
            const colorClass = `highlight-color-${highlight.color || 'yellow'}`;
            const truncatedText = highlight.text.length > 80
                ? highlight.text.substring(0, 80) + '...'
                : highlight.text;

            item.innerHTML = `
                <div class="highlight-nav-content">
                    <div class="highlight-color-indicator ${colorClass}"></div>
                    <div class="highlight-nav-details">
                        <div class="highlight-nav-chapter">Ch. ${highlight.chapterIndex + 1}: ${this._escapeHtml(chapterTitle)}</div>
                        <div class="highlight-nav-text">"${this._escapeHtml(truncatedText)}"</div>
                    </div>
                </div>
                <button class="highlight-delete-btn" aria-label="Delete highlight">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"/>
                        <line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                </button>
            `;

            // Click on highlight - navigate
            const content = item.querySelector('.highlight-nav-content');
            content.addEventListener('click', () => {
                this._callbacks.onHighlightSelect?.(highlight);
                this.close();
            });

            // Delete button
            const deleteBtn = item.querySelector('.highlight-delete-btn');
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (confirm('Delete this highlight?')) {
                    this._callbacks.onHighlightDelete?.(highlight.id);
                }
            });

            highlightsList.appendChild(item);
        });
    }

    /**
     * Render quiz history grouped by chapter
     */
    _renderQuizHistory() {
        const historyList = this._panel.querySelector('#quiz-history-list');
        if (!historyList) {
            return;
        }

        if (!this._quizHistory || this._quizHistory.length === 0) {
            historyList.innerHTML = '<div class="nav-empty">No quiz questions yet</div>';
            return;
        }

        historyList.innerHTML = '';

        this._quizHistory.forEach(({ chapterIndex, questions }) => {
            const chapterTitle = this._currentBook?.chapters[chapterIndex]?.title || 'Unknown';

            // Chapter header
            const chapterHeader = document.createElement('div');
            chapterHeader.className = 'quiz-history-chapter';
            chapterHeader.innerHTML = `
                <div class="quiz-history-chapter-title">Ch. ${chapterIndex + 1}: ${this._escapeHtml(chapterTitle)}</div>
            `;
            historyList.appendChild(chapterHeader);

            // Questions for this chapter
            questions.forEach((q, qIndex) => {
                const item = document.createElement('div');
                item.className = 'quiz-history-item';

                const isCorrect = q.wasCorrect !== undefined ? q.wasCorrect : null;
                const resultIcon = isCorrect === true ? '<span class="quiz-history-correct">&#10003;</span>'
                    : isCorrect === false ? '<span class="quiz-history-incorrect">&#10007;</span>'
                    : '';

                let answerHtml = '';
                if (q.options && q.correctIndex !== undefined) {
                    // Multiple choice - show correct answer
                    const correctOption = q.options[q.correctIndex];
                    answerHtml = `<div class="quiz-history-answer"><strong>Answer:</strong> ${this._escapeHtml(correctOption)}</div>`;
                } else if (q.explanation) {
                    answerHtml = `<div class="quiz-history-answer"><strong>Answer:</strong> ${this._escapeHtml(q.explanation)}</div>`;
                }

                item.innerHTML = `
                    <div class="quiz-history-question">
                        ${resultIcon}
                        <span class="quiz-history-q-num">${qIndex + 1}.</span>
                        ${this._escapeHtml(q.question)}
                    </div>
                    ${answerHtml}
                `;

                historyList.appendChild(item);
            });
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
