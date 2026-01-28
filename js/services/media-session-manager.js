/**
 * Media Session Manager
 * Integrates with the Media Session API to enable headset/media key controls
 *
 * Controls:
 * - Single tap (play/pause): Toggle TTS playback
 * - Double tap / Next track: Enter Q&A mode
 * - Double tap back / Previous track: Exit Q&A mode and continue reading
 */

class MediaSessionManager {
    constructor() {
        this._isSupported = 'mediaSession' in navigator;
        this._isInitialized = false;
        this._isQAModeActive = false;

        // Callbacks
        this._onPlay = null;
        this._onPause = null;
        this._onEnterQAMode = null;
        this._onExitQAMode = null;

        // Current metadata
        this._bookTitle = '';
        this._chapterTitle = '';
        this._author = '';

        // Playback state
        this._playbackState = 'paused'; // 'playing', 'paused', 'none'
    }

    /**
     * Check if Media Session API is supported
     * @returns {boolean}
     */
    isSupported() {
        return this._isSupported;
    }

    /**
     * Initialize the Media Session manager with callbacks
     * @param {Object} options
     * @param {() => void} options.onPlay - Called when play is triggered
     * @param {() => void} options.onPause - Called when pause is triggered
     * @param {() => void} options.onEnterQAMode - Called when Q&A mode should start (double tap / next track)
     * @param {() => void} options.onExitQAMode - Called when Q&A mode should end (previous track)
     */
    initialize({ onPlay, onPause, onEnterQAMode, onExitQAMode }) {
        if (!this._isSupported) {
            console.warn('Media Session API not supported');
            return;
        }

        this._onPlay = onPlay;
        this._onPause = onPause;
        this._onEnterQAMode = onEnterQAMode;
        this._onExitQAMode = onExitQAMode;

        this._setupActionHandlers();
        this._isInitialized = true;

        console.log('Media Session Manager initialized');
    }

    /**
     * Setup Media Session action handlers
     */
    _setupActionHandlers() {
        // Play action (single tap when paused)
        navigator.mediaSession.setActionHandler('play', () => {
            console.log('Media Session: play');
            if (this._isQAModeActive) {
                // If in Q&A mode, ignore play - Q&A has its own flow
                return;
            }
            this._onPlay?.();
        });

        // Pause action (single tap when playing)
        navigator.mediaSession.setActionHandler('pause', () => {
            console.log('Media Session: pause');
            if (this._isQAModeActive) {
                // If in Q&A mode, ignore pause - Q&A has its own flow
                return;
            }
            this._onPause?.();
        });

        // Next track (double tap on most headsets) - Enter Q&A mode
        navigator.mediaSession.setActionHandler('nexttrack', () => {
            console.log('Media Session: nexttrack -> Enter Q&A mode');
            if (!this._isQAModeActive) {
                this._onEnterQAMode?.();
            }
        });

        // Previous track - Exit Q&A mode and continue reading
        navigator.mediaSession.setActionHandler('previoustrack', () => {
            console.log('Media Session: previoustrack -> Exit Q&A mode');
            if (this._isQAModeActive) {
                this._onExitQAMode?.();
            }
        });

        // Stop action (long press on some devices)
        navigator.mediaSession.setActionHandler('stop', () => {
            console.log('Media Session: stop');
            this._onPause?.();
        });

        // Seek actions are not applicable for TTS, but we should handle them gracefully
        try {
            navigator.mediaSession.setActionHandler('seekbackward', null);
            navigator.mediaSession.setActionHandler('seekforward', null);
            navigator.mediaSession.setActionHandler('seekto', null);
        } catch {
            // Some browsers may not support these handlers
        }
    }

    /**
     * Update the Media Session metadata
     * @param {Object} metadata
     * @param {string} [metadata.bookTitle] - Book title
     * @param {string} [metadata.chapterTitle] - Current chapter title
     * @param {string} [metadata.author] - Book author
     */
    updateMetadata({ bookTitle, chapterTitle, author } = {}) {
        if (!this._isSupported) return;

        if (bookTitle !== undefined) this._bookTitle = bookTitle;
        if (chapterTitle !== undefined) this._chapterTitle = chapterTitle;
        if (author !== undefined) this._author = author;

        // Build the title string
        let title = this._bookTitle || 'Reading Partner';
        if (this._chapterTitle) {
            title = this._chapterTitle;
        }

        // Set the Media Session metadata
        navigator.mediaSession.metadata = new MediaMetadata({
            title: title,
            artist: this._author || 'Reading Partner',
            album: this._bookTitle || '',
            artwork: [
                // Could add book cover here if available
                // { src: '/icons/icon-96.png', sizes: '96x96', type: 'image/png' },
                // { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            ]
        });
    }

    /**
     * Update the playback state
     * @param {'playing'|'paused'|'stopped'|'buffering'} state
     */
    setPlaybackState(state) {
        if (!this._isSupported) return;

        // Map our states to Media Session states
        let mediaState = 'none';
        if (state === 'playing') {
            mediaState = 'playing';
        } else if (state === 'paused' || state === 'buffering') {
            mediaState = 'paused';
        }

        this._playbackState = mediaState;
        navigator.mediaSession.playbackState = mediaState;
    }

    /**
     * Set Q&A mode active state
     * When in Q&A mode, play/pause actions are ignored
     * @param {boolean} active
     */
    setQAModeActive(active) {
        this._isQAModeActive = active;

        if (active) {
            // Update metadata to show Q&A mode
            navigator.mediaSession.metadata = new MediaMetadata({
                title: 'Q&A Mode - Ask a question',
                artist: this._bookTitle || 'Reading Partner',
                album: ''
            });
        } else {
            // Restore normal metadata
            this.updateMetadata({});
        }
    }

    /**
     * Check if Q&A mode is active
     * @returns {boolean}
     */
    isQAModeActive() {
        return this._isQAModeActive;
    }

    /**
     * Cleanup and release Media Session
     */
    destroy() {
        if (!this._isSupported) return;

        // Clear action handlers
        try {
            navigator.mediaSession.setActionHandler('play', null);
            navigator.mediaSession.setActionHandler('pause', null);
            navigator.mediaSession.setActionHandler('nexttrack', null);
            navigator.mediaSession.setActionHandler('previoustrack', null);
            navigator.mediaSession.setActionHandler('stop', null);
        } catch {
            // Ignore errors during cleanup
        }

        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = 'none';

        this._isInitialized = false;
    }
}

// Export singleton instance
export const mediaSessionManager = new MediaSessionManager();
