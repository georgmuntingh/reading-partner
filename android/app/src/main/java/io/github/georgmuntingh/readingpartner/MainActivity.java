package io.github.georgmuntingh.readingpartner;

import android.content.Intent;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Bundle;
import android.util.Log;
import android.view.KeyEvent;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

/**
 * Wires Android media-button key events (Bluetooth/wired headset play/pause/
 * next/previous) to the JavaScript Media Session handlers.
 *
 * The web Media Session API is unreliable inside Android WebView — headset
 * buttons often never reach the page. We register a native MediaSession so
 * Android routes those buttons to us, and forward them as `native-media-key`
 * CustomEvents into the WebView.
 */
public class MainActivity extends BridgeActivity {
    private static final String TAG = "ReadingPartner";

    private MediaSession mediaSession;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setupMediaSession();
    }

    private void setupMediaSession() {
        try {
            mediaSession = new MediaSession(this, "ReadingPartner");
            mediaSession.setCallback(new MediaSession.Callback() {
                @Override
                public void onPlay() { dispatch("play"); }

                @Override
                public void onPause() { dispatch("pause"); }

                @Override
                public void onSkipToNext() { dispatch("nexttrack"); }

                @Override
                public void onSkipToPrevious() { dispatch("previoustrack"); }

                @Override
                public void onStop() { dispatch("stop"); }

                @Override
                public boolean onMediaButtonEvent(Intent mediaButtonIntent) {
                    KeyEvent event = mediaButtonIntent.getParcelableExtra(Intent.EXTRA_KEY_EVENT);
                    if (event != null && event.getAction() == KeyEvent.ACTION_DOWN) {
                        if (forwardKey(event.getKeyCode())) {
                            return true;
                        }
                    }
                    return super.onMediaButtonEvent(mediaButtonIntent);
                }
            });

            long actions =
                PlaybackState.ACTION_PLAY |
                PlaybackState.ACTION_PAUSE |
                PlaybackState.ACTION_PLAY_PAUSE |
                PlaybackState.ACTION_STOP |
                PlaybackState.ACTION_SKIP_TO_NEXT |
                PlaybackState.ACTION_SKIP_TO_PREVIOUS;

            PlaybackState state = new PlaybackState.Builder()
                .setActions(actions)
                .setState(PlaybackState.STATE_PAUSED, 0, 1.0f)
                .build();
            mediaSession.setPlaybackState(state);
            mediaSession.setActive(true);
        } catch (Exception e) {
            Log.e(TAG, "Failed to set up MediaSession", e);
        }
    }

    private boolean forwardKey(int keyCode) {
        switch (keyCode) {
            case KeyEvent.KEYCODE_MEDIA_PLAY:
                dispatch("play");
                return true;
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
                dispatch("pause");
                return true;
            case KeyEvent.KEYCODE_HEADSETHOOK:
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
                dispatch("playpause");
                return true;
            case KeyEvent.KEYCODE_MEDIA_NEXT:
                dispatch("nexttrack");
                return true;
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
                dispatch("previoustrack");
                return true;
            case KeyEvent.KEYCODE_MEDIA_STOP:
                dispatch("stop");
                return true;
            default:
                return false;
        }
    }

    private void dispatch(final String action) {
        final WebView webView = (getBridge() != null) ? getBridge().getWebView() : null;
        if (webView == null) return;
        final String js =
            "window.dispatchEvent(new CustomEvent('native-media-key', {detail: "
                + jsString(action) + "}));";
        webView.post(() -> webView.evaluateJavascript(js, null));
    }

    private static String jsString(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"' || c == '\\') sb.append('\\').append(c);
            else if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
            else sb.append(c);
        }
        sb.append('"');
        return sb.toString();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (forwardKey(keyCode)) {
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public void onDestroy() {
        if (mediaSession != null) {
            try {
                mediaSession.setActive(false);
                mediaSession.release();
            } catch (Exception ignored) {
            }
            mediaSession = null;
        }
        super.onDestroy();
    }
}
