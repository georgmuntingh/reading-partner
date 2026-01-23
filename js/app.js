/**
 * Reading Partner - Main Application
 * EPUB TTS Reader with Q&A capabilities
 */

import { epubParser } from './services/epub-parser.js';
import { ttsEngine } from './services/tts-engine.js';
import { AudioController } from './controllers/audio-controller.js';
import { ReaderView } from './ui/reader-view.js';
import { PlaybackControls } from './ui/controls.js';

class ReadingPartnerApp {
    constructor() {
        // State
        this._currentBook = null;
        this._currentChapterIndex = 0;
        this._isInitialized = false;

        // DOM Elements
        this._elements = {};

        // Components
        this._readerView = null;
        this._controls = null;
        this._audioController = null;
    }

    /**
     * Initialize the application
     */
    async init() {
        this._cacheElements();
        this._setupUploadHandlers();
        this._setupKeyboardShortcuts();

        // Show TTS loading status
        this._showTTSStatus('Initializing TTS engine...');

        // Initialize TTS engine in background
        ttsEngine.onProgress((progress) => {
            this._showTTSStatus(progress.status);
        });

        try {
            const usingKokoro = await ttsEngine.initialize();
            if (usingKokoro) {
                this._showTTSStatus('TTS ready (Kokoro)');
            } else {
                this._showTTSStatus('TTS ready (Browser)');
            }
            setTimeout(() => this._hideTTSStatus(), 2000);
        } catch (error) {
            console.error('TTS initialization failed:', error);
            this._showTTSStatus('TTS initialization failed');
        }

        this._isInitialized = true;
        console.log('Reading Partner initialized');
    }

    /**
     * Cache DOM elements
     */
    _cacheElements() {
        this._elements = {
            // Screens
            uploadScreen: document.getElementById('upload-screen'),
            readerScreen: document.getElementById('reader-screen'),

            // Upload
            uploadArea: document.getElementById('upload-area'),
            fileInput: document.getElementById('file-input'),
            browseBtn: document.getElementById('browse-btn'),
            loadingIndicator: document.getElementById('loading-indicator'),
            loadingText: document.getElementById('loading-text'),

            // Reader
            bookTitle: document.getElementById('book-title'),
            chapterTitle: document.getElementById('chapter-title'),
            readerContent: document.getElementById('reader-content'),
            textContent: document.getElementById('text-content'),

            // Controls
            playBtn: document.getElementById('play-btn'),
            playIcon: document.getElementById('play-icon'),
            pauseIcon: document.getElementById('pause-icon'),
            prevBtn: document.getElementById('prev-btn'),
            nextBtn: document.getElementById('next-btn'),
            back2Btn: document.getElementById('back-2-btn'),
            askBtn: document.getElementById('ask-btn'),
            speedSlider: document.getElementById('speed-slider'),
            speedValue: document.getElementById('speed-value'),

            // Status
            ttsStatus: document.getElementById('tts-status')
        };
    }

