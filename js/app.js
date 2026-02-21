/**
 * Reading Partner - Main Application
 * EPUB TTS Reader with Q&A capabilities
 */

import { detectFileType, FORMAT_LABELS, ACCEPTED_EXTENSIONS } from './services/parser-factory.js';
import { ttsEngine } from './services/tts-engine.js';
import { storage } from './services/storage.js';
import { llmClient, OPENROUTER_MODELS, DEFAULT_MODEL } from './services/llm-client.js';
import { sttService } from './services/stt-service.js';
import { WhisperSTTService } from './services/whisper-stt-service.js';
import { modelDownloadModal } from './ui/model-download-modal.js';
import { mediaSessionManager } from './services/media-session-manager.js';
import { AudioController } from './controllers/audio-controller.js';
import { QAController, QAState } from './controllers/qa-controller.js';
import { QuizController, QuizState } from './controllers/quiz-controller.js';
import { ReadingStateController } from './state/reading-state.js';
import { ReaderView } from './ui/reader-view.js';
import { PlaybackControls } from './ui/controls.js';
import { NavigationPanel } from './ui/navigation.js';
import { QAOverlay } from './ui/qa-overlay.js';
import { QuizOverlay } from './ui/quiz-overlay.js';
import { SettingsModal } from './ui/settings-modal.js';
import { ImageViewerModal } from './ui/image-viewer-modal.js';
import { BookLoaderModal } from './ui/book-loader-modal.js';
import { ChapterOverview } from './ui/chapter-overview.js';
import { SearchPanel } from './ui/search-panel.js';
import { LookupDrawer } from './ui/lookup-drawer.js';
import { LookupHistoryOverlay } from './ui/lookup-history-overlay.js';
import { lookupService } from './services/lookup-service.js';
import { NavigationHistory } from './state/navigation-history.js';

class ReadingPartnerApp {
    constructor() {
        // State
        this._currentBook = null;
        this._currentChapterIndex = 0;
        this._isInitialized = false;
        this._savedSpeed = undefined;
        this._savedVoice = undefined;
        this._wasPlayingBeforeQA = false;
        this._readingHistorySize = 3;

        // STT backend
        this._sttBackend = 'web-speech';
        this._whisperService = null; // Lazy-initialized
        this._activeSTTService = sttService; // Default: Web Speech API

        // LLM backend
        this._llmBackend = 'openrouter';

        // Q&A Settings
        this._qaSettings = {
            apiKey: '',
            model: DEFAULT_MODEL,
            fullChapterContext: false,
            contextBefore: 20,
            contextAfter: 5
        };

        // Quiz Settings
        this._quizSettings = {
            quizMode: 'multiple-choice',
            quizGuided: true,
            quizChapterScope: 'full',
            quizQuestionTypes: {
                factual: true,
                deeper_understanding: true,
                vocabulary: false,
                inference: false,
                themes: false
            },
            quizSystemPrompt: '',
            // TTS toggles (all off by default)
            quizTtsQuestion: false,
            quizTtsOptions: false,
            quizTtsCorrectness: false,
            quizTtsExplanation: false
        };

        // DOM Elements
        this._elements = {};

        // Components
        this._readingState = null;
        this._readerView = null;
        this._controls = null;
        this._audioController = null;
        this._navigation = null;
        this._qaController = null;
        this._qaOverlay = null;
        this._quizController = null;
        this._quizOverlay = null;
        this._settingsModal = null;
        this._imageViewerModal = null;
        this._bookLoaderModal = null;
        this._chapterOverview = null;
        this._searchPanel = null;
        this._lookupDrawer = null;
        this._lookupHistoryOverlay = null;

        // Navigation history (back/forward)
        this._navigationHistory = null;
        this._viewDecoupled = false; // When true, playback doesn't auto-scroll the view

        // Playback position (tracks where audio is actually playing,
        // independent of what chapter is currently displayed)
        this._playbackChapterIndex = 0;
        this._playbackSentenceIndex = 0;
    }

