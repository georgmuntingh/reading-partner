/**
 * Media Session Manager
 * Integrates with the Media Session API to enable headset/media key controls
 *
 * Controls:
 * - Single tap (play/pause): Toggle TTS playback
 * - Double tap / Next track: Enter Q&A mode
 * - Double tap back / Previous track: Exit Q&A mode and continue reading
 *
 * IMPORTANT: The browser determines which action (play/pause) to send based on
 * the actual audio element state, NOT the playbackState property. So we must
 * keep the silent audio element's play/pause state in sync with TTS state.
 */

// Generate silent WAV audio programmatically
const SILENT_WAV = (() => {
    const sampleRate = 8000;
    const duration = 2;
    const numSamples = sampleRate * duration;
    const dataSize = numSamples;
    const fileSize = 44 + dataSize;

    const buffer = new ArrayBuffer(fileSize);
    const view = new DataView(buffer);

    const writeString = (offset, string) => {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, fileSize - 8, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate, true);
    view.setUint16(32, 1, true);
    view.setUint16(34, 8, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    for (let i = 44; i < fileSize; i++) {
        view.setUint8(i, 128);
    }

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

        // Callbacks
        this._onPlay = null;
        this._onPause = null;
        this._onEnterQAMode = null;
        this._onExitQAMode = null;

        // Current metadata
        this._bookTitle = '';
        this._chapterTitle = '';
        this._author = '';

        // Silent audio element
        this._silentAudio = null;
        this._hasUserInteraction = false;

        // Android detection - needs continuous audio for notification
        this._isAndroid = /Android/i.test(navigator.userAgent);
    }

    isSupported() {
        return this._isSupported;
    }

    /**
     * Initialize the Media Session manager
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
        console.log('Media Session debug: Call mediaSessionManager.diagnose() for diagnostic info');
    }

    /**
     * Create silent audio element
     * The audio element state (playing/paused) MUST match the TTS state
     * because the browser uses it to determine which action to send.
     */
    _createSilentAudio() {
        if (this._silentAudio) return;

        this._silentAudio = document.createElement('audio');
        this._silentAudio.src = SILENT_WAV;
        this._silentAudio.loop = true;
        this._silentAudio.volume = 0.001;
        this._silentAudio.preload = 'auto';

        this._silentAudio.addEventListener('play', () => {
            console.log('Media Session: Audio element started PLAYING');
        });

        this._silentAudio.addEventListener('pause', () => {
            console.log('Media Session: Audio element PAUSED');
        });

        this._silentAudio.addEventListener('error', (e) => {
            console.error('Media Session: Audio error', e.target.error);
        });

        // Preload the audio
        this._silentAudio.load();
    }

    /**
     * Setup Media Session action handlers
     *
     * On Android, we keep audio continuously playing to maintain notification,
     * so we use playbackState to determine actual state, not audio element.
     */
    _setupActionHandlers() {
        // PLAY action - browser sends this when audio is PAUSED
        // On Android with continuous audio, we check playbackState instead
        navigator.mediaSession.setActionHandler('play', async () => {
            console.log('Media Session: PLAY action received');
            if (this._isQAModeActive) {
                console.log('Media Session: Ignoring play - Q&A mode active');
                return;
            }

            // On Android, audio may already be playing, so check playbackState
            const currentState = navigator.mediaSession.playbackState;
            console.log(`Media Session: Current state is '${currentState}'`);

            if (currentState === 'paused' || currentState === 'none') {
                // Start the silent audio to keep session active
                try {
                    if (this._silentAudio.paused) {
                        await this._silentAudio.play();
                    }
                } catch (e) {
                    console.warn('Media Session: Could not play audio:', e.message);
                }

                navigator.mediaSession.playbackState = 'playing';
                this._onPlay?.();
            } else {
                // Already playing, maybe toggle to pause?
                console.log('Media Session: Already playing, ignoring duplicate play');
            }
        });

        // PAUSE action - browser sends this when audio is PLAYING
        // On Android with continuous audio, we check playbackState instead
        navigator.mediaSession.setActionHandler('pause', () => {
            console.log('Media Session: PAUSE action received');
            if (this._isQAModeActive) {
                console.log('Media Session: Ignoring pause - Q&A mode active');
                return;
            }

            // On Android, we might get pause actions even when logically paused
            const currentState = navigator.mediaSession.playbackState;
            console.log(`Media Session: Current state is '${currentState}'`);

            if (currentState === 'playing') {
                // On desktop, pause the silent audio so next button sends "play"
                // On Android, keep audio playing but set state to paused
                if (!this._isAndroid) {
                    this._silentAudio.pause();
                }

                navigator.mediaSession.playbackState = 'paused';
                this._onPause?.();
            } else if (currentState === 'paused' || currentState === 'none') {
                // Received pause but we're already paused - treat as toggle/play
                console.log('Media Session: Received pause while paused, treating as play');
                try {
                    if (this._silentAudio.paused) {
                        this._silentAudio.play();
                    }
                } catch (e) {
                    console.warn('Media Session: Could not play audio:', e.message);
                }
                navigator.mediaSession.playbackState = 'playing';
                this._onPlay?.();
            }
        });

        // Next track (double tap on headsets) - Enter Q&A mode
        navigator.mediaSession.setActionHandler('nexttrack', () => {
            console.log('Media Session: NEXTTRACK action received');
            if (!this._isQAModeActive) {
                this._onEnterQAMode?.();
            }
        });

        // Previous track - Exit Q&A mode
        navigator.mediaSession.setActionHandler('previoustrack', () => {
            console.log('Media Session: PREVIOUSTRACK action received');
            if (this._isQAModeActive) {
                this._onExitQAMode?.();
            }
        });

        navigator.mediaSession.setActionHandler('stop', () => {
            console.log('Media Session: STOP action received');
            this._silentAudio.pause();
            navigator.mediaSession.playbackState = 'paused';
            this._onPause?.();
        });

        try {
            navigator.mediaSession.setActionHandler('seekbackward', null);
            navigator.mediaSession.setActionHandler('seekforward', null);
            navigator.mediaSession.setActionHandler('seekto', null);
        } catch {
            // Not supported
        }
    }

    /**
     * Update metadata
     */
    updateMetadata({ bookTitle, chapterTitle, author } = {}) {
        if (!this._isSupported) return;

        if (bookTitle !== undefined) this._bookTitle = bookTitle;
        if (chapterTitle !== undefined) this._chapterTitle = chapterTitle;
        if (author !== undefined) this._author = author;

        let title = this._bookTitle || 'Reading Partner';
        if (this._chapterTitle) {
            title = this._chapterTitle;
        }

        navigator.mediaSession.metadata = new MediaMetadata({
            title: title,
            artist: this._author || 'Reading Partner',
            album: this._bookTitle || '',
            artwork: []
        });

        console.log('Media Session: Metadata updated -', title);
    }

    /**
     * Update playback state - MUST sync audio element state with TTS state
     * This is critical: browser uses audio.paused to decide play vs pause action
     *
     * ANDROID EXCEPTION: On Android, we keep silent audio playing continuously
     * to maintain the notification. We rely solely on playbackState for logic.
     */
    async setPlaybackState(state) {
        if (!this._isSupported) return;

        console.log(`Media Session: setPlaybackState(${state}), Android=${this._isAndroid}`);

        if (state === 'playing') {
            // TTS is playing - ensure audio is playing
            try {
                if (this._silentAudio.paused) {
                    await this._silentAudio.play();
                }
                this._hasUserInteraction = true;
            } catch (e) {
                console.warn('Media Session: Could not start audio:', e.message);
            }
            navigator.mediaSession.playbackState = 'playing';

        } else if (state === 'paused' || state === 'stopped') {
            navigator.mediaSession.playbackState = 'paused';

            // On Android, keep audio playing to maintain notification
            // On other platforms, pause audio so next press sends "play"
            if (this._isAndroid) {
                // Keep silent audio playing to maintain Android notification
                try {
                    if (this._hasUserInteraction && this._silentAudio.paused) {
                        await this._silentAudio.play();
                    }
                } catch (e) {
                    console.warn('Media Session: Could not maintain audio:', e.message);
                }
            } else {
                // Desktop: pause audio so next button press sends "play" action
                this._silentAudio.pause();
            }

        } else if (state === 'buffering') {
            // During buffering, keep current state
            // Don't change audio element state during buffering
        }

        console.log(`Media Session: playbackState=${navigator.mediaSession.playbackState}, audio.paused=${this._silentAudio.paused}`);
    }

    /**
     * Set Q&A mode active
     */
    setQAModeActive(active) {
        this._isQAModeActive = active;
        console.log(`Media Session: Q&A mode ${active ? 'ACTIVE' : 'INACTIVE'}`);

        if (active) {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: 'Q&A Mode - Ask a question',
                artist: this._bookTitle || 'Reading Partner',
                album: ''
            });
            // Keep audio playing during Q&A so we can receive controls
            if (this._hasUserInteraction) {
                this._silentAudio.play().catch(() => {});
            }
        } else {
            this.updateMetadata({});
        }
    }

    isQAModeActive() {
        return this._isQAModeActive;
    }

    /**
     * Diagnostic function - call from console: mediaSessionManager.diagnose()
     */
    diagnose() {
        const info = {
            supported: this._isSupported,
            initialized: this._isInitialized,
            hasUserInteraction: this._hasUserInteraction,
            isAndroid: this._isAndroid,
            audioElement: this._silentAudio ? {
                paused: this._silentAudio.paused,
                currentTime: this._silentAudio.currentTime,
                duration: this._silentAudio.duration,
                readyState: this._silentAudio.readyState,
                volume: this._silentAudio.volume,
                src: this._silentAudio.src ? 'set' : 'not set'
            } : 'not created',
            mediaSession: {
                playbackState: navigator.mediaSession?.playbackState,
                metadata: navigator.mediaSession?.metadata ? {
                    title: navigator.mediaSession.metadata.title,
                    artist: navigator.mediaSession.metadata.artist
                } : 'not set'
            },
            qaMode: this._isQAModeActive
        };

        console.log('=== Media Session Diagnostic ===');
        console.log(JSON.stringify(info, null, 2));
        console.log('================================');

        // Android-specific tips
        console.log('\n📱 Android Troubleshooting:');
        console.log('1. Check notification shade - do you see Reading Partner media controls?');
        console.log('2. Is another app (Spotify, YouTube) controlling media?');
        console.log('3. Try: Tap play button in app first, then use headset');
        console.log('4. Make sure page is served over HTTPS');
        console.log('5. Try locking/unlocking phone to refresh media session');

        return info;
    }

    /**
     * Force start - call this from a user click to initialize on Android
     */
    async forceStart() {
        console.log('Media Session: Force starting...');
        try {
            await this._silentAudio.play();
            this._hasUserInteraction = true;

            // On Android, set to 'playing' to trigger notification
            // On desktop, set to 'paused' so first button press sends "play"
            navigator.mediaSession.playbackState = this._isAndroid ? 'playing' : 'paused';
            console.log(`Media Session: Force start successful, playbackState=${navigator.mediaSession.playbackState}`);

            if (this._isAndroid) {
                // On Android, keep audio playing to maintain notification
                console.log('Media Session: Keeping silent audio playing for Android notification');
            } else {
                // On desktop, pause after a moment so next button press sends "play"
                setTimeout(() => {
                    this._silentAudio.pause();
                    console.log('Media Session: Ready for headset controls');
                }, 500);
            }

            return true;
        } catch (e) {
            console.error('Media Session: Force start failed:', e);
            return false;
        }
    }

    destroy() {
        if (!this._isSupported) return;

        if (this._silentAudio) {
            this._silentAudio.pause();
            this._silentAudio.src = '';
            this._silentAudio = null;
        }

        try {
            navigator.mediaSession.setActionHandler('play', null);
            navigator.mediaSession.setActionHandler('pause', null);
            navigator.mediaSession.setActionHandler('nexttrack', null);
            navigator.mediaSession.setActionHandler('previoustrack', null);
            navigator.mediaSession.setActionHandler('stop', null);
        } catch {
            // Ignore
        }

        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = 'none';
        this._isInitialized = false;
    }
}

// Export singleton instance
export const mediaSessionManager = new MediaSessionManager();

// Expose for debugging in console
if (typeof window !== 'undefined') {
    window.mediaSessionManager = mediaSessionManager;
}
