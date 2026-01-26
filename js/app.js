/**
 * Reading Partner - Main Application
 * EPUB TTS Reader with Q&A capabilities
 */

import { epubParser } from './services/epub-parser.js';
import { ttsEngine } from './services/tts-engine.js';
import { storage } from './services/storage.js';
import { llmClient, OPENROUTER_MODELS, DEFAULT_MODEL } from './services/llm-client.js';
import { AudioController } from './controllers/audio-controller.js';
import { QAController, QAState } from './controllers/qa-controller.js';
import { ReadingStateController } from './state/reading-state.js';
import { ReaderView } from './ui/reader-view.js';
import { PlaybackControls } from './ui/controls.js';
import { NavigationPanel } from './ui/navigation.js';
import { QAOverlay } from './ui/qa-overlay.js';
import { SettingsModal } from './ui/settings-modal.js';

class ReadingPartnerApp {
    constructor() {
        // State
        this._currentBook = null;
        this._currentChapterIndex = 0;
        this._isInitialized = false;
        this._savedSpeed = undefined;
        this._savedVoice = undefined;
        this._wasPlayingBeforeQA = false;

        // Q&A Settings
        this._qaSettings = {
            apiKey: '',
            model: DEFAULT_MODEL,
            contextBefore: 20,
            contextAfter: 5
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
        this._settingsModal = null;
    }

    /**
     * Initialize the application
     */
    async init() {
        this._cacheElements();
        this._setupUploadHandlers();
        this._setupKeyboardShortcuts();
        this._setupQASetup();

        // Initialize storage and reading state
        this._readingState = new ReadingStateController({
            onPositionChange: (chapterIndex, sentenceIndex) => {
                this._onPositionChange(chapterIndex, sentenceIndex);
            },
            onBookmarksChange: () => {
                this._onBookmarksChange();
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
                onAddBookmark: () => this._addBookmark()
            }
        );

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

        // Initialize Settings Modal
        this._settingsModal = new SettingsModal(
            { container: document.getElementById('settings-modal') },
            {
                onClose: () => this._settingsModal.hide(),
                onSave: (settings) => this._saveQASettings(settings),
                onBackendChange: (backend) => this._onTTSBackendChange(backend)
            }
        );

        // Setup settings button
        this._elements.settingsBtn = document.getElementById('settings-btn');
        this._elements.settingsBtn?.addEventListener('click', () => {
            this._settingsModal.setSettings(this._qaSettings);
            this._settingsModal.show();
        });

        // Setup load book button
        this._elements.loadBookBtn?.addEventListener('click', () => {
            this._triggerLoadNewBook();
        });

        // Load saved settings first so we know the preferred backend
        await this._loadSettings();

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

            if (savedFastApiUrl) {
                ttsEngine.setFastApiUrl(savedFastApiUrl);
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
            browseBtn: document.getElementById('browse-btn'),
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
            speedSlider: document.getElementById('speed-slider'),
            speedValue: document.getElementById('speed-value'),
            voiceSelect: document.getElementById('voice-select'),

            // Header actions
            loadBookBtn: document.getElementById('load-book-btn'),

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
                    this._navigateToPrevChapter();
                    break;
                case 'KeyN':
                    e.preventDefault();
                    this._navigateToNextChapter();
                    break;
                case 'PageUp':
                    e.preventDefault();
                    this._readerView?.previousPage();
                    break;
                case 'PageDown':
                    e.preventDefault();
                    this._readerView?.nextPage();
                    break;
            }
        });
    }