    /**
     * Initialize the application
     */
    async init() {
        this._cacheElements();
        this._setupUploadHandlers();
        this._setupKeyboardShortcuts();
        this._setupFullscreen();
        this._setupQASetup();

        // Initialize storage and reading state
        this._readingState = new ReadingStateController({
            onPositionChange: (chapterIndex, sentenceIndex) => {
                this._onPositionChange(chapterIndex, sentenceIndex);
            },
            onBookmarksChange: () => {
                this._onBookmarksChange();
            },
            onHighlightsChange: () => {
                this._onHighlightsChange();
            }
        });

        try {
            await this._readingState.init();
        } catch (error) {
            console.error('Storage initialization failed:', error);
        }

        // Initialize navigation panel
        this._navigation = new NavigationPanel(
            {
                panel: document.getElementById('nav-panel'),
                overlay: document.getElementById('nav-overlay'),
                menuBtn: this._elements.menuBtn
            },
            {
                onChapterSelect: (index) => this._navigateToChapter(index),
                onBookmarkSelect: (bookmark) => this._navigateToBookmark(bookmark),
                onBookmarkDelete: (id) => this._deleteBookmark(id),
                onAddBookmark: () => this._addBookmark(),
                onHighlightSelect: (highlight) => this._navigateToHighlight(highlight),
                onHighlightDelete: (id) => this._deleteHighlight(id),
                onViewLookupHistory: () => this._showLookupHistory()
            }
        );

        // Initialize navigation history (back/forward)
        this._navigationHistory = new NavigationHistory({
            maxDepth: 50,
            onChange: () => this._updateNavHistoryButtons()
        });
        this._setupNavHistoryButtons();

        // Initialize Q&A Overlay
        this._qaOverlay = new QAOverlay(
            { container: document.getElementById('qa-overlay') },
            {
                onClose: () => this._closeQAOverlay(),
                onPause: () => this._qaController?.pause(),
                onResume: () => this._qaController?.resume(),
                onStop: () => this._qaController?.stop(),
                onContinueReading: () => this._continueReadingFromQA(),
                onAskAnother: () => this._askAnotherQuestion(),
                onTextSubmit: (text) => this._submitTextQuestion(text),
                onRetryVoice: () => this._retryVoiceInput()
            }
        );

        // Initialize Quiz Overlay
        this._quizOverlay = new QuizOverlay(
            { container: document.getElementById('quiz-overlay') },
            {
                onClose: () => this._closeQuizOverlay(),
                onNextQuestion: () => this._quizController?.nextQuestion(),
                onMCAnswer: (index) => this._quizController?.submitMCAnswer(index),
                onTextAnswer: (text) => this._quizController?.submitFreeFormAnswer(text),
                onVoiceAnswer: () => this._quizController?.submitVoiceAnswer(),
                onSkipToAnswer: () => this._quizController?.skipToAnswer()
            }
        );

        // Initialize Settings Modal
        this._settingsModal = new SettingsModal(
            { container: document.getElementById('settings-modal') },
            {
                onClose: () => this._settingsModal.hide(),
                onSave: (settings) => this._saveQASettings(settings),
                onBackendChange: (backend) => this._onTTSBackendChange(backend),
                onVoiceChange: (voiceId) => this._onVoiceChange(voiceId),
                onSpeedChange: (speed) => this._onSpeedChange(speed),
                onWhisperDownload: (config) => this._downloadWhisperModel(config),
                onLocalLlmDownload: (config) => this._downloadLocalLlmModel(config)
            }
        );

        // Setup settings button
        this._elements.settingsBtn = document.getElementById('settings-btn');
        this._elements.settingsBtn?.addEventListener('click', () => {
            this._settingsModal.setSettings({ readingHistorySize: this._readingHistorySize, lookupLanguage: lookupService.getTargetLanguage(), ...this._qaSettings, ...this._quizSettings });
            this._settingsModal.show();
        });

        // Initialize Lookup Drawer (bottom sheet for word/phrase lookups)
        this._lookupDrawer = new LookupDrawer({
            onPronounce: (phrase, langCode) => lookupService.pronounce(phrase, langCode),
            onShowHistory: () => this._showLookupHistory()
        });

        // Initialize Lookup History Overlay
        this._lookupHistoryOverlay = new LookupHistoryOverlay({
            onPronounce: (phrase, langCode) => lookupService.pronounce(phrase, langCode),
            onDelete: async (id) => {
                await lookupService.deleteLookup(id);
                this._refreshLookupNav();
            }
        });

        // Initialize Image Viewer Modal
        this._imageViewerModal = new ImageViewerModal(
            { container: document.getElementById('image-viewer-modal') },
            {
                onClose: () => this._imageViewerModal.hide()
            }
        );

        // Initialize Book Loader Modal
        this._bookLoaderModal = new BookLoaderModal(
            { container: document.getElementById('book-loader-modal') },
            {
                onClose: () => this._bookLoaderModal.hide(),
                onFileSelect: (file, source) => this._handleFileSelect(file, source),
                onGutenbergLoad: (bookId) => this._handleGutenbergLoad(bookId),
                onResumeBook: (savedState) => this._handleResumeFromModal(savedState),
                onPasteText: (text, format, title) => this._handlePasteText(text, format, title),
                onGenerateText: (text, format, title, meta) => this._handleGenerateText(text, format, title, meta),
                onURLLoad: (url) => this._handleURLLoad(url)
            }
        );

        // Initialize Chapter Overview
        this._chapterOverview = new ChapterOverview(
            { container: document.getElementById('chapter-overview') },
            {
                onClose: () => this._closeChapterOverview(),
                onPageSelect: (pageNum) => this._onOverviewPageSelect(pageNum),
                onChapterSelect: (chapterIndex) => this._onOverviewChapterSelect(chapterIndex)
            }
        );

        // Initialize Search Panel
        this._searchPanel = new SearchPanel(
            { container: document.getElementById('search-panel') },
            {
                onClose: () => this._onSearchClose(),
                onResultSelect: (chapterIndex, sentenceIndex) => this._onSearchResultSelect(chapterIndex, sentenceIndex),
                loadChapter: (chapterIndex) => this._readingState.loadChapter(chapterIndex),
                getBook: () => this._currentBook
            }
        );

        // Setup search button
        this._elements.searchBtn?.addEventListener('click', () => {
            this._toggleSearchPanel();
        });

        // Setup search overlay (dims background)
        const searchOverlay = document.getElementById('search-overlay');
        searchOverlay?.addEventListener('click', () => {
            this._searchPanel.close();
        });

        // Setup page number click to open chapter overview
        this._elements.pageNumber = document.getElementById('page-number');
        this._elements.pageNumber?.addEventListener('click', () => {
            this._openChapterOverview();
        });

        // Setup load book button (header button in reader)
        this._elements.loadBookBtn?.addEventListener('click', () => {
            this._bookLoaderModal.setReadingHistory(this._loadCookieState());
            this._bookLoaderModal.show();
        });

        // Setup select ebook button (start screen)
        this._elements.selectEbookBtn?.addEventListener('click', () => {
            this._bookLoaderModal.setReadingHistory(this._loadCookieState());
            this._bookLoaderModal.show();
        });

        // Load saved settings first so we know the preferred backend
        await this._loadSettings();

        // Check for saved reading state via cookie and show resume option
        this._checkResumeState();

        // Show TTS loading status
        this._showTTSStatus('Detecting TTS backends...');

        // Initialize TTS engine in background
        ttsEngine.onProgress((progress) => {
            this._showTTSStatus(progress.status);
        });

        try {
            // Load saved backend preference
            const savedBackend = await storage.getSetting('ttsBackend');
            const savedFastApiUrl = await storage.getSetting('fastApiUrl');
            const savedKokoroDtype = await storage.getSetting('kokoroDtype');

            if (savedFastApiUrl) {
                ttsEngine.setFastApiUrl(savedFastApiUrl);
            }

            if (savedKokoroDtype) {
                ttsEngine.setPreferredDtype(savedKokoroDtype);
            }

            // Check FastAPI availability
            const fastApiAvailable = await ttsEngine.isKokoroFastAPIAvailable();
            this._settingsModal.setFastApiAvailable(fastApiAvailable);
            console.log(`Kokoro FastAPI: ${fastApiAvailable ? 'available' : 'not available'} at ${ttsEngine.getFastApiUrl()}`);

            // Determine which backend to use
            let backend = savedBackend;
            if (!backend) {
                // Auto-detect: prefer FastAPI if available
                backend = fastApiAvailable ? 'kokoro-fastapi' : 'kokoro-js';
            }

            // Initialize with the chosen backend
            const usingKokoro = await ttsEngine.initialize({ backend });
            const activeBackend = ttsEngine.getBackend();

            if (activeBackend === 'kokoro-fastapi') {
                this._showTTSStatus('TTS ready (Kokoro FastAPI)');
                console.log(`TTS Engine: Kokoro FastAPI at ${ttsEngine.getFastApiUrl()}`);
            } else if (usingKokoro) {
                const device = ttsEngine.getDevice();
                const dtype = ttsEngine.getDtype();
                this._showTTSStatus(`TTS ready (${device}, ${dtype})`);
                console.log(`TTS Engine: Kokoro with ${device} backend, ${dtype} precision`);
            } else {
                this._showTTSStatus('TTS ready (Browser)');
            }

            // Update settings modal to reflect actual backend
            this._settingsModal.setSettings({
                ...this._settingsModal.getSettings(),
                ttsBackend: activeBackend,
                fastApiUrl: ttsEngine.getFastApiUrl()
            });

            setTimeout(() => this._hideTTSStatus(), 3000);
        } catch (error) {
            console.error('TTS initialization failed:', error);
            this._showTTSStatus('TTS initialization failed');
        }

        this._isInitialized = true;
        console.log('Reading Partner initialized');
        console.log('Tip: Run readingPartner.runBenchmark() to test TTS performance');
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
            selectEbookBtn: document.getElementById('select-ebook-btn'),
            loadingIndicator: document.getElementById('loading-indicator'),
            loadingText: document.getElementById('loading-text'),

            // Q&A Setup on welcome screen
            qaSetupDetails: document.getElementById('qa-setup-details'),
            qaSetupStatus: document.getElementById('qa-setup-status'),
            setupApiKey: document.getElementById('setup-api-key'),
            setupModel: document.getElementById('setup-model'),
            setupFreeModels: document.getElementById('setup-free-models'),
            setupPaidModels: document.getElementById('setup-paid-models'),
            saveQaSetupBtn: document.getElementById('save-qa-setup-btn'),

            // Reader
            menuBtn: document.getElementById('menu-btn'),
            settingsBtn: document.getElementById('settings-btn'),
            bookTitle: document.getElementById('book-title'),
            chapterTitle: document.getElementById('chapter-title'),
            readerContent: document.getElementById('reader-content'),
            textContent: document.getElementById('text-content'),
            pageContainer: document.getElementById('page-container'),
            pagePrevBtn: document.getElementById('page-prev-btn'),
            pageNextBtn: document.getElementById('page-next-btn'),
            pageCurrent: document.getElementById('page-current'),
            pageTotal: document.getElementById('page-total'),

            // Controls
            playBtn: document.getElementById('play-btn'),
            playIcon: document.getElementById('play-icon'),
            pauseIcon: document.getElementById('pause-icon'),
            prevBtn: document.getElementById('prev-btn'),
            nextBtn: document.getElementById('next-btn'),
            prevChapterBtn: document.getElementById('prev-chapter-btn'),
            nextChapterBtn: document.getElementById('next-chapter-btn'),
            askBtn: document.getElementById('ask-btn'),
            quizBtn: document.getElementById('quiz-btn'),
            fullscreenBtn: document.getElementById('fullscreen-btn'),
            fullscreenExpandIcon: document.getElementById('fullscreen-expand-icon'),
            fullscreenCollapseIcon: document.getElementById('fullscreen-collapse-icon'),

            // Header actions
            searchBtn: document.getElementById('search-btn'),
            loadBookBtn: document.getElementById('load-book-btn'),

            // Navigation history buttons
            navBackBtn: document.getElementById('nav-back-btn'),
            navForwardBtn: document.getElementById('nav-forward-btn'),
            navHomeBtn: document.getElementById('nav-home-btn'),

            // Status
            ttsStatus: document.getElementById('tts-status')
        };
    }

    /**
     * Setup file upload handlers (drag-and-drop on start screen)
     */
    _setupUploadHandlers() {
        const { uploadArea, fileInput } = this._elements;

        // File input change (used by drag-drop)
        fileInput.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (file) {
                const source = { type: 'local', filename: file.name };
                this._loadBook(file, source);
            }
            // Reset file input
            e.target.value = '';
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
                const source = { type: 'local', filename: file.name };
                this._loadBook(file, source);
            }
        });
    }

    /**
     * Handle file selection from the book loader modal
     * @param {File} file
     * @param {Object} source
     */
    async _handleFileSelect(file, source) {
        const isFromReader = this._elements.readerScreen.classList.contains('active');

        if (isFromReader) {
            // Stop any current playback
            this._pause();

            // Stop Q&A if active
            this._qaController?.stop();
            this._qaOverlay?.hide();

            // Stop Quiz if active
            this._quizController?.stop();
            this._quizOverlay?.hide();

            // Reset Q&A controller book metadata
            if (this._qaController) {
                this._qaController.setBookMeta(null);
                this._qaController.clearHistory();
            }

            // Reset quiz session
            this._quizController?.resetSession();

            // Reset chapter index
            this._currentChapterIndex = 0;
        }

        // Hide the modal
        this._bookLoaderModal.hide();

        // Load the book
        await this._loadBook(file, source);
    }

    /**
     * Handle pasted text from the book loader modal
     * @param {string} text
     * @param {string} format
     * @param {string} title
     */
    async _handlePasteText(text, format, title) {
        const isFromReader = this._elements.readerScreen.classList.contains('active');

        if (isFromReader) {
            this._pause();
            this._qaController?.stop();
            this._qaOverlay?.hide();
            this._quizController?.stop();
            this._quizOverlay?.hide();
            if (this._qaController) {
                this._qaController.setBookMeta(null);
                this._qaController.clearHistory();
            }
            this._quizController?.resetSession();
            this._currentChapterIndex = 0;
        }

        // Hide the modal
        this._bookLoaderModal.hide();

        const { loadingIndicator, loadingText } = this._elements;

        try {
            if (isFromReader) {
                this._showTTSStatus('Loading pasted content...');
            } else {
                loadingIndicator.classList.remove('hidden');
                loadingText.textContent = 'Parsing pasted content...';
            }

            this._currentBook = await this._readingState.loadPastedContent(text, format, title);

            if (!this._currentBook.chapters.length) {
                throw new Error('No readable content found in pasted text');
            }

            if (isFromReader) {
                this._showTTSStatus('Preparing reader...');
            } else {
                loadingText.textContent = 'Preparing reader...';
            }

            if (!this._controls) {
                this._initializeReader();
            } else {
                this._readerView.setBookTitle(this._currentBook.title);
                this._controls.setEnabled(true);
                this._controls.setAskDisabled(!this._qaSettings.apiKey, 'Configure API key in Q&A Settings to enable voice questions');
            }

            this._navigationHistory?.clear();
            this._viewDecoupled = false;

            const position = this._readingState.getCurrentPosition();
            await this._loadChapter(position.chapterIndex, false);

            this._navigation.setBook(this._currentBook, position.chapterIndex);
            this._navigation.setBookmarks(this._readingState.getBookmarks());
            this._navigation.setHighlights(this._readingState.getHighlights());
            this._refreshLookupNav();
            this._loadQuizHistory();

            this._showScreen('reader');
            this._saveCookieState();

            if (isFromReader) {
                this._hideTTSStatus();
                this._showToast(`Loaded "${this._currentBook.title}"`);
            }
        } catch (error) {
            console.error('Failed to load pasted content:', error);
            if (isFromReader) {
                this._hideTTSStatus();
                this._showToast(`Failed to load: ${error.message}`);
            } else {
                loadingIndicator.classList.add('hidden');
                this._bookLoaderModal.show();
                this._bookLoaderModal.showError(error.message);
            }
        }
    }

    /**
     * Handle LLM generated text from the book loader modal
     * @param {string} text - The generated content
     * @param {string} format - 'markdown' or 'html'
     * @param {string} title - The generated title
     * @param {Object} meta - Generation metadata (model, language, length, genre, description)
     */
    async _handleGenerateText(text, format, title, meta) {
        const isFromReader = this._elements.readerScreen.classList.contains('active');

        if (isFromReader) {
            this._pause();
            this._qaController?.stop();
            this._qaOverlay?.hide();
            this._quizController?.stop();
            this._quizOverlay?.hide();
            if (this._qaController) {
                this._qaController.setBookMeta(null);
                this._qaController.clearHistory();
            }
            this._quizController?.resetSession();
            this._currentChapterIndex = 0;
        }

        this._bookLoaderModal.hide();

        const { loadingIndicator, loadingText } = this._elements;

        try {
            if (isFromReader) {
                this._showTTSStatus('Loading generated content...');
            } else {
                loadingIndicator.classList.remove('hidden');
                loadingText.textContent = 'Parsing generated content...';
            }

            this._currentBook = await this._readingState.loadPastedContent(text, format, title);

            // Override source metadata to indicate LLM generation
            this._currentBook.source = {
                type: 'llm-generated',
                format,
                model: meta.model,
                language: meta.language,
                length: meta.length,
                genre: meta.genre,
                description: meta.description
            };
            this._currentBook.author = `Generated by ${meta.model}`;
            // Persist updated metadata
            await storage.saveBook(this._currentBook);

            if (!this._currentBook.chapters.length) {
                throw new Error('No readable content found in generated text');
            }

            if (isFromReader) {
                this._showTTSStatus('Preparing reader...');
            } else {
                loadingText.textContent = 'Preparing reader...';
            }

            if (!this._controls) {
                this._initializeReader();
            } else {
                this._readerView.setBookTitle(this._currentBook.title);
                this._controls.setEnabled(true);
                this._controls.setAskDisabled(!this._qaSettings.apiKey, 'Configure API key in Q&A Settings to enable voice questions');
            }

            this._navigationHistory?.clear();
            this._viewDecoupled = false;

            const position = this._readingState.getCurrentPosition();
            await this._loadChapter(position.chapterIndex, false);

            this._navigation.setBook(this._currentBook, position.chapterIndex);
            this._navigation.setBookmarks(this._readingState.getBookmarks());
            this._navigation.setHighlights(this._readingState.getHighlights());
            this._refreshLookupNav();
            this._loadQuizHistory();

            this._showScreen('reader');
            this._saveCookieState();

            if (isFromReader) {
                this._hideTTSStatus();
                this._showToast(`Loaded "${this._currentBook.title}"`);
            }
        } catch (error) {
            console.error('Failed to load generated content:', error);
            if (isFromReader) {
                this._hideTTSStatus();
                this._showToast(`Failed to load: ${error.message}`);
            } else {
                loadingIndicator.classList.add('hidden');
                this._bookLoaderModal.show();
                this._bookLoaderModal.showError(error.message);
            }
        }
    }

    /**
     * Handle Gutenberg load from the book loader modal
     * @param {string} bookId
     */
    async _handleGutenbergLoad(bookId) {
        const isFromReader = this._elements.readerScreen.classList.contains('active');

        if (isFromReader) {
            // Stop any current playback
            this._pause();

            // Stop Q&A if active
            this._qaController?.stop();
            this._qaOverlay?.hide();

            // Stop Quiz if active
            this._quizController?.stop();
            this._quizOverlay?.hide();

            // Reset Q&A controller book metadata
            if (this._qaController) {
                this._qaController.setBookMeta(null);
                this._qaController.clearHistory();
            }

            // Reset quiz session
            this._quizController?.resetSession();

            // Reset chapter index
            this._currentChapterIndex = 0;
        }

        // Show loading in modal
        this._bookLoaderModal.showLoading('Fetching from Project Gutenberg...');

        try {
            this._bookLoaderModal.showLoading('Downloading EPUB...');
            const { file, source } = await this._downloadGutenbergEpub(bookId);

            // Hide modal
            this._bookLoaderModal.hide();

            // Load the book
            await this._loadBook(file, source);

        } catch (error) {
            console.error('Failed to load from Gutenberg:', error);
            this._bookLoaderModal.showError(error.message);
        }
    }

    /**
     * Handle resume book from the book loader modal
     * @param {Object} savedState - Cookie state with bookId, source, etc.
     */
    async _handleResumeFromModal(savedState) {
        const isFromReader = this._elements.readerScreen.classList.contains('active');

        if (isFromReader) {
            this._pause();
            this._qaController?.stop();
            this._qaOverlay?.hide();
            this._quizController?.stop();
            this._quizOverlay?.hide();
            if (this._qaController) {
                this._qaController.setBookMeta(null);
                this._qaController.clearHistory();
            }
            this._quizController?.resetSession();
            this._currentChapterIndex = 0;
        }

        this._bookLoaderModal.hide();
        await this._resumeLastBook(savedState);
    }

    /**
     * Download an EPUB from Project Gutenberg
     * @param {string} gutenbergBookId
     * @returns {Promise<{file: File, source: Object}>}
     */
    async _downloadGutenbergEpub(gutenbergBookId) {
        // Gutenberg EPUB URL patterns (most common first)
        const gutenbergEpubUrls = [
            `https://www.gutenberg.org/cache/epub/${gutenbergBookId}/pg${gutenbergBookId}.epub`,
            `https://www.gutenberg.org/files/${gutenbergBookId}/${gutenbergBookId}-0.epub`,
            `https://www.gutenberg.org/files/${gutenbergBookId}/${gutenbergBookId}.epub`
        ];

        // Multiple CORS proxies for reliability
        const corsProxies = [
            (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
            (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`
        ];

        // Build URL list: try each epub path with each proxy
        const urlsToTry = [];
        for (const epubUrl of gutenbergEpubUrls) {
            for (const proxyFn of corsProxies) {
                urlsToTry.push(proxyFn(epubUrl));
            }
        }

        let lastError = null;

        for (const url of urlsToTry) {
            try {
                const response = await fetch(url);

                if (response.ok) {
                    const blob = await response.blob();

                    if (blob.size < 100) {
                        throw new Error('Downloaded file is too small to be an EPUB');
                    }

                    const file = new File([blob], `gutenberg-${gutenbergBookId}.epub`, { type: 'application/epub+zip' });
                    const source = { type: 'gutenberg', bookId: gutenbergBookId };
                    return { file, source };
                }
            } catch (error) {
                lastError = error;
                console.log(`Failed to load from ${url}:`, error.message);
            }
        }

        throw new Error(
            `Book ${gutenbergBookId} could not be loaded. The book might not be available as EPUB. ` +
            `Try downloading manually from https://www.gutenberg.org/ebooks/${gutenbergBookId}`
        );
    }

    /**
     * Handle URL load from the book loader modal
     * @param {string} url
     */
    async _handleURLLoad(url) {
        const isFromReader = this._elements.readerScreen.classList.contains('active');

        if (isFromReader) {
            this._pause();
            this._qaController?.stop();
            this._qaOverlay?.hide();
            this._quizController?.stop();
            this._quizOverlay?.hide();
            if (this._qaController) {
                this._qaController.setBookMeta(null);
                this._qaController.clearHistory();
            }
            this._quizController?.resetSession();
            this._currentChapterIndex = 0;
        }

        this._bookLoaderModal.showLoading('Fetching from URL...');

        try {
            const { file, source } = await this._downloadFromURL(url);
            this._bookLoaderModal.hide();
            await this._loadBook(file, source);
        } catch (error) {
            console.error('Failed to load from URL:', error);
            this._bookLoaderModal.showError(error.message);
        }
    }

    /**
     * Download content from a URL using CORS proxies.
     * Auto-detects content type from response headers and URL extension.
     * @param {string} url
     * @returns {Promise<{file: File, source: Object}>}
     */
    async _downloadFromURL(url) {
        const corsProxies = [
            (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
            (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`
        ];

        let lastError = null;

        for (const proxyFn of corsProxies) {
            try {
                const proxiedUrl = proxyFn(url);
                const response = await fetch(proxiedUrl);

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                const blob = await response.blob();
                if (blob.size < 50) {
                    throw new Error('Downloaded content is too small');
                }

                // Determine content type from response headers, URL, and content
                const contentType = response.headers.get('content-type') || '';
                const { extension, mimeType } = this._detectContentType(url, contentType, blob);

                // Extract a filename from the URL
                const urlPath = new URL(url).pathname;
                const urlFilename = urlPath.split('/').pop() || 'document';
                const filename = urlFilename.includes('.') ? urlFilename : `${urlFilename}${extension}`;

                const file = new File([blob], filename, { type: mimeType });
                const source = { type: 'url', url };
                return { file, source };
            } catch (error) {
                lastError = error;
                console.log(`Failed to load from URL via proxy:`, error.message);
            }
        }

        throw new Error(
            `Could not load content from URL. ${lastError?.message || 'All proxies failed.'}` +
            ` The server may block cross-origin requests.`
        );
    }

    /**
     * Detect content type from URL extension and response Content-Type header.
     * @param {string} url
     * @param {string} contentType - Response Content-Type header
     * @param {Blob} blob - Response body
     * @returns {{ extension: string, mimeType: string }}
     */
    _detectContentType(url, contentType, blob) {
        const lower = url.toLowerCase();
        const ct = contentType.toLowerCase();

        // Check URL extension first (most reliable for direct file links)
        if (lower.endsWith('.pdf') || ct.includes('application/pdf')) {
            return { extension: '.pdf', mimeType: 'application/pdf' };
        }
        if (lower.endsWith('.epub') || ct.includes('application/epub')) {
            return { extension: '.epub', mimeType: 'application/epub+zip' };
        }
        if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
            return { extension: '.md', mimeType: 'text/markdown' };
        }
        if (lower.endsWith('.html') || lower.endsWith('.htm')) {
            return { extension: '.html', mimeType: 'text/html' };
        }

        // Fall back to Content-Type header
        if (ct.includes('text/markdown')) {
            return { extension: '.md', mimeType: 'text/markdown' };
        }
        if (ct.includes('text/html') || ct.includes('application/xhtml')) {
            return { extension: '.html', mimeType: 'text/html' };
        }
        if (ct.includes('text/plain')) {
            // Could be markdown without proper MIME — check URL for hints
            return { extension: '.html', mimeType: 'text/html' };
        }

        // Default to HTML (most URLs without extensions are web pages)
        return { extension: '.html', mimeType: 'text/html' };
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

            // Ctrl+F / Cmd+F: Toggle search (works even when typing)
            if ((e.ctrlKey || e.metaKey) && e.code === 'KeyF') {
                e.preventDefault();
                this._toggleSearchPanel();
                return;
            }

            // Escape: Close search panel if open
            if (e.code === 'Escape' && this._searchPanel?.isOpen()) {
                e.preventDefault();
                this._searchPanel.close();
                document.getElementById('search-overlay')?.classList.remove('active');
                return;
            }

            // Don't handle shortcuts when typing in input fields
            const activeElement = document.activeElement;
            const isTyping = activeElement && (
                activeElement.tagName === 'INPUT' ||
                activeElement.tagName === 'TEXTAREA' ||
                activeElement.isContentEditable
            );
            if (isTyping) {
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
                    this._navigateToPrevChapter();
                    break;
                case 'KeyN':
                    e.preventDefault();
                    this._navigateToNextChapter();
                    break;
                case 'PageUp':
                    e.preventDefault();
                    if (e.shiftKey) {
                        this._navigateToPrevChapter();
                    } else {
                        const movedPrev = this._readerView?.previousPage();
                        if (!movedPrev) {
                            this._navigateToPrevChapter({ goToLastPage: true });
                        }
                    }
                    break;
                case 'PageDown':
                    e.preventDefault();
                    if (e.shiftKey) {
                        this._navigateToNextChapter();
                    } else {
                        const movedNext = this._readerView?.nextPage();
                        if (!movedNext) {
                            this._navigateToNextChapter();
                        }
                    }
                    break;
                case 'Home':
                    e.preventDefault();
                    if (e.shiftKey) {
                        this._navigateToChapter(0);
                    } else {
                        this._readerView?.firstPage();
                    }
                    break;
                case 'End':
                    e.preventDefault();
                    if (e.shiftKey) {
                        const lastChapter = (this._currentBook?.chapters?.length || 1) - 1;
                        this._navigateToChapter(lastChapter);
                    } else {
                        this._readerView?.lastPage();
                    }
                    break;
                case 'KeyF':
                    e.preventDefault();
                    this._toggleFullscreen();
                    break;
            }
        });
    }

    /**
     * Setup fullscreen toggle button and event listeners
     */
    _setupFullscreen() {
        const { fullscreenBtn } = this._elements;
        if (!fullscreenBtn) return;

        // Hide button if Fullscreen API is not supported
        const fsEnabled = document.fullscreenEnabled || document.webkitFullscreenEnabled;
        if (!fsEnabled) {
            fullscreenBtn.style.display = 'none';
            return;
        }

        fullscreenBtn.addEventListener('click', () => {
            this._toggleFullscreen();
        });

        // Listen for fullscreen change to update icon
        const updateIcon = () => this._updateFullscreenIcon();
        document.addEventListener('fullscreenchange', updateIcon);
        document.addEventListener('webkitfullscreenchange', updateIcon);
    }

    /**
     * Toggle fullscreen mode
     */
    async _toggleFullscreen() {
        const fsElement = document.fullscreenElement || document.webkitFullscreenElement;

        try {
            if (fsElement) {
                if (document.exitFullscreen) {
                    await document.exitFullscreen();
                } else if (document.webkitExitFullscreen) {
                    await document.webkitExitFullscreen();
                }
            } else {
                const el = document.documentElement;
                if (el.requestFullscreen) {
                    await el.requestFullscreen();
                } else if (el.webkitRequestFullscreen) {
                    await el.webkitRequestFullscreen();
                }
            }
        } catch (error) {
            console.warn('Fullscreen toggle failed:', error);
        }
    }

    /**
     * Update fullscreen button icon based on current state
     */
    _updateFullscreenIcon() {
        const { fullscreenExpandIcon, fullscreenCollapseIcon } = this._elements;
        if (!fullscreenExpandIcon || !fullscreenCollapseIcon) return;

        const fsElement = document.fullscreenElement || document.webkitFullscreenElement;
        if (fsElement) {
            fullscreenExpandIcon.classList.add('hidden');
            fullscreenCollapseIcon.classList.remove('hidden');
        } else {
            fullscreenExpandIcon.classList.remove('hidden');
            fullscreenCollapseIcon.classList.add('hidden');
        }
    }

    /**
     * Load a book from file
     * @param {File} file
     * @param {Object} [source] - Source information for persistence
     * @param {string} [existingBookId] - Reuse an existing book ID (for re-downloads)
     */
    async _loadBook(file, source = null, existingBookId = null) {
        const { loadingIndicator, loadingText } = this._elements;
        const isFromReader = this._elements.readerScreen.classList.contains('active');

        try {
            // Show loading feedback
            if (isFromReader) {
                this._showTTSStatus('Loading new book...');
            } else {
                loadingIndicator.classList.remove('hidden');
                const fileType = detectFileType(file.name);
                const label = fileType ? FORMAT_LABELS[fileType] : 'file';
                loadingText.textContent = `Parsing ${label}...`;
            }

            // Parse file and save to storage
            this._currentBook = await this._readingState.loadBook(file, source, existingBookId);

            if (!this._currentBook.chapters.length) {
                throw new Error('No readable content found in this file');
            }

            if (isFromReader) {
                this._showTTSStatus('Preparing reader...');
            } else {
                loadingText.textContent = 'Preparing reader...';
            }

            // Initialize reader components (only once)
            if (!this._controls) {
                this._initializeReader();
            } else {
                // Update for the new book
                this._readerView.setBookTitle(this._currentBook.title);
                this._controls.setEnabled(true);
                this._controls.setAskDisabled(!this._qaSettings.apiKey, 'Configure API key in Q&A Settings to enable voice questions');
            }

            // Clear navigation history for new book
            this._navigationHistory?.clear();
            this._viewDecoupled = false;

            // Get saved position
            const position = this._readingState.getCurrentPosition();

            // Load chapter at saved position
            await this._loadChapter(position.chapterIndex, false);

            // Update navigation
            this._navigation.setBook(this._currentBook, position.chapterIndex);
            this._navigation.setBookmarks(this._readingState.getBookmarks());
            this._navigation.setHighlights(this._readingState.getHighlights());
            this._refreshLookupNav();

            // Load quiz history
            this._loadQuizHistory();

            // Restore sentence position
            if (position.sentenceIndex > 0) {
                this._audioController.goToSentence(position.sentenceIndex);
                this._readerView.highlightSentence(position.sentenceIndex);
                this._playbackSentenceIndex = position.sentenceIndex;
            }

            // Switch to reader screen
            this._showScreen('reader');

            // Save cookie state for resume functionality
            this._saveCookieState();

            if (isFromReader) {
                this._hideTTSStatus();
                this._showToast(`Loaded "${this._currentBook.title}"`);
            }

        } catch (error) {
            console.error('Failed to load book:', error);
            if (isFromReader) {
                this._hideTTSStatus();
                this._showToast(`Failed to load: ${error.message}`);
            } else {
                this._showUploadError(error.message);
            }
        } finally {
            if (!isFromReader) {
                loadingIndicator.classList.add('hidden');
            }
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
            onSentenceClick: async (index) => {
                if (this._viewDecoupled) {
                    // Re-couple: user clicked a sentence in a chapter they
                    // navigated to via search/link, so switch audio to this chapter
                    this._viewDecoupled = false;
                    this._pause();
                    const sentences = await this._readingState.loadChapter(this._currentChapterIndex);
                    this._audioController.setSentences(sentences, 0);
                    this._audioController.goToSentence(index);
                    this._playbackChapterIndex = this._currentChapterIndex;
                    this._playbackSentenceIndex = index;
                    this._readingState.goToChapter(this._currentChapterIndex, index);
                    this._updateNavHistoryButtons();
                } else {
                    this._audioController?.goToSentence(index);
                }
            },
            onLinkClick: (href) => {
                this._handleInternalLink(href);
            },
            onImageClick: (src, alt) => {
                this._imageViewerModal?.show(src, alt);
            },
            onHighlight: (startIndex, endIndex, text, color) => {
                this._addHighlight(startIndex, endIndex, text, color);
            },
            onLookup: (text, sentenceIndex) => {
                this._performLookup(text, sentenceIndex);
            },
            onPrevChapter: () => this._navigateToPrevChapter({ goToLastPage: true }),
            onNextChapter: () => this._navigateToNextChapter()
        });

        // Initialize AudioController
        this._audioController = new AudioController({
            onSentenceChange: (index) => {
                // Track playback position
                this._playbackSentenceIndex = index;

                // When view is decoupled (user pressed back/forward),
                // only update highlight if we're displaying the playback chapter
                if (this._viewDecoupled) {
                    if (this._currentChapterIndex === this._playbackChapterIndex) {
                        this._readerView.highlightSentence(index, false);
                    }
                } else {
                    this._readerView.highlightSentence(index, true);
                }
                // Auto-save position during playback
                if (this._readingState) {
                    this._readingState.updateSentencePosition(index);
                }
            },
            onStateChange: (state) => {
                if (state.status === 'buffering') {
                    this._controls.setBuffering(true);
                } else {
                    this._controls.setPlaying(state.status === 'playing');
                }
                // Update Media Session playback state
                mediaSessionManager.setPlaybackState(state.status);
            },
            onChapterEnd: () => {
                this._onChapterEnd();
            }
        });

        // Initialize Media Session for headset controls
        this._initializeMediaSession();

        // Capture text selection on mousedown before the click clears it.
        // This allows the quiz to use a user's text selection as context.
        this._pendingQuizSelection = null;
        if (this._elements.quizBtn) {
            this._elements.quizBtn.addEventListener('mousedown', () => {
                this._pendingQuizSelection = this._readerView?.getSelectedSentenceTexts() || null;
            });
        }

        // Initialize Controls
        this._controls = new PlaybackControls(
            {
                playBtn: this._elements.playBtn,
                playIcon: this._elements.playIcon,
                pauseIcon: this._elements.pauseIcon,
                prevBtn: this._elements.prevBtn,
                nextBtn: this._elements.nextBtn,
                prevChapterBtn: this._elements.prevChapterBtn,
                nextChapterBtn: this._elements.nextChapterBtn,
                askBtn: this._elements.askBtn,
                quizBtn: this._elements.quizBtn
            },
            {
                onPlay: () => this._play(),
                onPause: () => this._pause(),
                onPrev: () => this._audioController.skipBackward(1),
                onNext: () => this._audioController.skipForward(),
                onPrevChapter: () => this._navigateToPrevChapter(),
                onNextChapter: () => this._navigateToNextChapter(),
                onAsk: () => this._startQA(),
                onQuiz: () => this._startQuiz()
            }
        );

        // Populate available voices in settings modal
        const voices = ttsEngine.getAvailableVoices();
        this._settingsModal.setVoices(voices);

        // Restore saved voice
        if (this._savedVoice) {
            ttsEngine.setVoice(this._savedVoice);
        }

        // Restore saved speed
        if (this._savedSpeed !== undefined) {
            this._audioController.setSpeed(this._savedSpeed);
        }

        // Apply typography settings
        this._applyTypographySettings();

        // Set book title
        this._readerView.setBookTitle(this._currentBook.title);

        // Enable controls
        this._controls.setEnabled(true);

        // Enable/disable Ask and Quiz buttons based on backend availability
        this._updateAskQuizButtons();
    }

    /**
     * Initialize Media Session for headset/media key controls
     *
     * Reading mode:
     * - Single tap (play/pause): Toggle TTS playback
     * - Double tap / Next track: Enter Q&A mode
     *
     * Q&A mode:
     * - Single tap (play/pause): Exit Q&A mode and continue reading
     * - Double tap / Next track: Ask another question
     * - Double tap back / Previous track: Exit Q&A mode and continue reading
     */
    _initializeMediaSession() {
        if (!mediaSessionManager.isSupported()) {
            console.log('Media Session API not supported on this device');
            return;
        }

        mediaSessionManager.initialize({
            onPlay: () => {
                this._play();
            },
            onPause: () => {
                this._pause();
            },
            onEnterQAMode: () => {
                // Only enter Q&A mode if API key is configured
                if (this._qaSettings.apiKey) {
                    this._startQA();
                } else {
                    this._showToast('Q&A not available - configure API key in settings');
                }
            },
            onExitQAMode: () => {
                this._continueReadingFromQA();
            },
            onQAPlayPause: () => {
                this._continueReadingFromQA();
            },
            onQANextQuestion: () => {
                this._askAnotherQuestion();
            }
        });

        console.log('Media Session initialized for headset controls');
    }

    /**
     * Update Media Session metadata with current book and chapter info
     */
    _updateMediaSessionMetadata() {
        if (!this._currentBook) return;

        const chapter = this._currentBook.chapters[this._currentChapterIndex];
        mediaSessionManager.updateMetadata({
            bookTitle: this._currentBook.title,
            chapterTitle: chapter?.title || '',
            author: this._currentBook.author || ''
        });
    }

    /**
     * Load a chapter (lazy loading)
     * @param {number} chapterIndex
     * @param {boolean} [autoSkipEmpty=true] - Skip to next chapter if empty
     */
    async _loadChapter(chapterIndex, autoSkipEmpty = true, { viewOnly = false } = {}) {
        if (!this._currentBook || chapterIndex < 0 || chapterIndex >= this._currentBook.chapters.length) {
            return;
        }

        console.time(`App._loadChapter[${chapterIndex}]`);

        this._currentChapterIndex = chapterIndex;
        const chapter = this._currentBook.chapters[chapterIndex];

        // Show loading state
        this._readerView.setChapterTitle(chapter.title);
        this._readerView.showLoading();

        // Lazy load chapter content
        const sentences = await this._readingState.loadChapter(chapterIndex);

        console.timeEnd(`App._loadChapter[${chapterIndex}]`);

        // Auto-skip truly empty chapters (no text AND no visual content like images)
        if (sentences.length === 0 && autoSkipEmpty) {
            const chapterHtml = this._currentBook.chapters[chapterIndex].html;
            const hasVisualContent = chapterHtml && (
                chapterHtml.includes('<img') ||
                chapterHtml.includes('<svg') ||
                chapterHtml.includes('<image') ||
                chapterHtml.includes('<video') ||
                chapterHtml.includes('<canvas')
            );
            if (!hasVisualContent) {
                console.log(`Chapter ${chapterIndex} is empty, skipping to next...`);
                if (chapterIndex < this._currentBook.chapters.length - 1) {
                    return this._loadChapter(chapterIndex + 1, autoSkipEmpty, { viewOnly });
                } else {
                    this._readerView.showError('No readable content found');
                    return;
                }
            }
        }

        // Get the HTML content (may be null for older cached chapters)
        const html = this._currentBook.chapters[chapterIndex].html || null;

        // Update UI with loaded content - pass HTML for full rendering
        this._readerView.renderSentences(sentences, 0, html);
        this._readerView.scrollToTop();

        // Tell the reader view about chapter boundaries so page-nav buttons
        // can transform into chapter-nav buttons at the edges
        const totalChapters = this._currentBook.chapters.length;
        this._readerView.setChapterBoundaries(chapterIndex <= 0, chapterIndex >= totalChapters - 1);

        // Apply highlights for this chapter
        if (this._readingState) {
            const chapterHighlights = this._readingState.getHighlightsForChapter(chapterIndex);
            this._readerView.setHighlights(chapterHighlights);
        }

        // Only update audio controller when not in view-only mode
        // (view-only is used for back/forward/link navigation where playback continues)
        if (!viewOnly) {
            this._audioController.setSentences(sentences, 0);
            this._playbackChapterIndex = chapterIndex;
            this._playbackSentenceIndex = 0;
        }

        // Update Media Session metadata for headset controls
        this._updateMediaSessionMetadata();
    }

    /**
     * Handle chapter end
     */
    async _onChapterEnd() {
        // Use playback chapter (not displayed chapter, which may differ when view is decoupled)
        const playbackChapter = this._playbackChapterIndex;

        // Auto-advance to next chapter if available
        if (playbackChapter < this._currentBook.chapters.length - 1) {
            const nextChapterIndex = playbackChapter + 1;

            // Update reading state
            this._readingState.goToChapter(nextChapterIndex, 0);

            if (this._viewDecoupled) {
                // View is decoupled: load audio for next chapter without changing the display
                const sentences = await this._readingState.loadChapter(nextChapterIndex);
                this._audioController.setSentences(sentences, 0);
                this._playbackChapterIndex = nextChapterIndex;
                this._playbackSentenceIndex = 0;
            } else {
                // Normal case: load next chapter (updates both display and audio)
                await this._loadChapter(nextChapterIndex);
                this._navigation.setCurrentChapter(nextChapterIndex);
            }

            // Auto-play next chapter
            this._play();
        } else {
            // End of book
            console.log('End of book reached');
            this._showToast('End of book reached');
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
     * Setup Q&A configuration on welcome screen
     */
    _setupQASetup() {
        const { setupFreeModels, setupPaidModels, setupApiKey, setupModel, saveQaSetupBtn } = this._elements;

        // Populate model dropdowns
        if (setupFreeModels && setupPaidModels) {
            OPENROUTER_MODELS.free.forEach(model => {
                const option = document.createElement('option');
                option.value = model.id;
                option.textContent = model.name;
                setupFreeModels.appendChild(option);
            });

            OPENROUTER_MODELS.paid.forEach(model => {
                const option = document.createElement('option');
                option.value = model.id;
                option.textContent = model.name;
                setupPaidModels.appendChild(option);
            });

            // Set default
            if (setupModel) {
                setupModel.value = DEFAULT_MODEL;
            }
        }

        // Save button handler
        saveQaSetupBtn?.addEventListener('click', () => {
            const apiKey = setupApiKey?.value?.trim() || '';
            const model = setupModel?.value || DEFAULT_MODEL;

            this._qaSettings.apiKey = apiKey;
            this._qaSettings.model = model;

            // Update LLM client
            llmClient.setApiKey(apiKey);
            llmClient.setModel(model);

            // Save to storage
            this._saveQASettings(this._qaSettings);

            // Update status display
            this._updateQASetupStatus();

            this._showToast('Q&A settings saved');
        });
    }

    /**
     * Update Q&A setup status display
     */
    _updateQASetupStatus() {
        const { qaSetupStatus, setupApiKey, setupModel } = this._elements;

        if (qaSetupStatus) {
            if (this._qaSettings.apiKey) {
                qaSetupStatus.textContent = 'Configured';
                qaSetupStatus.classList.add('configured');
            } else {
                qaSetupStatus.textContent = 'Not configured';
                qaSetupStatus.classList.remove('configured');
            }
        }

        // Update form fields
        if (setupApiKey) {
            setupApiKey.value = this._qaSettings.apiKey || '';
        }
        if (setupModel) {
            setupModel.value = this._qaSettings.model || DEFAULT_MODEL;
        }
    }

    /**
     * Start Q&A mode
     */
    async _startQA() {
        // Check if API key is configured
        if (!this._qaSettings.apiKey) {
            this._showToast('Please configure Q&A settings first');
            this._settingsModal.setSettings(this._qaSettings);
            this._settingsModal.show();
            return;
        }

        // Remember if we were playing
        this._wasPlayingBeforeQA = this._audioController?.getState()?.status === 'playing';

        // Pause current playback
        this._pause();

        // Initialize Q&A controller if needed
        if (!this._qaController) {
            this._initializeQAController();
        }

        // Update Q&A controller settings
        this._qaController.setContextSettings(
            this._qaSettings.contextBefore,
            this._qaSettings.contextAfter,
            this._qaSettings.fullChapterContext
        );
        // Get speed from saved value or settings modal
        const speed = this._savedSpeed || this._settingsModal?.getSpeed() || 1.0;
        this._qaController.setPlaybackSpeed(speed);

        // Provide book metadata for LLM context
        if (this._currentBook) {
            this._qaController.setBookMeta({
                title: this._currentBook.title,
                author: this._currentBook.author
            });
        }

        // Show overlay
        this._qaOverlay.reset();
        this._qaOverlay.setHistory(this._qaController.getHistory());
        this._qaOverlay.show();

        // Set Q&A mode active for Media Session (headset controls)
        mediaSessionManager.setQAModeActive(true);

        // Start voice Q&A
        if (this._qaController.isSTTSupported()) {
            this._qaController.startVoiceQA();
        } else {
            // STT not supported, show text input
            this._qaOverlay.setState(QAState.IDLE);
            this._qaOverlay.showTextInput();
        }
    }

    /**
     * Initialize Q&A controller
     */
    _initializeQAController() {
        // Ensure LLM client is configured
        llmClient.setApiKey(this._qaSettings.apiKey);
        llmClient.setModel(this._qaSettings.model);

        this._qaController = new QAController({
            readingState: this._readingState,
            sttService: this._activeSTTService,
            onStateChange: (state, data) => {
                this._qaOverlay.setState(state, data);

                // Handle errors - show text input fallback
                if (data?.error && state === QAState.IDLE) {
                    if (data.error.includes('permission') || data.error.includes('Microphone')) {
                        this._qaOverlay.showTextInput();
                    }
                }
            },
            onTranscript: (text) => {
                this._qaOverlay.setTranscript(text);
            },
            onResponse: (text) => {
                this._qaOverlay.setResponse(text);
            },
            onSentenceSpoken: (sentence, index) => {
                // Could be used for highlighting current sentence in response
            },
            onHistoryAdd: (entry) => {
                this._qaOverlay.addHistoryEntry(entry);
            }
        });
    }

    /**
     * Close Q&A overlay
     */
    _closeQAOverlay() {
        this._qaController?.stop();
        this._qaOverlay.hide();

        // Exit Q&A mode for Media Session (headset controls)
        mediaSessionManager.setQAModeActive(false);
    }

    /**
     * Continue reading from Q&A
     */
    _continueReadingFromQA() {
        this._qaController?.stop();
        this._qaOverlay.hide();

        // Exit Q&A mode for Media Session (headset controls)
        mediaSessionManager.setQAModeActive(false);

        // Resume playback if we were playing before
        if (this._wasPlayingBeforeQA) {
            this._play();
        }
    }

    /**
     * Ask another question
     */
    _askAnotherQuestion() {
        this._qaController?.stop();
        this._qaOverlay.reset();
        this._qaOverlay.setHistory(this._qaController?.getHistory() || []);

        // Start new Q&A
        if (this._qaController?.isSTTSupported()) {
            this._qaController.startVoiceQA();
        } else {
            this._qaOverlay.setState(QAState.IDLE);
            this._qaOverlay.showTextInput();
        }
    }

    /**
     * Submit text question
     * @param {string} text
     */
    _submitTextQuestion(text) {
        if (!this._qaController) {
            this._initializeQAController();
        }
        this._qaOverlay.hideTextInput();
        this._qaController.startTextQA(text);
    }

    /**
     * Retry voice input
     */
    async _retryVoiceInput() {
        if (!this._qaController) {
            this._initializeQAController();
        }

        // Request microphone permission first
        const hasPermission = await this._qaController.requestMicPermission();
        if (hasPermission) {
            this._qaOverlay.hideTextInput();
            this._qaController.startVoiceQA();
        } else {
            this._showToast('Microphone permission denied');
        }
    }

    // ========== Quiz Mode ==========

    /**
     * Start quiz mode
     */
    async _startQuiz() {
        if (!this._qaSettings.apiKey) {
            this._showToast('Please configure API key in Settings first');
            this._settingsModal.setSettings({ ...this._qaSettings, ...this._quizSettings });
            this._settingsModal.show();
            return;
        }

        // Pause current playback
        this._pause();

        // Initialize quiz controller if needed
        if (!this._quizController) {
            this._initializeQuizController();
        }

        // Apply current quiz settings
        const isMultipleChoice = this._quizSettings.quizMode === 'multiple-choice';
        const questionTypes = Object.entries(this._quizSettings.quizQuestionTypes)
            .filter(([, enabled]) => enabled)
            .map(([type]) => type.replace(/_/g, ' '));
        if (questionTypes.length === 0) questionTypes.push('factual');

        this._quizController.setSettings({
            isMultipleChoice,
            isGuided: this._quizSettings.quizGuided,
            questionTypes,
            useFullChapter: this._quizSettings.quizChapterScope === 'full',
            customSystemPrompt: this._quizSettings.quizSystemPrompt,
            ttsQuestion: this._quizSettings.quizTtsQuestion,
            ttsOptions: this._quizSettings.quizTtsOptions,
            ttsCorrectness: this._quizSettings.quizTtsCorrectness,
            ttsExplanation: this._quizSettings.quizTtsExplanation
        });

        const speed = this._savedSpeed || this._settingsModal?.getSpeed() || 1.0;
        this._quizController.setPlaybackSpeed(speed);

        if (this._currentBook) {
            this._quizController.setBookMeta({
                title: this._currentBook.title,
                author: this._currentBook.author
            });
        }

        // Use text selection captured on mousedown (before click cleared it)
        const selectedSentences = this._pendingQuizSelection;
        this._pendingQuizSelection = null;
        this._quizController.setSelectionContext(selectedSentences);

        // Setup overlay
        this._quizOverlay.setMultipleChoice(isMultipleChoice);
        this._quizOverlay.reset();
        this._quizOverlay.show();
    }

    /**
     * Initialize quiz controller
     */
    _initializeQuizController() {
        llmClient.setApiKey(this._qaSettings.apiKey);
        llmClient.setModel(this._qaSettings.model);

        this._quizController = new QuizController({
            readingState: this._readingState,
            sttService: this._activeSTTService,
            onStateChange: (state, data) => {
                this._quizOverlay.setState(state, data);
            },
            onQuestionReady: (question) => {
                this._quizOverlay.showQuestion(question);
            },
            onFeedbackChunk: (text) => {
                this._quizOverlay.setFeedbackText(text);
            },
            onAnswerResult: (result) => {
                this._quizOverlay.showAnswerResult(result);
            },
            onTranscript: (text) => {
                this._quizOverlay.setTranscript(text);
            },
            onVoiceStart: () => {
                this._quizOverlay.showTranscript();
            },
            onVoiceEnd: () => {
                this._quizOverlay.hideTranscript();
            },
            onError: (message) => {
                this._quizOverlay.showError(message);
            }
        });
    }

    /**
     * Close quiz overlay
     */
    _closeQuizOverlay() {
        this._quizController?.stop();
        this._quizOverlay.hide();

        // Refresh quiz history in navigation panel
        this._loadQuizHistory();
    }

    // ========== Chapter Overview ==========

    /**
     * Open the chapter overview overlay
     */
    _openChapterOverview() {
        if (!this._currentBook || !this._readerView) return;

        // Set chapters and current chapter
        this._chapterOverview.setChapters(this._currentBook.chapters, this._currentChapterIndex);

        // Set page data from reader view
        this._chapterOverview.setPageData({
            textContentEl: this._readerView.getTextContentElement(),
            totalPages: this._readerView.getTotalPages(),
            pageHeight: this._readerView.getPageHeight(),
            currentPage: this._readerView.getCurrentPage(),
            currentSentenceIndex: this._readerView.getCurrentIndex(),
            sentenceToPage: this._readerView.getSentenceToPageMap(),
            pageToSentences: this._readerView.getPageToSentencesMap()
        });

        // Set bookmarks and highlights for current chapter
        const bookmarks = (this._readingState?.getBookmarks() || []).filter(
            b => b.chapterIndex === this._currentChapterIndex
        );
        const highlights = this._readingState?.getHighlightsForChapter(this._currentChapterIndex) || [];
        this._chapterOverview.setBookmarks(bookmarks);
        this._chapterOverview.setHighlights(highlights);

        this._chapterOverview.show();
    }

    /**
     * Close the chapter overview overlay
     */
    _closeChapterOverview() {
        this._chapterOverview.hide();
    }

    /**
     * Handle page selection from chapter overview
     * @param {number} pageNum - 0-indexed page number
     */
    _onOverviewPageSelect(pageNum) {
        this._chapterOverview.hide();
        this._readerView.goToPage(pageNum);
    }

    /**
     * Handle chapter selection from chapter overview
     * @param {number} chapterIndex
     */
    async _onOverviewChapterSelect(chapterIndex) {
        if (chapterIndex === this._currentChapterIndex) return;

        // Close overview, navigate to chapter, then re-open
        this._chapterOverview.hide();
        await this._navigateToChapter(chapterIndex);

        // Re-open overview after chapter loads
        setTimeout(() => {
            this._openChapterOverview();
        }, 500);
    }

    /**
     * Load quiz history for the current book into the navigation panel
     */
    async _loadQuizHistory() {
        if (!this._currentBook || !this._navigation) return;

        try {
            const quizHistory = await storage.getAllQuizQuestionsForBook(
                this._currentBook.id,
                this._currentBook.chapters.length
            );
            this._navigation.setQuizHistory(quizHistory);
        } catch (error) {
            console.error('Failed to load quiz history:', error);
        }
    }

    /**
     * Handle TTS backend change from settings
     * @param {string} backend
     */
    async _onTTSBackendChange(backend) {
        this._showTTSStatus('Switching TTS backend...');

        // Pause any playback
        this._pause();

        // Clear audio buffers in the controller
        if (this._audioController) {
            this._audioController.clearBuffers();
        }

        try {
            // Update FastAPI URL and dtype if changed
            const settings = this._settingsModal.getSettings();
            ttsEngine.setFastApiUrl(settings.fastApiUrl);

            await ttsEngine.setBackend(backend, { dtype: settings.kokoroDtype });
            const activeBackend = ttsEngine.getBackend();

            if (activeBackend === 'kokoro-fastapi') {
                this._showTTSStatus('TTS ready (Kokoro FastAPI)');
            } else if (activeBackend === 'kokoro-js') {
                const device = ttsEngine.getDevice();
                const dtype = ttsEngine.getDtype();
                this._showTTSStatus(`TTS ready (${device}, ${dtype})`);
            } else {
                this._showTTSStatus('TTS ready (Browser)');
            }

            // Refresh voice list (disabled state depends on backend)
            const voices = ttsEngine.getAvailableVoices();
            if (this._controls) {
                this._controls.setVoices(voices);
            }
            if (this._settingsModal) {
                this._settingsModal.setVoices(voices);
            }

            setTimeout(() => this._hideTTSStatus(), 3000);
        } catch (error) {
            console.error('Failed to switch TTS backend:', error);
            this._showTTSStatus('Backend switch failed');
            setTimeout(() => this._hideTTSStatus(), 5000);
        }
    }

    /**
     * Handle voice change from settings
     * @param {string} voiceId
     */
    _onVoiceChange(voiceId) {
        ttsEngine.setVoice(voiceId);
        this._savedVoice = voiceId;
        this._saveSettings();
    }

    /**
     * Handle speed change from settings
     * @param {number} speed
     */
    _onSpeedChange(speed) {
        this._audioController?.setSpeed(speed);
        this._savedSpeed = speed;
        this._saveSettings();
    }

    /**
     * Apply typography settings to the reader
     */
    _applyTypographySettings() {
        const settings = this._settingsModal?.getSettings();
        if (!settings) return;

        const textContent = this._elements.textContent;
        if (!textContent) return;

        // Apply font
        const fontMap = {
            'default': '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            'serif': 'Georgia, "Times New Roman", Times, serif',
            'sans-serif': 'Arial, Helvetica, sans-serif',
            'georgia': 'Georgia, serif',
            'times': '"Times New Roman", Times, serif',
            'palatino': '"Palatino Linotype", "Book Antiqua", Palatino, serif',
            'bookerly': 'Bookerly, Georgia, serif'
        };
        textContent.style.fontFamily = fontMap[settings.font] || fontMap['default'];

        // Apply font size
        textContent.style.fontSize = `${settings.fontSize}px`;

        // Apply line spacing
        textContent.style.lineHeight = settings.lineSpacing;

        // Apply margins
        const horizontalMap = {
            'narrow': 30,
            'medium': 50,
            'wide': 80
        };
        const hMargin = horizontalMap[settings.marginSize] || 50;
        const vMargin = settings.verticalMargin !== undefined ? settings.verticalMargin : 2;
        textContent.style.padding = `${vMargin}px ${hMargin}px`;

        // Apply column layout settings
        if (this._readerView) {
            const columnCount = settings.columnCount || 1;
            const columnAutoCenter = settings.columnAutoCenter !== false;
            this._readerView.setColumnAutoCenter(columnAutoCenter);
            this._readerView.setColumnCount(columnCount);
        }
    }

    /**
     * Save Q&A settings
     * @param {Object} settings
     */
    async _saveQASettings(settings) {
        this._qaSettings = { ...this._qaSettings, ...settings };

        // Update LLM client
        llmClient.setApiKey(this._qaSettings.apiKey);
        llmClient.setModel(this._qaSettings.model);

        // Update Q&A controller if it exists
        if (this._qaController) {
            this._qaController.setContextSettings(
                this._qaSettings.contextBefore,
                this._qaSettings.contextAfter,
                this._qaSettings.fullChapterContext
            );
        }

        // Save general settings
        if (settings.readingHistorySize !== undefined) {
            this._readingHistorySize = settings.readingHistorySize;
            // Trim existing cookie history if new size is smaller
            this._trimCookieHistory();
        }

        // Save to storage
        try {
            if (settings.readingHistorySize !== undefined) {
                await storage.saveSetting('readingHistorySize', settings.readingHistorySize);
            }
            await storage.saveSetting('qaApiKey', this._qaSettings.apiKey);
            await storage.saveSetting('qaModel', this._qaSettings.model);
            await storage.saveSetting('qaFullChapterContext', this._qaSettings.fullChapterContext);
            await storage.saveSetting('qaContextBefore', this._qaSettings.contextBefore);
            await storage.saveSetting('qaContextAfter', this._qaSettings.contextAfter);

            // Save TTS backend settings
            if (settings.ttsBackend) {
                await storage.saveSetting('ttsBackend', settings.ttsBackend);
            }
            if (settings.fastApiUrl) {
                await storage.saveSetting('fastApiUrl', settings.fastApiUrl);
            }
            if (settings.kokoroDtype !== undefined) {
                await storage.saveSetting('kokoroDtype', settings.kokoroDtype);
            }

            // Save voice and speed settings
            if (settings.voice) {
                await storage.saveSetting('voice', settings.voice);
                this._savedVoice = settings.voice;
            }
            if (settings.speed !== undefined) {
                await storage.saveSetting('playbackSpeed', settings.speed);
                this._savedSpeed = settings.speed;
            }

            // Save typography settings
            if (settings.font) {
                await storage.saveSetting('font', settings.font);
            }
            if (settings.fontSize) {
                await storage.saveSetting('fontSize', settings.fontSize);
            }
            if (settings.marginSize) {
                await storage.saveSetting('marginSize', settings.marginSize);
            }
            if (settings.verticalMargin !== undefined) {
                await storage.saveSetting('verticalMargin', settings.verticalMargin);
            }
            if (settings.lineSpacing) {
                await storage.saveSetting('lineSpacing', settings.lineSpacing);
            }

            // Save column layout settings
            if (settings.columnCount !== undefined) {
                await storage.saveSetting('columnCount', settings.columnCount);
            }
            if (settings.columnAutoCenter !== undefined) {
                await storage.saveSetting('columnAutoCenter', settings.columnAutoCenter);
            }

            // Save normalization settings
            if (settings.normalizeText !== undefined) {
                await storage.saveSetting('normalizeText', settings.normalizeText);
            }
            if (settings.normalizeNumbers !== undefined) {
                await storage.saveSetting('normalizeNumbers', settings.normalizeNumbers);
            }
            if (settings.normalizeAbbreviations !== undefined) {
                await storage.saveSetting('normalizeAbbreviations', settings.normalizeAbbreviations);
            }

            // Save lookup settings
            if (settings.lookupLanguage !== undefined) {
                lookupService.setTargetLanguage(settings.lookupLanguage);
                await storage.saveSetting('lookupLanguage', settings.lookupLanguage);
            }

            // Save quiz settings
            if (settings.quizMode !== undefined) {
                this._quizSettings.quizMode = settings.quizMode;
                await storage.saveSetting('quizMode', settings.quizMode);
            }
            if (settings.quizGuided !== undefined) {
                this._quizSettings.quizGuided = settings.quizGuided;
                await storage.saveSetting('quizGuided', settings.quizGuided);
            }
            if (settings.quizTtsQuestion !== undefined) {
                this._quizSettings.quizTtsQuestion = settings.quizTtsQuestion;
                await storage.saveSetting('quizTtsQuestion', settings.quizTtsQuestion);
            }
            if (settings.quizTtsOptions !== undefined) {
                this._quizSettings.quizTtsOptions = settings.quizTtsOptions;
                await storage.saveSetting('quizTtsOptions', settings.quizTtsOptions);
            }
            if (settings.quizTtsCorrectness !== undefined) {
                this._quizSettings.quizTtsCorrectness = settings.quizTtsCorrectness;
                await storage.saveSetting('quizTtsCorrectness', settings.quizTtsCorrectness);
            }
            if (settings.quizTtsExplanation !== undefined) {
                this._quizSettings.quizTtsExplanation = settings.quizTtsExplanation;
                await storage.saveSetting('quizTtsExplanation', settings.quizTtsExplanation);
            }
            if (settings.quizChapterScope !== undefined) {
                this._quizSettings.quizChapterScope = settings.quizChapterScope;
                await storage.saveSetting('quizChapterScope', settings.quizChapterScope);
            }
            if (settings.quizQuestionTypes !== undefined) {
                this._quizSettings.quizQuestionTypes = settings.quizQuestionTypes;
                await storage.saveSetting('quizQuestionTypes', settings.quizQuestionTypes);
            }
            if (settings.quizSystemPrompt !== undefined) {
                this._quizSettings.quizSystemPrompt = settings.quizSystemPrompt;
                await storage.saveSetting('quizSystemPrompt', settings.quizSystemPrompt);
            }

            // Save media session settings
            if (settings.mediaSessionVolume !== undefined) {
                await storage.saveSetting('mediaSessionVolume', settings.mediaSessionVolume);
            }
            if (settings.mediaSessionDuration !== undefined) {
                await storage.saveSetting('mediaSessionDuration', settings.mediaSessionDuration);
            }
            if (settings.mediaSessionVolume !== undefined || settings.mediaSessionDuration !== undefined) {
                mediaSessionManager.configure({
                    volume: settings.mediaSessionVolume,
                    duration: settings.mediaSessionDuration
                });
            }

            // Save STT backend settings
            if (settings.sttBackend !== undefined) {
                this._sttBackend = settings.sttBackend;
                await storage.saveSetting('sttBackend', settings.sttBackend);
                if (settings.sttBackend === 'whisper') {
                    this._switchToWhisperSTT(settings.whisperModel, settings.whisperDevice, settings.whisperSilenceTimeout, settings.whisperMaxDuration);
                } else {
                    this._switchToWebSpeechSTT();
                }
            }
            if (settings.whisperModel !== undefined) {
                await storage.saveSetting('whisperModel', settings.whisperModel);
                if (this._whisperService) this._whisperService.setModel(settings.whisperModel);
            }
            if (settings.whisperDevice !== undefined) {
                await storage.saveSetting('whisperDevice', settings.whisperDevice);
                if (this._whisperService) this._whisperService.setDevice(settings.whisperDevice);
            }
            if (settings.whisperSilenceTimeout !== undefined) {
                await storage.saveSetting('whisperSilenceTimeout', settings.whisperSilenceTimeout);
                if (this._whisperService) this._whisperService.setSilenceTimeout(settings.whisperSilenceTimeout * 1000);
            }
            if (settings.whisperMaxDuration !== undefined) {
                await storage.saveSetting('whisperMaxDuration', settings.whisperMaxDuration);
                if (this._whisperService) this._whisperService.setMaxDuration(settings.whisperMaxDuration * 1000);
            }

            // Save LLM backend settings
            if (settings.llmBackend !== undefined) {
                this._llmBackend = settings.llmBackend;
                await storage.saveSetting('llmBackend', settings.llmBackend);
                llmClient.setBackend(settings.llmBackend);
            }
            if (settings.localLlmModel !== undefined) {
                await storage.saveSetting('localLlmModel', settings.localLlmModel);
                llmClient.setLocalModel(settings.localLlmModel);
            }
            if (settings.localLlmDevice !== undefined) {
                await storage.saveSetting('localLlmDevice', settings.localLlmDevice);
                llmClient.setLocalDevice(settings.localLlmDevice);
            }
        } catch (error) {
            console.error('Failed to save settings:', error);
        }

        // Apply typography settings immediately
        this._applyTypographySettings();

        // Update UI
        this._updateQASetupStatus();

        // Update settings modal
        this._settingsModal.setSettings({ ...this._qaSettings, ...this._quizSettings });

        // Enable/disable Ask and Quiz buttons based on backend availability
        this._updateAskQuizButtons();
    }

    /**
     * Update Ask/Quiz button enabled state based on active backend
     */
    _updateAskQuizButtons() {
        if (!this._controls) return;

        const llmAvailable = this._llmBackend === 'local' || this._qaSettings.apiKey;
        const llmDisabledReason = this._llmBackend === 'openrouter' && !this._qaSettings.apiKey
            ? 'Configure API key in Q&A Settings or switch to Local LLM'
            : null;

        this._controls.setAskDisabled(!llmAvailable, llmDisabledReason);
        this._controls.setQuizDisabled(!llmAvailable, llmDisabledReason);
    }

    /**
     * Run TTS benchmark
     * @param {number} [numSentences=5] - Number of sentences to test
     * @returns {Promise<Object>}
     */
    async runBenchmark(numSentences = 5) {
        if (!this._currentBook) {
            // Use test sentences if no book loaded
            const testSentences = [
                "The quick brown fox jumps over the lazy dog.",
                "She sells seashells by the seashore.",
                "How much wood would a woodchuck chuck if a woodchuck could chuck wood?",
                "Peter Piper picked a peck of pickled peppers.",
                "The rain in Spain stays mainly in the plain.",
                "To be or not to be, that is the question.",
                "All that glitters is not gold.",
                "A journey of a thousand miles begins with a single step."
            ];
            console.log('No book loaded, using test sentences...');
            return ttsEngine.runBenchmark(testSentences.slice(0, numSentences));
        } else {
            // Use sentences from current chapter
            const chapter = this._currentBook.chapters[this._currentChapterIndex];
            const sentences = chapter.sentences.slice(0, numSentences);
            console.log(`Running benchmark on ${sentences.length} sentences from "${chapter.title}"...`);
            return ttsEngine.runBenchmark(sentences);
        }
    }

    /**
     * Enable/disable continuous benchmarking
     * @param {boolean} enabled
     */
    setBenchmarkMode(enabled) {
        ttsEngine.setBenchmarkEnabled(enabled);
        console.log(`Benchmark mode ${enabled ? 'enabled' : 'disabled'}`);
        if (enabled) {
            console.log('TTS timing will be logged for each sentence.');
        }
    }

    /**
     * Get TTS engine info
     * @returns {Object}
     */
    getTTSInfo() {
        return {
            ready: ttsEngine.isReady(),
            usingKokoro: ttsEngine.isUsingKokoro(),
            backend: ttsEngine.getBackend(),
            device: ttsEngine.getDevice(),
            dtype: ttsEngine.getDtype(),
            fastApiUrl: ttsEngine.getFastApiUrl(),
            fastApiAvailable: ttsEngine.isFastAPIAvailable(),
            averageRTF: ttsEngine.getAverageRTF(),
            benchmarkResults: ttsEngine.getBenchmarkResults()
        };
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

    // ========== Navigation History (Back/Forward/Home) ==========

    /**
     * Setup event listeners for navigation history buttons
     */
    _setupNavHistoryButtons() {
        this._elements.navBackBtn?.addEventListener('click', () => this._goBack());
        this._elements.navForwardBtn?.addEventListener('click', () => this._goForward());
        this._elements.navHomeBtn?.addEventListener('click', () => this._goHome());
    }

    /**
     * Update the enabled/disabled state of back/forward/home buttons
     */
    _updateNavHistoryButtons() {
        const { navBackBtn, navForwardBtn, navHomeBtn } = this._elements;
        if (navBackBtn) {
            navBackBtn.disabled = !this._navigationHistory?.canGoBack();
        }
        if (navForwardBtn) {
            navForwardBtn.disabled = !this._navigationHistory?.canGoForward();
        }
        if (navHomeBtn) {
            // Always enabled when a book is loaded so the user can recalibrate
            // the view to the current playback position (e.g. after a resize
            // causes the displayed page to drift from the TTS sentence).
            navHomeBtn.disabled = !this._currentBook;
        }
    }

    /**
     * Navigate back in history.
     * Decouples the view from the active playback sentence.
     */
    async _goBack() {
        if (!this._navigationHistory?.canGoBack()) return;

        const currentPage = this._readerView?.getCurrentPage() ?? 0;
        const entry = this._navigationHistory.goBack(
            this._currentChapterIndex,
            this._audioController?.getCurrentIndex() ?? 0,
            currentPage
        );
        if (!entry) return;

        // Decouple view from playback
        this._viewDecoupled = true;

        // Navigate to the history entry in view-only mode (don't touch audio)
        if (entry.chapterIndex !== this._currentChapterIndex) {
            await this._loadChapter(entry.chapterIndex, false, { viewOnly: true });
            this._navigation.setCurrentChapter(entry.chapterIndex);
        }

        // Go to the stored page (after layout completes for chapter loads)
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                this._readerView?.goToPage(entry.page);
            });
        });

        this._updateNavHistoryButtons();
    }

    /**
     * Navigate forward in history.
     * Keeps the view decoupled from the active playback sentence.
     */
    async _goForward() {
        if (!this._navigationHistory?.canGoForward()) return;

        const currentPage = this._readerView?.getCurrentPage() ?? 0;
        const entry = this._navigationHistory.goForward(
            this._currentChapterIndex,
            this._audioController?.getCurrentIndex() ?? 0,
            currentPage
        );
        if (!entry) return;

        // Keep view decoupled
        this._viewDecoupled = true;

        // Navigate to the history entry in view-only mode (don't touch audio)
        if (entry.chapterIndex !== this._currentChapterIndex) {
            await this._loadChapter(entry.chapterIndex, false, { viewOnly: true });
            this._navigation.setCurrentChapter(entry.chapterIndex);
        }

        // Go to the stored page (after layout completes for chapter loads)
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                this._readerView?.goToPage(entry.page);
            });
        });

        this._updateNavHistoryButtons();
    }

    /**
     * Re-couple the view with the active playback sentence (home button).
     * Navigates back to the chapter/sentence currently being played.
     */
    async _goHome() {
        // Always allow recalibration: re-couple the view and scroll to the
        // current playback sentence.  When already coupled this acts as a
        // "recalibrate" action, fixing any drift (e.g. after a resize).
        this._viewDecoupled = false;

        // Use the tracked playback position (not reading state, which may
        // have been updated by view-only chapter loads)
        const chapterIndex = this._playbackChapterIndex;
        const sentenceIndex = this._playbackSentenceIndex;

        // Load the playback chapter if different from what's currently displayed
        if (chapterIndex !== this._currentChapterIndex) {
            // Load view-only first (to render the chapter without resetting audio),
            // then restore the audio controller to the correct sentence
            await this._loadChapter(chapterIndex, false, { viewOnly: true });
            this._navigation.setCurrentChapter(chapterIndex);

            // Re-sync audio controller with the displayed chapter's sentences
            const sentences = this._currentBook.chapters[chapterIndex].sentences || [];
            this._audioController.setSentences(sentences, sentenceIndex);
        }

        // Scroll to the current playback sentence
        this._readerView?.highlightSentence(sentenceIndex, true);

        this._updateNavHistoryButtons();
    }

    /**
     * Navigate to the previous chapter
     * @param {Object} [options]
     * @param {boolean} [options.goToLastPage=false] - If true, jump to the last page of the previous chapter
     */
    async _navigateToPrevChapter({ goToLastPage = false } = {}) {
        if (!this._currentBook || this._currentChapterIndex <= 0) return;
        await this._navigateToChapter(this._currentChapterIndex - 1, { pushHistory: true, goToLastPage });
    }

    /**
     * Navigate to the next chapter
     */
    async _navigateToNextChapter() {
        if (!this._currentBook || this._currentChapterIndex >= this._currentBook.chapters.length - 1) return;
        await this._navigateToChapter(this._currentChapterIndex + 1, { pushHistory: true });
    }

    /**
     * Navigate to a chapter
     * @param {number} chapterIndex
     */
    async _navigateToChapter(chapterIndex, { pushHistory = true, goToLastPage = false } = {}) {
        if (chapterIndex === this._currentChapterIndex) {
            return;
        }

        // Push current position to history before navigating
        if (pushHistory && this._navigationHistory) {
            this._navigationHistory.pushCurrentPosition(
                this._currentChapterIndex,
                this._audioController?.getCurrentIndex() ?? 0,
                this._readerView?.getCurrentPage() ?? 0
            );
        }

        // Re-couple view on explicit navigation
        if (pushHistory) {
            this._viewDecoupled = false;
            this._updateNavHistoryButtons();
        }

        // Pause playback
        this._pause();

        // Update state
        this._readingState.goToChapter(chapterIndex, 0);

        // Tell reader view to jump to last page after content renders (before loading)
        if (goToLastPage) {
            this._readerView.goToLastPageAfterRender();
        }

        // Load chapter
        await this._loadChapter(chapterIndex, false);

        // Update navigation
        this._navigation.setCurrentChapter(chapterIndex);

        // Reset to first sentence
        this._audioController.goToSentence(0);
        this._readerView.highlightSentence(0);
    }

    /**
     * Navigate to a bookmark
     * @param {Object} bookmark
     */
    async _navigateToBookmark(bookmark) {
        // Push current position to history before navigating
        if (this._navigationHistory) {
            this._navigationHistory.pushCurrentPosition(
                this._currentChapterIndex,
                this._audioController?.getCurrentIndex() ?? 0,
                this._readerView?.getCurrentPage() ?? 0
            );
        }

        // Re-couple view on explicit navigation
        this._viewDecoupled = false;
        this._updateNavHistoryButtons();

        // Pause playback
        this._pause();

        // Update state
        this._readingState.goToBookmark(bookmark);

        // Load chapter if different
        if (bookmark.chapterIndex !== this._currentChapterIndex) {
            await this._loadChapter(bookmark.chapterIndex, false);
            this._navigation.setCurrentChapter(bookmark.chapterIndex);
        }

        // Go to sentence and update playback tracking
        this._audioController.goToSentence(bookmark.sentenceIndex);
        this._readerView.highlightSentence(bookmark.sentenceIndex);
        this._playbackChapterIndex = bookmark.chapterIndex;
        this._playbackSentenceIndex = bookmark.sentenceIndex;
    }

    /**
     * Handle click on an internal EPUB link
     * @param {string} href - The raw href attribute from the link
     */
    async _handleInternalLink(href) {
        if (!this._currentBook) return;

        // Parse href into file part and fragment
        const hashIndex = href.indexOf('#');
        const filePart = hashIndex >= 0 ? href.substring(0, hashIndex) : href;
        const fragment = hashIndex >= 0 ? href.substring(hashIndex + 1) : '';

        if (!filePart && fragment) {
            // Same-chapter fragment link (e.g., #footnote-1)
            // Push current position to history before scrolling
            if (this._navigationHistory) {
                this._navigationHistory.pushCurrentPosition(
                    this._currentChapterIndex,
                    this._audioController?.getCurrentIndex() ?? 0,
                    this._readerView?.getCurrentPage() ?? 0
                );
            }
            this._viewDecoupled = true;
            this._updateNavHistoryButtons();
            this._readerView.scrollToFragment(fragment);
            return;
        }

        // Find the target chapter by matching filename
        const targetFilename = filePart.split('/').pop();
        const targetIndex = this._currentBook.chapters.findIndex(ch => {
            const chapterFilename = ch.href.split('/').pop().split('#')[0];
            return chapterFilename === targetFilename;
        });

        if (targetIndex === -1) {
            console.warn('Could not find chapter for internal link:', href);
            return;
        }

        // Push current position to history before navigating
        if (this._navigationHistory) {
            this._navigationHistory.pushCurrentPosition(
                this._currentChapterIndex,
                this._audioController?.getCurrentIndex() ?? 0,
                this._readerView?.getCurrentPage() ?? 0
            );
        }
        this._viewDecoupled = true;
        this._updateNavHistoryButtons();

        // Navigate to the target chapter if it's different from the current one
        if (targetIndex !== this._currentChapterIndex) {
            // Load chapter in view-only mode: don't pause or change audio state
            await this._loadChapter(targetIndex, false, { viewOnly: true });
            this._navigation.setCurrentChapter(targetIndex);
        }

        // Scroll to the fragment target after rendering completes
        if (fragment) {
            // setSentences uses double requestAnimationFrame for pagination,
            // so we need to wait for that to finish before scrolling
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        this._readerView.scrollToFragment(fragment);
                    });
                });
            });
        }
    }

    /**
     * Add a bookmark at current position
     */
    async _addBookmark() {
        if (!this._readingState) return;

        try {
            const note = prompt('Add a note (optional):');
            if (note === null) return; // User cancelled

            await this._readingState.addBookmark(note);
            this._showToast('Bookmark added');

            // Update navigation
            this._navigation.setBookmarks(this._readingState.getBookmarks());
        } catch (error) {
            console.error('Failed to add bookmark:', error);
            this._showToast('Failed to add bookmark');
        }
    }

    /**
     * Delete a bookmark
     * @param {string} bookmarkId
     */
    async _deleteBookmark(bookmarkId) {
        try {
            await this._readingState.deleteBookmark(bookmarkId);
            this._showToast('Bookmark deleted');

            // Update navigation
            this._navigation.setBookmarks(this._readingState.getBookmarks());
        } catch (error) {
            console.error('Failed to delete bookmark:', error);
        }
    }

    // ========== Highlight Management ==========

    /**
     * Add a highlight
     * @param {number} startIndex - Start sentence index
     * @param {number} endIndex - End sentence index
     * @param {string} text - Highlighted text
     * @param {string} color - Highlight color
     */
    async _addHighlight(startIndex, endIndex, text, color) {
        if (!this._readingState) return;

        try {
            await this._readingState.addHighlight(
                this._currentChapterIndex,
                startIndex,
                endIndex,
                text,
                '',
                color
            );
            this._showToast('Highlight added');
            this._saveCookieState();
        } catch (error) {
            console.error('Failed to add highlight:', error);
            this._showToast('Failed to add highlight');
        }
    }

    /**
     * Delete a highlight
     * @param {string} highlightId
     */
    async _deleteHighlight(highlightId) {
        try {
            await this._readingState.deleteHighlight(highlightId);
            this._showToast('Highlight deleted');

            // Re-apply highlights for current chapter
            if (this._readerView && this._readingState) {
                const chapterHighlights = this._readingState.getHighlightsForChapter(this._currentChapterIndex);
                this._readerView.setHighlights(chapterHighlights);
            }

            this._saveCookieState();
        } catch (error) {
            console.error('Failed to delete highlight:', error);
        }
    }

    /**
     * Navigate to a highlight
     * @param {Object} highlight
     */
    async _navigateToHighlight(highlight) {
        // Push current position to history before navigating
        if (this._navigationHistory) {
            this._navigationHistory.pushCurrentPosition(
                this._currentChapterIndex,
                this._audioController?.getCurrentIndex() ?? 0,
                this._readerView?.getCurrentPage() ?? 0
            );
        }

        // Re-couple view on explicit navigation
        this._viewDecoupled = false;
        this._updateNavHistoryButtons();

        // Pause playback
        this._pause();

        // Load chapter if different
        if (highlight.chapterIndex !== this._currentChapterIndex) {
            this._readingState.goToChapter(highlight.chapterIndex, highlight.startSentenceIndex);
            await this._loadChapter(highlight.chapterIndex, false);
            this._navigation.setCurrentChapter(highlight.chapterIndex);
        }

        // Go to the highlighted sentence and update playback tracking
        this._audioController.goToSentence(highlight.startSentenceIndex);
        this._readerView.highlightSentence(highlight.startSentenceIndex);
        this._playbackChapterIndex = highlight.chapterIndex;
        this._playbackSentenceIndex = highlight.startSentenceIndex;
    }

    // ========== Search ==========

    /**
     * Toggle the search panel and its background overlay
     */
    _toggleSearchPanel() {
        const overlay = document.getElementById('search-overlay');
        if (this._searchPanel.isOpen()) {
            this._searchPanel.close();
            overlay?.classList.remove('active');
        } else {
            this._searchPanel.open();
            overlay?.classList.add('active');
        }
    }

    /**
     * Handle search result selection.
     * Navigates to the chapter/sentence with history integration,
     * similar to link following / bookmark navigation.
     * @param {number} chapterIndex
     * @param {number} sentenceIndex
     */
    async _onSearchResultSelect(chapterIndex, sentenceIndex) {
        // Push current position to history before navigating
        if (this._navigationHistory) {
            this._navigationHistory.pushCurrentPosition(
                this._currentChapterIndex,
                this._audioController?.getCurrentIndex() ?? 0,
                this._readerView?.getCurrentPage() ?? 0
            );
        }

        // Decouple view (search navigation is view-only, like link following)
        this._viewDecoupled = true;
        this._updateNavHistoryButtons();

        // Load chapter if different
        if (chapterIndex !== this._currentChapterIndex) {
            await this._loadChapter(chapterIndex, false, { viewOnly: true });
            this._navigation.setCurrentChapter(chapterIndex);
        }

        // Apply inline search highlights for this chapter
        this._applySearchHighlightsForChapter(chapterIndex, sentenceIndex);

        // Navigate to the sentence's page and scroll into view
        // Use double requestAnimationFrame to match pagination timing
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                this._readerView?.scrollToSentence(sentenceIndex);
            });
        });
    }

    /**
     * Apply search inline highlights for a specific chapter.
     * Filters results to only those in the given chapter and tells the
     * reader view to highlight them.
     * @param {number} chapterIndex
     * @param {number} activeSentenceIndex - The focused result's sentence index (-1 for none)
     */
    _applySearchHighlightsForChapter(chapterIndex, activeSentenceIndex = -1) {
        if (!this._searchPanel || !this._readerView) return;

        const query = this._searchPanel.getQuery();
        if (!query || query.trim().length < 2) {
            this._readerView.clearSearchHighlights();
            return;
        }

        const allResults = this._searchPanel.getResults();
        const chapterResults = allResults.filter(r => r.chapterIndex === chapterIndex);

        this._readerView.applySearchHighlights(
            query,
            this._searchPanel.isCaseSensitive(),
            this._searchPanel.isWholeWord(),
            chapterResults,
            activeSentenceIndex
        );
    }

    /**
     * Handle search panel close.
     * Clears all inline highlights.
     */
    _onSearchClose() {
        this._readerView?.clearSearchHighlights();
        // Hide search overlay
        document.getElementById('search-overlay')?.classList.remove('active');
    }

    /**
     * Handle position change
     * @param {number} chapterIndex
     * @param {number} sentenceIndex
     */
    _onPositionChange(chapterIndex, sentenceIndex) {
        // Save position to cookie for quick restoration
        this._saveCookieState();
    }

    /**
     * Handle bookmarks change
     */
    _onBookmarksChange() {
        // Update navigation if it exists
        if (this._navigation && this._readingState) {
            this._navigation.setBookmarks(this._readingState.getBookmarks());
        }
        this._saveCookieState();
    }

    /**
     * Handle highlights change
     */
    _onHighlightsChange() {
        // Update navigation if it exists
        if (this._navigation && this._readingState) {
            this._navigation.setHighlights(this._readingState.getHighlights());
        }
    }

    // ========== Word/Phrase Lookup ==========

    /**
     * Perform a word/phrase lookup
     * @param {string} text - The selected text
     * @param {number} sentenceIndex - The sentence index of the selection
     */
    async _performLookup(text, sentenceIndex) {
        if (!llmClient.hasApiKey()) {
            this._lookupDrawer.showLoading(text);
            this._lookupDrawer.showError('Please set an OpenRouter API key in Settings to use word lookup.');
            return;
        }

        if (!this._currentBook) return;

        // Show loading state in drawer
        this._lookupDrawer.showLoading(text);

        // Get surrounding sentence for context
        const chapter = this._currentBook.chapters?.[this._currentChapterIndex];
        const sentences = chapter?.sentences || [];
        const contextSentence = sentences[sentenceIndex] || '';

        try {
            const entry = await lookupService.lookup({
                phrase: text,
                sentenceContext: contextSentence,
                bookId: this._currentBook.id,
                chapterIndex: this._currentChapterIndex,
                sentenceIndex,
                bookMeta: {
                    title: this._currentBook.title,
                    author: this._currentBook.author
                }
            });

            this._lookupDrawer.showResult(entry);
            this._refreshLookupNav();
        } catch (error) {
            console.error('Lookup failed:', error);
            this._lookupDrawer.showError(error.message || 'Lookup failed. Please try again.');
        }
    }

    /**
     * Show the lookup history overlay
     */
    async _showLookupHistory() {
        try {
            const lookups = await lookupService.getAllLookups();

            // Build books map for grouping
            const books = {};
            if (this._currentBook) {
                books[this._currentBook.id] = {
                    title: this._currentBook.title,
                    author: this._currentBook.author
                };
            }
            // Also try to get titles from lookup entries themselves
            for (const lookup of lookups) {
                if (!books[lookup.bookId]) {
                    books[lookup.bookId] = { title: lookup.bookId };
                }
            }

            this._lookupHistoryOverlay.show(lookups, books);
        } catch (error) {
            console.error('Failed to load lookup history:', error);
        }
    }

    /**
     * Refresh the lookups list in the navigation panel
     */
    async _refreshLookupNav() {
        if (!this._currentBook || !this._navigation) return;
        try {
            const lookups = await lookupService.getBookLookups(this._currentBook.id);
            this._navigation.setLookups(lookups);
        } catch (error) {
            console.error('Failed to refresh lookup nav:', error);
        }
    }

    /**
     * Load settings from storage
     */
    async _loadSettings() {
        try {
            // Load general settings
            const readingHistorySize = await storage.getSetting('readingHistorySize');
            if (readingHistorySize !== null) {
                this._readingHistorySize = readingHistorySize;
            }

            const speed = await storage.getSetting('playbackSpeed');
            if (speed !== null) {
                // Will be set when controls are initialized
                this._savedSpeed = speed;
            }

            const voice = await storage.getSetting('voice');
            if (voice !== null) {
                // Will be set when controls are initialized
                this._savedVoice = voice;
            }

            // Load Q&A settings
            const apiKey = await storage.getSetting('qaApiKey');
            if (apiKey !== null) {
                this._qaSettings.apiKey = apiKey;
                llmClient.setApiKey(apiKey);
            }

            const model = await storage.getSetting('qaModel');
            if (model !== null) {
                this._qaSettings.model = model;
                llmClient.setModel(model);
            }

            const fullChapterContext = await storage.getSetting('qaFullChapterContext');
            if (fullChapterContext !== null) {
                this._qaSettings.fullChapterContext = fullChapterContext;
            }

            const contextBefore = await storage.getSetting('qaContextBefore');
            if (contextBefore !== null) {
                this._qaSettings.contextBefore = contextBefore;
            }

            const contextAfter = await storage.getSetting('qaContextAfter');
            if (contextAfter !== null) {
                this._qaSettings.contextAfter = contextAfter;
            }

            // Load typography settings
            const font = await storage.getSetting('font');
            const fontSize = await storage.getSetting('fontSize');
            const marginSize = await storage.getSetting('marginSize');
            const verticalMargin = await storage.getSetting('verticalMargin');
            const lineSpacing = await storage.getSetting('lineSpacing');

            const typographySettings = {};
            if (font !== null) typographySettings.font = font;
            if (fontSize !== null) typographySettings.fontSize = fontSize;
            if (marginSize !== null) typographySettings.marginSize = marginSize;
            if (verticalMargin !== null) typographySettings.verticalMargin = verticalMargin;
            if (lineSpacing !== null) typographySettings.lineSpacing = lineSpacing;

            // Load column layout settings
            const columnCount = await storage.getSetting('columnCount');
            const columnAutoCenter = await storage.getSetting('columnAutoCenter');
            if (columnCount !== null) typographySettings.columnCount = columnCount;
            if (columnAutoCenter !== null) typographySettings.columnAutoCenter = columnAutoCenter;

            // Load normalization settings
            const normalizeText = await storage.getSetting('normalizeText');
            const normalizeNumbers = await storage.getSetting('normalizeNumbers');
            const normalizeAbbreviations = await storage.getSetting('normalizeAbbreviations');

            const normalizationSettings = {};
            if (normalizeText !== null) normalizationSettings.normalizeText = normalizeText;
            if (normalizeNumbers !== null) normalizationSettings.normalizeNumbers = normalizeNumbers;
            if (normalizeAbbreviations !== null) normalizationSettings.normalizeAbbreviations = normalizeAbbreviations;

            // Load lookup settings
            const lookupLanguage = await storage.getSetting('lookupLanguage');
            if (lookupLanguage !== null) {
                lookupService.setTargetLanguage(lookupLanguage);
            }

            // Load quiz settings
            const quizMode = await storage.getSetting('quizMode');
            if (quizMode !== null) this._quizSettings.quizMode = quizMode;

            const quizGuided = await storage.getSetting('quizGuided');
            if (quizGuided !== null) this._quizSettings.quizGuided = quizGuided;

            const quizTtsQuestion = await storage.getSetting('quizTtsQuestion');
            if (quizTtsQuestion !== null) this._quizSettings.quizTtsQuestion = quizTtsQuestion;

            const quizTtsOptions = await storage.getSetting('quizTtsOptions');
            if (quizTtsOptions !== null) this._quizSettings.quizTtsOptions = quizTtsOptions;

            const quizTtsCorrectness = await storage.getSetting('quizTtsCorrectness');
            if (quizTtsCorrectness !== null) this._quizSettings.quizTtsCorrectness = quizTtsCorrectness;

            const quizTtsExplanation = await storage.getSetting('quizTtsExplanation');
            if (quizTtsExplanation !== null) this._quizSettings.quizTtsExplanation = quizTtsExplanation;

            const quizChapterScope = await storage.getSetting('quizChapterScope');
            if (quizChapterScope !== null) this._quizSettings.quizChapterScope = quizChapterScope;

            const quizQuestionTypes = await storage.getSetting('quizQuestionTypes');
            if (quizQuestionTypes !== null) this._quizSettings.quizQuestionTypes = quizQuestionTypes;

            const quizSystemPrompt = await storage.getSetting('quizSystemPrompt');
            if (quizSystemPrompt !== null) this._quizSettings.quizSystemPrompt = quizSystemPrompt;

            // Load media session settings
            const mediaSessionVolume = await storage.getSetting('mediaSessionVolume');
            const mediaSessionDuration = await storage.getSetting('mediaSessionDuration');
            const mediaSessionSettings = {};
            if (mediaSessionVolume !== null) mediaSessionSettings.volume = mediaSessionVolume;
            if (mediaSessionDuration !== null) mediaSessionSettings.duration = mediaSessionDuration;
            if (Object.keys(mediaSessionSettings).length > 0) {
                mediaSessionManager.configure(mediaSessionSettings);
            }

            // Load Kokoro.js dtype setting
            const kokoroDtype = await storage.getSetting('kokoroDtype');

            // Load STT backend settings
            const sttBackend = await storage.getSetting('sttBackend');
            if (sttBackend !== null) this._sttBackend = sttBackend;
            const whisperModel = await storage.getSetting('whisperModel');
            const whisperDevice = await storage.getSetting('whisperDevice');
            const whisperSilenceTimeout = await storage.getSetting('whisperSilenceTimeout');
            const whisperMaxDuration = await storage.getSetting('whisperMaxDuration');

            // Load LLM backend settings
            const llmBackend = await storage.getSetting('llmBackend');
            if (llmBackend !== null) this._llmBackend = llmBackend;
            const localLlmModel = await storage.getSetting('localLlmModel');
            const localLlmDevice = await storage.getSetting('localLlmDevice');

            // Apply STT backend
            if (this._sttBackend === 'whisper') {
                this._switchToWhisperSTT(whisperModel, whisperDevice, whisperSilenceTimeout, whisperMaxDuration);
            }

            // Apply LLM backend
            if (this._llmBackend === 'local') {
                llmClient.setBackend('local');
                if (localLlmModel) llmClient.setLocalModel(localLlmModel);
                if (localLlmDevice) llmClient.setLocalDevice(localLlmDevice);
            }

            // Update Q&A setup UI
            this._updateQASetupStatus();

            // Update settings modal with all settings
            this._settingsModal?.setSettings({
                readingHistorySize: this._readingHistorySize,
                ...this._qaSettings,
                ...this._quizSettings,
                voice: this._savedVoice,
                speed: this._savedSpeed,
                ...typographySettings,
                ...normalizationSettings,
                lookupLanguage: lookupLanguage !== null ? lookupLanguage : 'auto',
                mediaSessionVolume: mediaSessionVolume !== null ? mediaSessionVolume : undefined,
                mediaSessionDuration: mediaSessionDuration !== null ? mediaSessionDuration : undefined,
                // STT/LLM backend settings
                sttBackend: this._sttBackend,
                whisperModel: whisperModel || undefined,
                whisperDevice: whisperDevice || 'auto',
                whisperSilenceTimeout: whisperSilenceTimeout !== null ? whisperSilenceTimeout : undefined,
                whisperMaxDuration: whisperMaxDuration !== null ? whisperMaxDuration : undefined,
                llmBackend: this._llmBackend,
                localLlmModel: localLlmModel || undefined,
                localLlmDevice: localLlmDevice || 'auto',
                kokoroDtype: kokoroDtype || 'auto'
            });

        } catch (error) {
            console.error('Failed to load settings:', error);
        }
    }

    /**
     * Save settings to storage
     */
    // ========== STT/LLM Backend Switching ==========

    /**
     * Switch to Whisper STT backend
     * @param {string} [model] - Whisper model ID
     * @param {string} [device] - Device preference
     */
    _switchToWhisperSTT(model, device, silenceTimeout, maxDuration) {
        if (!this._whisperService) {
            this._whisperService = new WhisperSTTService();
        }
        if (model) this._whisperService.setModel(model);
        if (device) this._whisperService.setDevice(device);
        if (silenceTimeout != null) this._whisperService.setSilenceTimeout(silenceTimeout * 1000);
        if (maxDuration != null) this._whisperService.setMaxDuration(maxDuration * 1000);

        this._activeSTTService = this._whisperService;

        // Update controllers with the new STT service
        this._qaController?.setSTTService(this._whisperService);
        this._quizController?.setSTTService(this._whisperService);

        console.log(`STT: Switched to Whisper (${model || 'default'}, ${device || 'auto'})`);
    }

    /**
     * Switch back to Web Speech API STT
     */
    _switchToWebSpeechSTT() {
        this._activeSTTService = sttService;

        // Update controllers
        this._qaController?.setSTTService(sttService);
        this._quizController?.setSTTService(sttService);

        console.log('STT: Switched to Web Speech API');
    }

    /**
     * Download Whisper model (triggered from settings)
     * @param {Object} config
     * @param {string} config.model - Model ID
     * @param {string} config.device - Device preference
     */
    async _downloadWhisperModel(config) {
        if (!this._whisperService) {
            this._whisperService = new WhisperSTTService();
        }

        this._whisperService.setModel(config.model);
        this._whisperService.setDevice(config.device);

        // Show download progress
        this._settingsModal.setWhisperStatus({ loading: true, statusText: 'Starting download...' });

        this._whisperService.onModelProgress = (progress) => {
            modelDownloadModal.updateProgress(progress);
            this._settingsModal.setWhisperStatus({
                loading: true,
                statusText: progress.status || 'Downloading...'
            });
        };

        modelDownloadModal.showProgress('Downloading Whisper Model');

        try {
            await this._whisperService.loadModel();
            modelDownloadModal.showComplete('Whisper model ready!');
            this._settingsModal.setWhisperStatus({ loaded: true, statusText: 'Model ready' });
        } catch (error) {
            modelDownloadModal.showError(error.message);
            this._settingsModal.setWhisperStatus({ loaded: false, statusText: `Error: ${error.message}` });
        }
    }

    /**
     * Download local LLM model (triggered from settings)
     * @param {Object} config
     * @param {string} config.model - Model ID
     * @param {string} config.device - Device preference
     */
    async _downloadLocalLlmModel(config) {
        llmClient.setLocalModel(config.model);
        llmClient.setLocalDevice(config.device);

        // Show download progress
        this._settingsModal.setLocalLlmStatus({ loading: true, statusText: 'Starting download...' });

        llmClient.onModelProgress = (progress) => {
            modelDownloadModal.updateProgress(progress);
            this._settingsModal.setLocalLlmStatus({
                loading: true,
                statusText: progress.status || 'Downloading...'
            });
        };

        modelDownloadModal.showProgress('Downloading LLM Model');

        try {
            await llmClient.loadLocalModel();
            modelDownloadModal.showComplete('LLM model ready!');
            this._settingsModal.setLocalLlmStatus({ loaded: true, statusText: 'Model ready' });
        } catch (error) {
            modelDownloadModal.showError(error.message);
            this._settingsModal.setLocalLlmStatus({ loaded: false, statusText: `Error: ${error.message}` });
        }
    }

    /**
     * Ensure the local LLM is loaded, prompting download if needed
     * @returns {Promise<boolean>} true if model is ready
     */
    async _ensureLocalLlmReady() {
        if (llmClient.isLocalModelReady()) return true;

        const { modelManager } = await import('./services/model-manager.js');
        const modelId = llmClient.getLocalModel();
        const sizeInfo = modelManager.getModelSize(modelId);
        const modelInfo = llmClient.getLocalAvailableModels().find(m => m.id === modelId);

        const confirmed = await modelDownloadModal.promptDownload({
            modelName: modelInfo?.name || modelId,
            modelSize: sizeInfo.download,
            purpose: 'AI Assistant'
        });

        if (!confirmed) return false;

        llmClient.onModelProgress = (progress) => {
            modelDownloadModal.updateProgress(progress);
        };

        try {
            await llmClient.loadLocalModel();
            modelDownloadModal.showComplete('LLM model ready!');
            return true;
        } catch (error) {
            modelDownloadModal.showError(error.message);
            return false;
        }
    }

    /**
     * Ensure Whisper STT is loaded, prompting download if needed
     * @returns {Promise<boolean>} true if model is ready
     */
    async _ensureWhisperReady() {
        if (this._whisperService?.isModelReady()) return true;

        if (!this._whisperService) {
            this._whisperService = new WhisperSTTService();
        }

        const { modelManager } = await import('./services/model-manager.js');
        const modelId = this._whisperService.getModel();
        const sizeInfo = modelManager.getModelSize(modelId);
        const modelInfo = this._whisperService.getAvailableModels().find(m => m.id === modelId);

        const confirmed = await modelDownloadModal.promptDownload({
            modelName: modelInfo?.name || modelId,
            modelSize: sizeInfo.download,
            purpose: 'Speech Recognition'
        });

        if (!confirmed) return false;

        this._whisperService.onModelProgress = (progress) => {
            modelDownloadModal.updateProgress(progress);
        };

        try {
            await this._whisperService.loadModel();
            modelDownloadModal.showComplete('Whisper model ready!');
            return true;
        } catch (error) {
            modelDownloadModal.showError(error.message);
            return false;
        }
    }

    async _saveSettings() {
        try {
            // Save voice and speed from saved values
            if (this._savedSpeed !== undefined) {
                await storage.saveSetting('playbackSpeed', this._savedSpeed);
            }
            if (this._savedVoice !== undefined) {
                await storage.saveSetting('voice', this._savedVoice);
            }
        } catch (error) {
            console.error('Failed to save settings:', error);
        }
    }

    // ========== Cookie-based State Persistence ==========

    /**
     * Save current reading state to cookie history for quick restoration.
     * Maintains an array of the last N books read, where N = readingHistorySize setting.
     */
    _saveCookieState() {
        if (!this._currentBook || !this._readingState) return;

        const position = this._readingState.getCurrentPosition();
        const entry = {
            bookId: this._currentBook.id,
            bookTitle: this._currentBook.title,
            chapterIndex: position.chapterIndex,
            sentenceIndex: position.sentenceIndex,
            bookmarkCount: this._readingState.getBookmarks().length,
            highlightCount: this._readingState.getHighlights().length,
            source: this._currentBook.source || null,
            fileType: this._currentBook.fileType || 'epub',
            timestamp: Date.now()
        };

        try {
            // Load existing history
            let history = this._loadCookieState();

            // Remove any existing entry for this book
            history = history.filter(h => h.bookId !== entry.bookId);

            // Add current book at the front (most recent)
            history.unshift(entry);

            // Trim to max history size
            const maxSize = this._readingHistorySize || 3;
            history = history.slice(0, maxSize);

            const stateJson = JSON.stringify(history);
            // Set cookie with 365-day expiry
            const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toUTCString();
            document.cookie = `readingPartnerState=${encodeURIComponent(stateJson)};expires=${expires};path=/;SameSite=Lax`;
        } catch (error) {
            console.error('Failed to save cookie state:', error);
        }
    }

    /**
     * Load reading history from cookie
     * @returns {Object[]} Array of saved book states (most recent first), or empty array
     */
    _loadCookieState() {
        try {
            const cookies = document.cookie.split(';');
            for (const cookie of cookies) {
                const [name, value] = cookie.trim().split('=');
                if (name === 'readingPartnerState' && value) {
                    const parsed = JSON.parse(decodeURIComponent(value));
                    // Migrate from old single-object format to array
                    if (parsed && !Array.isArray(parsed)) {
                        return [parsed];
                    }
                    return Array.isArray(parsed) ? parsed : [];
                }
            }
        } catch (error) {
            console.error('Failed to load cookie state:', error);
        }
        return [];
    }

    /**
     * Trim cookie history to match current readingHistorySize setting
     */
    _trimCookieHistory() {
        try {
            let history = this._loadCookieState();
            const maxSize = this._readingHistorySize || 3;
            if (history.length > maxSize) {
                history = history.slice(0, maxSize);
                const stateJson = JSON.stringify(history);
                const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toUTCString();
                document.cookie = `readingPartnerState=${encodeURIComponent(stateJson)};expires=${expires};path=/;SameSite=Lax`;
            }
        } catch (error) {
            console.error('Failed to trim cookie history:', error);
        }
    }

    /**
     * Check if there's a saved reading history and show resume options
     */
    _checkResumeState() {
        const history = this._loadCookieState();
        if (!history || history.length === 0) return;

        // Show resume section on the upload screen
        const uploadContainer = this._elements.uploadScreen?.querySelector('.upload-container');
        if (!uploadContainer) return;

        // Remove any existing resume section
        const existing = uploadContainer.querySelector('.resume-section');
        if (existing) existing.remove();

        const section = document.createElement('div');
        section.className = 'resume-section';

        // Section header
        const header = document.createElement('div');
        header.className = 'resume-section-title';
        header.textContent = 'Continue reading';
        section.appendChild(header);

        // Add a banner for each book in history
        for (const savedState of history) {
            if (!savedState.bookId) continue;

            const banner = document.createElement('div');
            banner.className = 'resume-banner';

            const timeAgo = this._formatTimeAgo(savedState.timestamp);
            const stats = [];
            if (savedState.bookmarkCount > 0) {
                stats.push(`${savedState.bookmarkCount} bookmark${savedState.bookmarkCount > 1 ? 's' : ''}`);
            }
            if (savedState.highlightCount > 0) {
                stats.push(`${savedState.highlightCount} highlight${savedState.highlightCount > 1 ? 's' : ''}`);
            }
            const statsText = stats.length > 0 ? ` (${stats.join(', ')})` : '';

            // Show source info
            let sourceText = '';
            if (savedState.source?.type === 'gutenberg') {
                sourceText = ' <span class="resume-source">from Project Gutenberg</span>';
            }

            // Format badge
            const ft = savedState.fileType || 'epub';
            const ftLabel = FORMAT_LABELS[ft] || ft.toUpperCase();
            const formatBadge = `<span class="format-badge format-badge-sm format-${ft}">${ftLabel}</span>`;

            banner.innerHTML = `
                <div class="resume-info">
                    <div class="resume-detail">${formatBadge} "${this._escapeHtml(savedState.bookTitle)}"${sourceText} - Chapter ${savedState.chapterIndex + 1}${statsText}</div>
                    <div class="resume-time">Last read ${timeAgo}</div>
                </div>
                <button class="btn btn-primary btn-sm resume-btn">Resume</button>
            `;

            const resumeBtn = banner.querySelector('.resume-btn');
            resumeBtn.addEventListener('click', () => {
                this._resumeLastBook(savedState);
            });

            section.appendChild(banner);
        }

        // Insert before the upload area
        const uploadArea = uploadContainer.querySelector('.upload-area');
        if (uploadArea) {
            uploadContainer.insertBefore(section, uploadArea);
        } else {
            uploadContainer.appendChild(section);
        }
    }

    /**
     * Resume reading the last book from saved state
     * @param {Object} savedState - Cookie state with bookId, source, etc.
     */
    async _resumeLastBook(savedState) {
        const { loadingIndicator, loadingText } = this._elements;
        const bookId = savedState.bookId;

        try {
            loadingIndicator.classList.remove('hidden');
            loadingText.textContent = 'Resuming book...';

            let openError = null;
            try {
                // Try to open the book from storage (includes file data)
                this._currentBook = await this._readingState.openBook(bookId);
            } catch (error) {
                openError = error;
            }

            // If opening failed, try re-downloading for Gutenberg books
            if (openError) {
                const source = savedState.source;
                if (source?.type === 'gutenberg' && source.bookId) {
                    console.log('File data not in storage, re-downloading from Gutenberg...');
                    loadingText.textContent = 'Re-downloading from Gutenberg...';
                    const { file, source: dlSource } = await this._downloadGutenbergEpub(source.bookId);
                    await this._loadBook(file, dlSource, bookId);
                    return; // _loadBook handles everything including screen switch
                }
                throw new Error(openError.message + '. Please load the file again.');
            }

            if (!this._currentBook.chapters.length) {
                throw new Error('No readable content found');
            }

            loadingText.textContent = 'Preparing reader...';

            // Initialize reader components (only once)
            if (!this._controls) {
                this._initializeReader();
            } else {
                this._readerView.setBookTitle(this._currentBook.title);
                this._controls.setEnabled(true);
                this._controls.setAskDisabled(!this._qaSettings.apiKey, 'Configure API key in Q&A Settings to enable voice questions');
            }

            // Clear navigation history for resumed book
            this._navigationHistory?.clear();
            this._viewDecoupled = false;

            // Get saved position
            const position = this._readingState.getCurrentPosition();

            // Load chapter at saved position
            await this._loadChapter(position.chapterIndex, false);

            // Update navigation
            this._navigation.setBook(this._currentBook, position.chapterIndex);
            this._navigation.setBookmarks(this._readingState.getBookmarks());
            this._navigation.setHighlights(this._readingState.getHighlights());

            // Load quiz history
            this._loadQuizHistory();

            // Restore sentence position
            if (position.sentenceIndex > 0) {
                this._audioController.goToSentence(position.sentenceIndex);
                this._readerView.highlightSentence(position.sentenceIndex);
                this._playbackSentenceIndex = position.sentenceIndex;
            }

            // Switch to reader screen
            this._showScreen('reader');

        } catch (error) {
            console.error('Failed to resume book:', error);
            this._showUploadError('Could not resume: ' + error.message);
        } finally {
            loadingIndicator.classList.add('hidden');
        }
    }

    /**
     * Format a timestamp as a relative time string
     * @param {number} timestamp
     * @returns {string}
     */
    _formatTimeAgo(timestamp) {
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

    /**
     * Show a toast notification
     * @param {string} message
     */
    _showToast(message) {
        // Create toast element
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.textContent = message;
        document.body.appendChild(toast);

        // Show toast
        setTimeout(() => {
            toast.classList.add('show');
        }, 10);

        // Hide and remove toast
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => {
                toast.remove();
            }, 300);
        }, 2000);
    }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    const app = new ReadingPartnerApp();
    app.init();

    // Expose for debugging
    window.readingPartner = app;
    window.ttsEngine = ttsEngine; // Direct access to TTS engine
});