    /**
     * Setup file upload handlers
     */
    _setupUploadHandlers() {
        const { uploadArea, fileInput, browseBtn } = this._elements;

        // Browse button
        browseBtn.addEventListener('click', () => {
            fileInput.click();
        });

        // File input change
        fileInput.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (file) {
                this._loadBook(file);
            }
        });

        // Drag and drop
        uploadArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadArea.classList.add('dragover');
        });

        uploadArea.addEventListener('dragleave', () => {
            uploadArea.classList.remove('dragover');
        });

        uploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadArea.classList.remove('dragover');

            const file = e.dataTransfer?.files?.[0];
            if (file) {
                this._loadBook(file);
            }
        });

        // Click on upload area
        uploadArea.addEventListener('click', (e) => {
            if (e.target === uploadArea || e.target.closest('.upload-icon')) {
                fileInput.click();
            }
        });
    }

    /**
     * Setup keyboard shortcuts
     */
    _setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Only handle shortcuts when reader is visible
            if (!this._elements.readerScreen.classList.contains('active')) {
                return;
            }

            switch (e.code) {
                case 'Space':
                    e.preventDefault();
                    this._togglePlayPause();
                    break;
                case 'ArrowLeft':
                    e.preventDefault();
                    this._audioController?.skipBackward(1);
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    this._audioController?.skipForward();
                    break;
                case 'KeyB':
                    e.preventDefault();
                    this._audioController?.skipBackward(2);
                    break;
            }
        });
    }

    /**
     * Load a book from file
     * @param {File} file
     */
    async _loadBook(file) {
        const { loadingIndicator, loadingText } = this._elements;

        try {
            // Show loading
            loadingIndicator.classList.remove('hidden');
            loadingText.textContent = 'Parsing EPUB...';

            // Parse EPUB
            this._currentBook = await epubParser.loadFromFile(file);

            if (!this._currentBook.chapters.length) {
                throw new Error('No readable content found in this EPUB');
            }

            loadingText.textContent = 'Preparing reader...';

            // Initialize reader components
            this._initializeReader();

            // Load first chapter
            this._loadChapter(0);

            // Switch to reader screen
            this._showScreen('reader');

        } catch (error) {
            console.error('Failed to load book:', error);
            this._showUploadError(error.message);
        } finally {
            loadingIndicator.classList.add('hidden');
        }
    }

    /**
     * Initialize reader components
     */
    _initializeReader() {
        // Initialize ReaderView
        this._readerView = new ReaderView({
            container: this._elements.readerContent,
            titleElement: this._elements.chapterTitle,
            bookTitleElement: this._elements.bookTitle,
            onSentenceClick: (index) => {
                this._audioController?.goToSentence(index);
            }
        });

        // Initialize AudioController
        this._audioController = new AudioController({
            onSentenceChange: (index) => {
                this._readerView.highlightSentence(index);
            },
            onStateChange: (state) => {
                this._controls.setPlaying(state.status === 'playing');
            },
            onChapterEnd: () => {
                this._onChapterEnd();
            }
        });

        // Initialize Controls
        this._controls = new PlaybackControls(
            {
                playBtn: this._elements.playBtn,
                playIcon: this._elements.playIcon,
                pauseIcon: this._elements.pauseIcon,
                prevBtn: this._elements.prevBtn,
                nextBtn: this._elements.nextBtn,
                back2Btn: this._elements.back2Btn,
                askBtn: this._elements.askBtn,
                speedSlider: this._elements.speedSlider,
                speedValue: this._elements.speedValue
            },
            {
                onPlay: () => this._play(),
                onPause: () => this._pause(),
                onPrev: () => this._audioController.skipBackward(1),
                onNext: () => this._audioController.skipForward(),
                onBack2: () => this._audioController.skipBackward(2),
                onAsk: () => this._startQA(),
                onSpeedChange: (speed) => this._audioController.setSpeed(speed)
            }
        );

        // Set book title
        this._readerView.setBookTitle(this._currentBook.title);

        // Enable controls
        this._controls.setEnabled(true);

        // Disable Ask button for now (Phase 3)
        this._controls.setAskDisabled(true);
    }

    /**
     * Load a chapter
     * @param {number} chapterIndex
     */
    _loadChapter(chapterIndex) {
        if (!this._currentBook || chapterIndex < 0 || chapterIndex >= this._currentBook.chapters.length) {
            return;
        }

        this._currentChapterIndex = chapterIndex;
        const chapter = this._currentBook.chapters[chapterIndex];

        // Update UI
        this._readerView.setChapterTitle(chapter.title);
        this._readerView.renderSentences(chapter.sentences, 0);
        this._readerView.scrollToTop();

        // Update audio controller
        this._audioController.setSentences(chapter.sentences, 0);
    }

    /**
     * Handle chapter end
     */
    _onChapterEnd() {
        // Auto-advance to next chapter if available
        if (this._currentChapterIndex < this._currentBook.chapters.length - 1) {
            this._loadChapter(this._currentChapterIndex + 1);
            // Auto-play next chapter
            setTimeout(() => this._play(), 500);
        } else {
            // End of book
            console.log('End of book reached');
        }
    }

    /**
     * Play
     */
    async _play() {
        if (!this._audioController) return;

        // Ensure TTS is ready
        if (!ttsEngine.isReady()) {
            this._showTTSStatus('Initializing TTS...');
            await ttsEngine.initialize();
            this._hideTTSStatus();
        }

        this._audioController.play();
    }

    /**
     * Pause
     */
    _pause() {
        this._audioController?.pause();
    }

    /**
     * Toggle play/pause
     */
    _togglePlayPause() {
        const state = this._audioController?.getState();
        if (state?.status === 'playing') {
            this._pause();
        } else {
            this._play();
        }
    }

    /**
     * Start Q&A mode (placeholder for Phase 3)
     */
    _startQA() {
        console.log('Q&A mode - not implemented yet');
        alert('Q&A mode will be available in a future update!');
    }

    /**
     * Show a screen
     * @param {'upload'|'reader'} screen
     */
    _showScreen(screen) {
        this._elements.uploadScreen.classList.remove('active');
        this._elements.readerScreen.classList.remove('active');

        if (screen === 'upload') {
            this._elements.uploadScreen.classList.add('active');
        } else {
            this._elements.readerScreen.classList.add('active');
        }
    }

    /**
     * Show upload error
     * @param {string} message
     */
    _showUploadError(message) {
        // Remove existing error
        const existingError = this._elements.uploadScreen.querySelector('.error-message');
        if (existingError) {
            existingError.remove();
        }

        // Create error element
        const errorDiv = document.createElement('div');
        errorDiv.className = 'error-message';
        errorDiv.innerHTML = `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <span>${message}</span>
        `;

        // Insert after upload area
        this._elements.uploadArea.insertAdjacentElement('afterend', errorDiv);

        // Auto-remove after 5 seconds
        setTimeout(() => {
            errorDiv.remove();
        }, 5000);
    }

    /**
     * Show TTS status
     * @param {string} message
     */
    _showTTSStatus(message) {
        const status = this._elements.ttsStatus;
        status.querySelector('p').textContent = message;
        status.classList.remove('hidden');
    }

    /**
     * Hide TTS status
     */
    _hideTTSStatus() {
        this._elements.ttsStatus.classList.add('hidden');
    }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    const app = new ReadingPartnerApp();
    app.init();

    // Expose for debugging
    window.readingPartner = app;
});
