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
 * audio loop that plays CONTINUOUSLY to keep the session active. The audio
 * element never pauses - only the playbackState changes to reflect TTS state.
 */

// Silent audio: ~2 seconds of silence as WAV
// Base64 encoded minimal WAV file (44 bytes header + silence)
// This keeps the Media Session active without producing any audible sound
const SILENT_WAV = (() => {
    // Create a valid WAV file with 2 seconds of silence at 8kHz mono 8-bit
    const sampleRate = 8000;
    const duration = 2; // seconds
    const numSamples = sampleRate * duration;
    const dataSize = numSamples;
    const fileSize = 44 + dataSize;

    const buffer = new ArrayBuffer(fileSize);
    const view = new DataView(buffer);

    // WAV header
    const writeString = (offset, string) => {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, fileSize - 8, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true); // fmt chunk size
    view.setUint16(20, 1, true); // PCM format
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate, true); // byte rate
    view.setUint16(32, 1, true); // block align
    view.setUint16(34, 8, true); // bits per sample
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    // Fill with silence (128 = silence for 8-bit PCM)
    for (let i = 44; i < fileSize; i++) {
        view.setUint8(i, 128);
    }

    // Convert to base64
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return 'data:audio/wav;base64,' + btoa(binary);
})();

class MediaSessionManager {
    constructor() {
        this._isSupported = 'mediaSession' in navigator;
        this._isInitialized = false;
        this._isQAModeActive = false;
        this._isTTSPlaying = false; // Track TTS state separately

        // Callbacks
        this._onPlay = null;
        this._onPause = null;
        this._onEnterQAMode = null;
        this._onExitQAMode = null;

        // Current metadata
        this._bookTitle = '';
        this._chapterTitle = '';
        this._author = '';

        // Silent audio element to keep Media Session active
        this._silentAudio = null;
        this._isSessionActive = false;
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
     *
     * IMPORTANT: This audio element plays CONTINUOUSLY and never pauses.
     * Only the playbackState is updated to reflect TTS state.
     */
    _createSilentAudio() {
        if (this._silentAudio) return;

        this._silentAudio = document.createElement('audio');
        this._silentAudio.src = SILENT_WAV;
        this._silentAudio.loop = true;
        // Use a very low but non-zero volume (muted audio doesn't activate Media Session on some browsers)
        this._silentAudio.volume = 0.001;

        // Prevent the audio from being visible in picture-in-picture or similar
        this._silentAudio.disablePictureInPicture = true;

        // Handle audio element events for debugging
        this._silentAudio.addEventListener('play', () => {
            console.log('Media Session: Silent audio started playing');
            this._isSessionActive = true;
        });

        this._silentAudio.addEventListener('pause', () => {
            console.log('Media Session: Silent audio paused (unexpected!)');
            this._isSessionActive = false;
            // Try to resume if paused unexpectedly
            this._ensureAudioPlaying();
        });

        this._silentAudio.addEventListener('ended', () => {
            console.log('Media Session: Silent audio ended (should not happen with loop)');
            this._ensureAudioPlaying();
        });

        this._silentAudio.addEventListener('error', (e) => {
            console.warn('Media Session: Silent audio error', e);
        });
    }

    /**
     * Ensure the silent audio is playing (call this on user interaction)
     */
    async _ensureAudioPlaying() {
        if (!this._silentAudio) return;

        if (this._silentAudio.paused) {
            try {
                await this._silentAudio.play();
                console.log('Media Session: Silent audio resumed');
            } catch (error) {
                console.log('Media Session: Could not play silent audio:', error.message);
            }
        }
    }

    /**
     * Activate the Media Session by starting silent audio playback
     * Call this on user interaction (e.g., when user clicks play)
     */
    async activateSession() {
        if (!this._silentAudio) return;

        try {
            // Start the silent audio - it will loop forever
            await this._silentAudio.play();
            this._isSessionActive = true;
            console.log('Media Session activated');
        } catch (error) {
            // Autoplay might be blocked - this is fine, user interaction will enable it
            console.log('Media Session activation pending user interaction:', error.message);
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
                return;
            }
            this._isTTSPlaying = true;
            navigator.mediaSession.playbackState = 'playing';
            this._onPlay?.();
        });

        // Pause action (single tap when playing)
        navigator.mediaSession.setActionHandler('pause', () => {
            console.log('Media Session: pause action received');
            if (this._isQAModeActive) {
                return;
            }
            this._isTTSPlaying = false;
            navigator.mediaSession.playbackState = 'paused';
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
            this._isTTSPlaying = false;
            navigator.mediaSession.playbackState = 'paused';
            this._onPause?.();
        });

        // Seek actions are not applicable for TTS
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
            artwork: []
        });
    }

    /**
     * Update the playback state
     * This should be called when TTS playback state changes.
     * IMPORTANT: This only updates the playbackState - the silent audio keeps playing.
     * @param {'playing'|'paused'|'stopped'|'buffering'} state
     */
    setPlaybackState(state) {
        if (!this._isSupported) return;

        // On any state change, ensure the silent audio is playing
        // This handles the case where it was blocked initially
        this._ensureAudioPlaying();

        // Map our states to Media Session states
        if (state === 'playing') {
            this._isTTSPlaying = true;
            navigator.mediaSession.playbackState = 'playing';
            // Activate session if not already (handles first play)
            if (!this._isSessionActive) {
                this.activateSession();
            }
        } else if (state === 'paused' || state === 'stopped') {
            this._isTTSPlaying = false;
            navigator.mediaSession.playbackState = 'paused';
        } else if (state === 'buffering') {
            // Keep current state during buffering, but ensure session is active
            if (!this._isSessionActive) {
                this.activateSession();
            }
        }

        console.log(`Media Session playback state: ${navigator.mediaSession.playbackState} (TTS: ${state})`);
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
            // Ensure session stays active during Q&A
            this._ensureAudioPlaying();
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
        return this._isSessionActive;
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
        this._isSessionActive = false;

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