    /**
     * Trigger file picker to load a new book from the reader screen
     */
    _triggerLoadNewBook() {
        // Create a temporary file input (reuse won't work if same file is selected)
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.epub';
        input.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (file) {
                this._loadNewBook(file);
            }
        });
        input.click();
    }

    /**
     * Load a new book while already in the reader screen
     * @param {File} file
     */
    async _loadNewBook(file) {
        // Stop any current playback
        this._pause();

        // Stop Q&A if active
        this._qaController?.stop();
        this._qaOverlay?.hide();

        // Reset Q&A controller book metadata
        if (this._qaController) {
            this._qaController.setBookMeta(null);
            this._qaController.clearHistory();
        }

        // Reset chapter index
        this._currentChapterIndex = 0;

        // Load the book using the existing _loadBook flow
        await this._loadBook(file);
    }

    /**
     * Load a book from file
     * @param {File} file
     */
    async _loadBook(file) {
        const { loadingIndicator, loadingText } = this._elements;
        const isFromReader = this._elements.readerScreen.classList.contains('active');

        try {
            // Show loading feedback
            if (isFromReader) {
                this._showTTSStatus('Loading new book...');
            } else {
                loadingIndicator.classList.remove('hidden');
                loadingText.textContent = 'Parsing EPUB...';
            }

            // Parse EPUB and save to storage
            this._currentBook = await this._readingState.loadBook(file);

            if (!this._currentBook.chapters.length) {
                throw new Error('No readable content found in this EPUB');
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
                this._controls.setAskDisabled(!this._qaSettings.apiKey);
            }

            // Get saved position
            const position = this._readingState.getCurrentPosition();

            // Load chapter at saved position
            await this._loadChapter(position.chapterIndex, false);

            // Update navigation
            this._navigation.setBook(this._currentBook, position.chapterIndex);
            this._navigation.setBookmarks(this._readingState.getBookmarks());

            // Restore sentence position
            if (position.sentenceIndex > 0) {
                this._audioController.goToSentence(position.sentenceIndex);
                this._readerView.highlightSentence(position.sentenceIndex);
            }

            // Switch to reader screen
            this._showScreen('reader');

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
            onSentenceClick: (index) => {
                this._audioController?.goToSentence(index);
            },
            onLinkClick: (href) => {
                this._handleInternalLink(href);
            }
        });

        // Initialize AudioController
        this._audioController = new AudioController({
            onSentenceChange: (index) => {
                this._readerView.highlightSentence(index);
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
                prevChapterBtn: this._elements.prevChapterBtn,
                nextChapterBtn: this._elements.nextChapterBtn,
                askBtn: this._elements.askBtn,
                speedSlider: this._elements.speedSlider,
                speedValue: this._elements.speedValue,
                voiceSelect: this._elements.voiceSelect
            },
            {
                onPlay: () => this._play(),
                onPause: () => this._pause(),
                onPrev: () => this._audioController.skipBackward(1),
                onNext: () => this._audioController.skipForward(),
                onPrevChapter: () => this._navigateToPrevChapter(),
                onNextChapter: () => this._navigateToNextChapter(),
                onAsk: () => this._startQA(),
                onSpeedChange: (speed) => {
                    this._audioController.setSpeed(speed);
                    this._saveSettings(); // Auto-save speed setting
                },
                onVoiceChange: (voiceId) => {
                    ttsEngine.setVoice(voiceId);
                    this._saveSettings(); // Auto-save voice setting
                }
            }
        );

        // Populate available voices
        const voices = ttsEngine.getAvailableVoices();
        this._controls.setVoices(voices);

        // Restore saved voice
        if (this._savedVoice) {
            this._controls.setVoice(this._savedVoice);
            ttsEngine.setVoice(this._savedVoice);
        }

        // Restore saved speed
        if (this._savedSpeed !== undefined) {
            this._controls.setSpeed(this._savedSpeed);
            this._audioController.setSpeed(this._savedSpeed);
        }

        // Set book title
        this._readerView.setBookTitle(this._currentBook.title);

        // Enable controls
        this._controls.setEnabled(true);

        // Enable/disable Ask button based on API key configuration
        this._controls.setAskDisabled(!this._qaSettings.apiKey);
    }

    /**
     * Load a chapter (lazy loading)
     * @param {number} chapterIndex
     * @param {boolean} [autoSkipEmpty=true] - Skip to next chapter if empty
     */
    async _loadChapter(chapterIndex, autoSkipEmpty = true) {
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

        // Auto-skip empty chapters
        if (sentences.length === 0 && autoSkipEmpty) {
            console.log(`Chapter ${chapterIndex} is empty, skipping to next...`);
            if (chapterIndex < this._currentBook.chapters.length - 1) {
                return this._loadChapter(chapterIndex + 1, autoSkipEmpty);
            } else {
                this._readerView.showError('No readable content found');
                return;
            }
        }

        // Get the HTML content (may be null for older cached chapters)
        const html = this._currentBook.chapters[chapterIndex].html || null;

        // Update UI with loaded content - pass HTML for full rendering
        this._readerView.renderSentences(sentences, 0, html);
        this._readerView.scrollToTop();

        // Update audio controller
        this._audioController.setSentences(sentences, 0);
    }

    /**
     * Handle chapter end
     */
    async _onChapterEnd() {
        // Auto-advance to next chapter if available
        if (this._currentChapterIndex < this._currentBook.chapters.length - 1) {
            const nextChapterIndex = this._currentChapterIndex + 1;

            // Update reading state
            this._readingState.goToChapter(nextChapterIndex, 0);

            // Load next chapter
            await this._loadChapter(nextChapterIndex);

            // Update navigation
            this._navigation.setCurrentChapter(nextChapterIndex);

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
            this._qaSettings.contextAfter
        );
        this._qaController.setPlaybackSpeed(this._controls?.getSpeed() || 1.0);

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
    }

    /**
     * Continue reading from Q&A
     */
    _continueReadingFromQA() {
        this._qaController?.stop();
        this._qaOverlay.hide();

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
            // Update FastAPI URL if changed
            const settings = this._settingsModal.getSettings();
            ttsEngine.setFastApiUrl(settings.fastApiUrl);

            await ttsEngine.setBackend(backend);
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

            // Refresh voice list
            if (this._controls) {
                const voices = ttsEngine.getAvailableVoices();
                this._controls.setVoices(voices);
            }

            setTimeout(() => this._hideTTSStatus(), 3000);
        } catch (error) {
            console.error('Failed to switch TTS backend:', error);
            this._showTTSStatus('Backend switch failed');
            setTimeout(() => this._hideTTSStatus(), 5000);
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
                this._qaSettings.contextAfter
            );
        }

        // Save to storage
        try {
            await storage.saveSetting('qaApiKey', this._qaSettings.apiKey);
            await storage.saveSetting('qaModel', this._qaSettings.model);
            await storage.saveSetting('qaContextBefore', this._qaSettings.contextBefore);
            await storage.saveSetting('qaContextAfter', this._qaSettings.contextAfter);

            // Save TTS backend settings
            if (settings.ttsBackend) {
                await storage.saveSetting('ttsBackend', settings.ttsBackend);
            }
            if (settings.fastApiUrl) {
                await storage.saveSetting('fastApiUrl', settings.fastApiUrl);
            }
        } catch (error) {
            console.error('Failed to save settings:', error);
        }

        // Update UI
        this._updateQASetupStatus();

        // Update settings modal
        this._settingsModal.setSettings(this._qaSettings);

        // Enable/disable Ask button based on API key
        if (this._controls) {
            this._controls.setAskDisabled(!this._qaSettings.apiKey);
        }
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

    /**
     * Navigate to the previous chapter
     */
    async _navigateToPrevChapter() {
        if (!this._currentBook || this._currentChapterIndex <= 0) return;
        await this._navigateToChapter(this._currentChapterIndex - 1);
    }

    /**
     * Navigate to the next chapter
     */
    async _navigateToNextChapter() {
        if (!this._currentBook || this._currentChapterIndex >= this._currentBook.chapters.length - 1) return;
        await this._navigateToChapter(this._currentChapterIndex + 1);
    }

    /**
     * Navigate to a chapter
     * @param {number} chapterIndex
     */
    async _navigateToChapter(chapterIndex) {
        if (chapterIndex === this._currentChapterIndex) {
            return;
        }

        // Pause playback
        this._pause();

        // Update state
        this._readingState.goToChapter(chapterIndex, 0);

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
        // Pause playback
        this._pause();

        // Update state
        this._readingState.goToBookmark(bookmark);

        // Load chapter if different
        if (bookmark.chapterIndex !== this._currentChapterIndex) {
            await this._loadChapter(bookmark.chapterIndex, false);
            this._navigation.setCurrentChapter(bookmark.chapterIndex);
        }

        // Go to sentence
        this._audioController.goToSentence(bookmark.sentenceIndex);
        this._readerView.highlightSentence(bookmark.sentenceIndex);
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

        // Navigate to the target chapter if it's different from the current one
        if (targetIndex !== this._currentChapterIndex) {
            this._pause();
            this._readingState.goToChapter(targetIndex, 0);
            await this._loadChapter(targetIndex, false);
            this._navigation.setCurrentChapter(targetIndex);
            this._audioController.goToSentence(0);
            this._readerView.highlightSentence(0);
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

    /**
     * Handle position change
     * @param {number} chapterIndex
     * @param {number} sentenceIndex
     */
    _onPositionChange(chapterIndex, sentenceIndex) {
        // This is called when position changes programmatically
        // Could be used for UI updates if needed
    }

    /**
     * Handle bookmarks change
     */
    _onBookmarksChange() {
        // Update navigation if it exists
        if (this._navigation && this._readingState) {
            this._navigation.setBookmarks(this._readingState.getBookmarks());
        }
    }

    /**
     * Load settings from storage
     */
    async _loadSettings() {
        try {
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

            const contextBefore = await storage.getSetting('qaContextBefore');
            if (contextBefore !== null) {
                this._qaSettings.contextBefore = contextBefore;
            }

            const contextAfter = await storage.getSetting('qaContextAfter');
            if (contextAfter !== null) {
                this._qaSettings.contextAfter = contextAfter;
            }

            // Update Q&A setup UI
            this._updateQASetupStatus();

            // Update settings modal
            this._settingsModal?.setSettings(this._qaSettings);

        } catch (error) {
            console.error('Failed to load settings:', error);
        }
    }

    /**
     * Save settings to storage
     */
    async _saveSettings() {
        try {
            if (this._controls) {
                const speed = this._controls.getSpeed();
                await storage.saveSetting('playbackSpeed', speed);

                const voice = this._controls.getVoice();
                await storage.saveSetting('voice', voice);
            }
        } catch (error) {
            console.error('Failed to save settings:', error);
        }
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
