/**
 * Media Session Manager
 * Integrates with the Media Session API to enable headset/media key controls
 *
 * Controls:
 * - Single tap (play/pause): Toggle TTS playback
 * - Double tap / Next track: Enter Q&A mode
 * - Double tap back / Previous track: Exit Q&A mode and continue reading
 *
 * IMPORTANT: The Media Session API requires an active <audio> element to work
 * properly with system media controls and Bluetooth headsets. We use a silent
 * audio loop to keep the session active while our actual TTS plays via Web Audio API.
 */

// Silent audio: 1 second of silence encoded as MP3
// This keeps the Media Session active without producing any sound
const SILENT_AUDIO_BASE64 = 'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAABhgC7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7//////////////////////////////////////////////////////////////////8AAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAAJAAAAAAAAAAAAYYoRwmHAAAAAAD/+1DEAAAGAAGn9AAAIAAANIKQAABEqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq//tQxBaAAADSAAAAAAAAANIAAAAASqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';

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

        // Silent audio element to keep Media Session active
        this._silentAudio = null;
        this._isAudioActive = false;
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

        this._createSilentAudio();
        this._setupActionHandlers();
        this._isInitialized = true;

        console.log('Media Session Manager initialized');
    }

    /**
     * Create a silent audio element to keep Media Session active
     * This is required because the Media Session API needs an active <audio>
     * element to receive media key events, especially on mobile devices.
     */
    _createSilentAudio() {
        if (this._silentAudio) return;

        this._silentAudio = document.createElement('audio');
        this._silentAudio.src = SILENT_AUDIO_BASE64;
        this._silentAudio.loop = true;
        this._silentAudio.volume = 0.01; // Nearly silent but not muted (muted audio doesn't activate Media Session)

        // Handle audio element events
        this._silentAudio.addEventListener('play', () => {
            console.log('Media Session: Silent audio playing');
        });

        this._silentAudio.addEventListener('pause', () => {
            console.log('Media Session: Silent audio paused');
        });

        this._silentAudio.addEventListener('error', (e) => {
            console.warn('Media Session: Silent audio error', e);
        });
    }

    /**
     * Activate the Media Session by playing silent audio
     * Call this when TTS playback starts
     */
    async activateSession() {
        if (!this._silentAudio || this._isAudioActive) return;

        try {
            await this._silentAudio.play();
            this._isAudioActive = true;
            console.log('Media Session activated');
        } catch (error) {
            // Autoplay might be blocked - this is fine, user interaction will enable it
            console.log('Media Session activation pending user interaction:', error.message);
        }
    }

    /**
     * Pause the silent audio (keeps session but shows paused state)
     */
    pauseSession() {
        if (!this._silentAudio) return;

        this._silentAudio.pause();
        this._isAudioActive = false;
    }

    /**
     * Resume the silent audio
     */
    async resumeSession() {
        if (!this._silentAudio) return;

        try {
            await this._silentAudio.play();
            this._isAudioActive = true;
        } catch (error) {
            console.warn('Failed to resume Media Session:', error.message);
        }
    }

    /**
     * Setup Media Session action handlers
     */
    _setupActionHandlers() {
        // Play action (single tap when paused)
        navigator.mediaSession.setActionHandler('play', () => {
            console.log('Media Session: play action received');
            if (this._isQAModeActive) {
                // If in Q&A mode, ignore play - Q&A has its own flow
                return;
            }
            // Resume our silent audio to keep session active
            this.resumeSession();
            this._onPlay?.();
        });

        // Pause action (single tap when playing)
        navigator.mediaSession.setActionHandler('pause', () => {
            console.log('Media Session: pause action received');
            if (this._isQAModeActive) {
                // If in Q&A mode, ignore pause - Q&A has its own flow
                return;
            }
            // Pause our silent audio
            this.pauseSession();
            this._onPause?.();
        });

        // Next track (double tap on most headsets) - Enter Q&A mode
        navigator.mediaSession.setActionHandler('nexttrack', () => {
            console.log('Media Session: nexttrack action received -> Enter Q&A mode');
            if (!this._isQAModeActive) {
                this._onEnterQAMode?.();
            }
        });

        // Previous track - Exit Q&A mode and continue reading
        navigator.mediaSession.setActionHandler('previoustrack', () => {
            console.log('Media Session: previoustrack action received -> Exit Q&A mode');
            if (this._isQAModeActive) {
                this._onExitQAMode?.();
            }
        });

        // Stop action (long press on some devices)
        navigator.mediaSession.setActionHandler('stop', () => {
            console.log('Media Session: stop action received');
            this.pauseSession();
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
     * This should be called when TTS playback state changes
     * @param {'playing'|'paused'|'stopped'|'buffering'} state
     */
    setPlaybackState(state) {
        if (!this._isSupported) return;

        // Map our states to Media Session states
        let mediaState = 'none';
        if (state === 'playing') {
            mediaState = 'playing';
            // Activate the silent audio to keep Media Session engaged
            this.activateSession();
        } else if (state === 'paused') {
            mediaState = 'paused';
            this.pauseSession();
        } else if (state === 'buffering') {
            mediaState = 'paused'; // Show as paused during buffering
            // Keep audio active during buffering so we can receive controls
            this.activateSession();
        } else {
            mediaState = 'none';
            this.pauseSession();
        }

        this._playbackState = mediaState;
        navigator.mediaSession.playbackState = mediaState;

        console.log(`Media Session playback state: ${mediaState}`);
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
            // Keep session active during Q&A
            this.activateSession();
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
     * Check if Media Session is currently active
     * @returns {boolean}
     */
    isActive() {
        return this._isAudioActive;
    }

    /**
     * Cleanup and release Media Session
     */
    destroy() {
        if (!this._isSupported) return;

        // Stop and cleanup silent audio
        if (this._silentAudio) {
            this._silentAudio.pause();
            this._silentAudio.src = '';
            this._silentAudio = null;
        }
        this._isAudioActive = false;

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
