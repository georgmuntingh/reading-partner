# EPUB TTS Reader - Software Design Document

## 1. Overview

A browser-based EPUB reader that reads books aloud using local TTS (Kokoro), with an interactive Q&A mode powered by STT + LLM + TTS. Designed to run on GitHub Pages and work on high-end Android phones.

### Core Features
- Upload and parse EPUB files
- Text-to-speech reading with sentence highlighting
- Chapter navigation and bookmarks
- Q&A mode for asking questions about recent context
- Persistent reading progress

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        UI Layer                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │ Reader View │  │  Q&A Mode   │  │   Navigation Panel      │  │
│  │  + Controls │  │   Dialog    │  │ (Chapters/Bookmarks)    │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│                     Application Layer                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │ ReadingState │  │ AudioEngine  │  │   QAController       │   │
│  │  Controller  │  │  (TTS Queue) │  │  (STT→LLM→TTS)       │   │
│  └──────────────┘  └──────────────┘  └──────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│                      Service Layer                               │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌───────────┐  │
│  │ EPUBParser │  │ KokoroTTS  │  │  WebSpeech │  │  LLMClient│  │
│  │            │  │  (ONNX)    │  │    STT     │  │  (Groq)   │  │
│  └────────────┘  └────────────┘  └────────────┘  └───────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│                    Persistence Layer                             │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                   IndexedDB                               │   │
│  │   - Book metadata & content                               │   │
│  │   - Reading positions                                     │   │
│  │   - Bookmarks                                             │   │
│  │   - User settings                                         │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Technology Stack

| Component | Technology | Rationale |
|-----------|------------|-----------|
| **Frontend** | Vanilla JS + HTML/CSS | No build step, direct GitHub Pages hosting |
| **TTS** | Kokoro via ONNX Runtime Web | High-quality local TTS, runs in browser |
| **STT** | Web Speech API | Free, no API key, works on Android Chrome |
| **LLM** | Groq API (Llama 3 8B) | Free tier available, fast inference |
| **EPUB Parsing** | epub.js | Mature library, handles EPUB structure |
| **Persistence** | IndexedDB (via idb) | Can store large EPUB files, structured data |
| **Sentence Splitting** | Custom + Intl.Segmenter | Accurate sentence boundaries |

---

## 4. File Structure

```
reading-partner/
├── index.html              # Main entry point
├── css/
│   ├── main.css            # Core styles
│   ├── reader.css          # Reader view styles
│   └── components.css      # UI component styles
├── js/
│   ├── app.js              # Application entry, initialization
│   ├── state/
│   │   └── reading-state.js    # Reading state management
│   ├── services/
│   │   ├── epub-parser.js      # EPUB loading and parsing
│   │   ├── tts-engine.js       # Kokoro TTS wrapper
│   │   ├── stt-service.js      # Web Speech API wrapper
│   │   ├── llm-client.js       # Groq API client
│   │   └── storage.js          # IndexedDB operations
│   ├── controllers/
│   │   ├── audio-controller.js # TTS playback & buffering
│   │   └── qa-controller.js    # Q&A mode logic
│   ├── ui/
│   │   ├── reader-view.js      # Text display & highlighting
│   │   ├── controls.js         # Playback controls
│   │   ├── navigation.js       # Chapter/bookmark panel
│   │   └── settings-modal.js   # Settings UI
│   └── utils/
│       ├── sentence-splitter.js # Text segmentation
│       └── helpers.js           # Utility functions
├── lib/
│   ├── onnxruntime-web/        # ONNX Runtime (from CDN or vendored)
│   ├── kokoro/                 # Kokoro model files
│   │   ├── kokoro.onnx         # Main model (~80MB)
│   │   └── voices/             # Voice configuration
│   └── epub.js                 # EPUB parser library
└── assets/
    └── icons/                  # UI icons (SVG)
```

---

## 5. Data Models

### 5.1 Book State
```javascript
// Stored in IndexedDB per book
BookState = {
  id: string,              // Hash of EPUB file
  title: string,
  author: string,
  coverImage: Blob | null,
  chapters: [
    {
      id: string,
      title: string,
      href: string,        // Internal EPUB reference
      sentences: string[]  // Parsed sentence array
    }
  ],
  lastOpened: timestamp
}
```

### 5.2 Reading Position
```javascript
// Stored in IndexedDB, keyed by book ID
ReadingPosition = {
  bookId: string,
  chapterIndex: number,
  sentenceIndex: number,
  updatedAt: timestamp
}
```

### 5.3 Bookmark
```javascript
Bookmark = {
  id: string,
  bookId: string,
  chapterIndex: number,
  sentenceIndex: number,
  note: string | null,
  createdAt: timestamp
}
```

### 5.4 Application State (In-Memory)
```javascript
AppState = {
  currentBook: BookState | null,
  position: {
    chapterIndex: number,
    sentenceIndex: number
  },
  playbackState: 'stopped' | 'playing' | 'paused',
  mode: 'listening' | 'speaking',  // Q&A mode
  settings: {
    playbackSpeed: number,       // 0.5 - 2.0
    voice: string,               // Kokoro voice ID
    contextSentences: number,    // N sentences for LLM context
    llmApiKey: string | null     // Groq API key
  }
}
```

---

## 6. Component Design

### 6.1 EPUB Parser Service (`epub-parser.js`)

**Responsibilities:**
- Load EPUB file from user upload
- Extract metadata (title, author, cover)
- Parse spine/TOC for chapter structure
- Extract and sanitize text content
- Split content into sentences

**Key Methods:**
```javascript
class EPUBParser {
  async loadFromFile(file: File): Promise<BookState>
  async getChapterContent(book: BookState, chapterIndex: number): Promise<string[]>

  // Private
  _extractMetadata(epub): Metadata
  _parseChapters(epub): Chapter[]
  _sanitizeHTML(html: string): string      // Strip tags, normalize whitespace
  _splitIntoSentences(text: string): string[]
}
```

**Sentence Splitting Logic:**
```javascript
// Use Intl.Segmenter where available (Chrome 87+, Android Chrome)
function splitIntoSentences(text) {
  if ('Segmenter' in Intl) {
    const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
    return [...segmenter.segment(text)].map(s => s.segment.trim()).filter(Boolean);
  }
  // Fallback: regex-based splitting
  return text
    .replace(/([.!?])\s+/g, '$1|')
    .split('|')
    .map(s => s.trim())
    .filter(Boolean);
}
```

---

### 6.2 TTS Engine (`tts-engine.js`)

**Responsibilities:**
- Initialize Kokoro ONNX model
- Generate audio from text
- Manage model loading state

**Key Methods:**
```javascript
class TTSEngine {
  async initialize(): Promise<void>        // Load ONNX model
  async synthesize(text: string): Promise<AudioBuffer>
  isReady(): boolean
  getAvailableVoices(): Voice[]
  setVoice(voiceId: string): void

  // Private
  _session: ort.InferenceSession
  _tokenizer: KokoroTokenizer
}
```

**Kokoro Integration Notes:**
- Model file: `kokoro-v0_19.onnx` (~87MB)
- Uses ONNX Runtime Web with WebAssembly backend
- Input: tokenized text → Output: raw audio samples
- Sample rate: 24kHz
- Processing: run in Web Worker to avoid blocking UI

---

### 6.3 Audio Controller (`audio-controller.js`)

**Responsibilities:**
- Manage TTS playback queue
- Pre-buffer upcoming sentences
- Handle playback controls
- Coordinate with UI for highlighting

**Key Methods:**
```javascript
class AudioController {
  constructor(ttsEngine: TTSEngine, onSentenceChange: Callback)

  async play(sentences: string[], startIndex: number): void
  pause(): void
  resume(): void
  stop(): void
  skipForward(): void           // Next sentence
  skipBackward(count: number): void  // Go back N sentences
  setSpeed(rate: number): void

  getCurrentIndex(): number

  // Private
  _audioContext: AudioContext
  _bufferQueue: Map<number, AudioBuffer>  // Pre-buffered audio
  _currentSource: AudioBufferSourceNode
  _prefetchAhead: number = 3              // Buffer 3 sentences ahead
}
```

**Buffering Strategy:**
```
Current: Sentence 5 (playing)
Buffered: Sentences 6, 7, 8 (ready)
Generating: Sentence 9 (in progress)

On sentence end:
1. Start playing buffered sentence 6
2. Shift buffer window
3. Start generating sentence 9 in background
```

**Playback Speed Implementation:**
```javascript
// Use AudioContext playbackRate for speed adjustment
// Range: 0.5x to 2.0x
_playBuffer(buffer, rate) {
  const source = this._audioContext.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = rate;
  source.connect(this._audioContext.destination);
  source.start();
  return source;
}
```

---

### 6.4 STT Service (`stt-service.js`)

**Responsibilities:**
- Interface with Web Speech API
- Handle speech recognition lifecycle
- Return transcribed text

**Key Methods:**
```javascript
class STTService {
  constructor()

  async startListening(): Promise<string>  // Returns when user stops speaking
  stopListening(): void
  isSupported(): boolean

  // Events
  onInterimResult: Callback    // For live transcription display
  onError: Callback
}
```

**Implementation:**
```javascript
class STTService {
  constructor() {
    this._recognition = new (window.SpeechRecognition ||
                             window.webkitSpeechRecognition)();
    this._recognition.continuous = false;
    this._recognition.interimResults = true;
    this._recognition.lang = 'en-US';
  }

  startListening() {
    return new Promise((resolve, reject) => {
      this._recognition.onresult = (event) => {
        const result = event.results[event.results.length - 1];
        if (result.isFinal) {
          resolve(result[0].transcript);
        } else {
          this.onInterimResult?.(result[0].transcript);
        }
      };
      this._recognition.onerror = reject;
      this._recognition.start();
    });
  }
}
```

---

### 6.5 LLM Client (`llm-client.js`)

**Responsibilities:**
- Send context + question to LLM API
- Parse and return response

**Key Methods:**
```javascript
class LLMClient {
  constructor(apiKey: string)

  async askQuestion(context: string[], question: string): Promise<string>
  setApiKey(key: string): void
}
```

**Groq API Integration:**
```javascript
class LLMClient {
  constructor(apiKey) {
    this._apiKey = apiKey;
    this._endpoint = 'https://api.groq.com/openai/v1/chat/completions';
    this._model = 'llama3-8b-8192';  // Free tier model
  }

  async askQuestion(contextSentences, question) {
    const systemPrompt = `You are a helpful reading assistant. The user is reading a book and has a question about it. Answer based on the provided context. Be concise.`;

    const contextText = contextSentences.join(' ');
    const userMessage = `Context from the book:\n"${contextText}"\n\nQuestion: ${question}`;

    const response = await fetch(this._endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this._apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this._model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
        max_tokens: 500,
        temperature: 0.7
      })
    });

    const data = await response.json();
    return data.choices[0].message.content;
  }
}
```

---

### 6.6 Q&A Controller (`qa-controller.js`)

**Responsibilities:**
- Orchestrate Q&A flow: STT → LLM → TTS
- Gather context from current reading position
- Manage Q&A mode state

**Key Methods:**
```javascript
class QAController {
  constructor(sttService, llmClient, ttsEngine, readingState)

  async startQA(): Promise<void>    // Full flow
  cancel(): void

  // Events
  onStateChange: Callback  // 'listening' | 'thinking' | 'responding'
  onTranscript: Callback   // Live STT results
}
```

**Q&A Flow:**
```
1. User presses "Ask" button
2. Pause audio playback
3. Switch to 'speaking' mode
4. STT: Listen for question
5. Gather last N sentences as context
6. LLM: Send context + question
7. TTS: Synthesize and play response
8. Return to 'listening' mode
9. Resume playback (or wait for user)
```

---

### 6.7 Storage Service (`storage.js`)

**Responsibilities:**
- Persist books, positions, bookmarks, settings
- Handle IndexedDB operations

**Database Schema:**
```javascript
// Database: 'reading-partner-db'
// Version: 1

Stores:
  'books': { keyPath: 'id' }
    - Stores BookState objects

  'positions': { keyPath: 'bookId' }
    - Stores ReadingPosition objects

  'bookmarks': { keyPath: 'id', index: 'bookId' }
    - Stores Bookmark objects

  'settings': { keyPath: 'key' }
    - Key-value store for app settings
```

**Key Methods:**
```javascript
class StorageService {
  async init(): Promise<void>

  // Books
  async saveBook(book: BookState): Promise<void>
  async getBook(id: string): Promise<BookState | null>
  async getAllBooks(): Promise<BookState[]>
  async deleteBook(id: string): Promise<void>

  // Positions
  async savePosition(position: ReadingPosition): Promise<void>
  async getPosition(bookId: string): Promise<ReadingPosition | null>

  // Bookmarks
  async addBookmark(bookmark: Bookmark): Promise<void>
  async getBookmarks(bookId: string): Promise<Bookmark[]>
  async deleteBookmark(id: string): Promise<void>

  // Settings
  async saveSetting(key: string, value: any): Promise<void>
  async getSetting(key: string): Promise<any>
}
```

---

### 6.8 Reading State Controller (`reading-state.js`)

**Responsibilities:**
- Central state management
- Coordinate between components
- Auto-save position periodically

**Key Methods:**
```javascript
class ReadingStateController {
  constructor(storage: StorageService)

  async loadBook(file: File): Promise<void>
  async openBook(bookId: string): Promise<void>

  getCurrentSentences(): string[]  // Current chapter's sentences
  getCurrentPosition(): { chapter: number, sentence: number }

  goToChapter(index: number): void
  goToSentence(index: number): void
  goToBookmark(bookmark: Bookmark): void

  addBookmark(note?: string): Promise<Bookmark>

  getContextSentences(count: number): string[]  // Last N sentences for Q&A

  // Auto-save (debounced, every 5 seconds during playback)
  _schedulePositionSave(): void
}
```

---

## 7. UI Components

### 7.1 Main Layout

```
┌────────────────────────────────────────────────────────────┐
│  [☰ Menu]     Book Title                    [⚙ Settings]  │  <- Header
├────────────────────────────────────────────────────────────┤
│                                                            │
│   Chapter 3: The Journey Begins                            │
│                                                            │
│   The sun rose slowly over the mountains, casting          │
│   long shadows across the valley below.                    │
│                                                            │
│   ▶ [HIGHLIGHTED: Maria stepped outside, breathing         │  <- Current
│     in the crisp morning air.]                             │     sentence
│                                                            │
│   She had waited years for this moment.                    │
│   Today, everything would change.                          │
│                                                            │
├────────────────────────────────────────────────────────────┤
│                                                            │
│    [⏮ -2]  [⏪]   [▶ Play]   [⏩]   [🎤 Ask]              │  <- Controls
│                                                            │
│             ───────●────────────────  1.0x                 │  <- Speed
│                                                            │
└────────────────────────────────────────────────────────────┘
```

### 7.2 Navigation Panel (Slide-out)

```
┌──────────────────────────────┐
│  ← Back          Navigation  │
├──────────────────────────────┤
│  CHAPTERS                    │
│  ─────────────────────────   │
│  1. Prologue                 │
│  2. The Beginning            │
│  3. The Journey Begins  ●    │  <- Current
│  4. Dark Woods               │
│  5. The Revelation           │
│                              │
│  BOOKMARKS                   │
│  ─────────────────────────   │
│  📑 Ch.2, "Important clue"   │
│  📑 Ch.3, (no note)          │
│                              │
│  [+ Add Bookmark]            │
└──────────────────────────────┘
```

### 7.3 Q&A Mode Overlay

```
┌────────────────────────────────────────────────────────────┐
│                                                            │
│                      🎤 Listening...                       │
│                                                            │
│              "What did Maria find in the..."               │  <- Live STT
│                                                            │
│                     [Cancel]                               │
│                                                            │
└────────────────────────────────────────────────────────────┘

       ↓ (after question captured)

┌────────────────────────────────────────────────────────────┐
│                                                            │
│                      🤔 Thinking...                        │
│                                                            │
│    Your question:                                          │
│    "What did Maria find in the cave?"                      │
│                                                            │
└────────────────────────────────────────────────────────────┘

       ↓ (LLM response received, TTS playing)

┌────────────────────────────────────────────────────────────┐
│                                                            │
│                      🔊 Responding                         │
│                                                            │
│    "Based on the text, Maria found an ancient              │
│     map hidden inside a leather pouch..."                  │
│                                                            │
│           [Stop]        [Ask Another]                      │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

### 7.4 Settings Modal

```
┌────────────────────────────────────────────────────────────┐
│  Settings                                          [×]     │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  VOICE                                                     │
│  ┌──────────────────────────────────────────────────────┐ │
│  │  af_bella (American Female)                     ▼    │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                            │
│  PLAYBACK SPEED                                            │
│  ───────────●──────────────────  1.0x                      │
│  0.5x                                               2.0x   │
│                                                            │
│  Q&A CONTEXT (sentences)                                   │
│  ┌────┐                                                    │
│  │ 20 │  sentences sent to LLM                             │
│  └────┘                                                    │
│                                                            │
│  LLM API KEY (Groq)                                        │
│  ┌──────────────────────────────────────────────────────┐ │
│  │  gsk_xxxxxxxxxxxxxxxxxxxxxxxx                        │ │
│  └──────────────────────────────────────────────────────┘ │
│  Get free key: groq.com                                    │
│                                                            │
│                              [Save]                        │
└────────────────────────────────────────────────────────────┘
```

---

## 8. Key Algorithms

### 8.1 Audio Pre-buffering

```javascript
class AudioController {
  _prefetchAhead = 3;
  _bufferQueue = new Map();  // sentenceIndex -> AudioBuffer

  async _maintainBuffer(currentIndex, sentences) {
    // Determine what needs to be buffered
    const needed = [];
    for (let i = currentIndex; i < currentIndex + this._prefetchAhead && i < sentences.length; i++) {
      if (!this._bufferQueue.has(i)) {
        needed.push(i);
      }
    }

    // Clean up old buffers (before current - 2 for rewind support)
    for (const idx of this._bufferQueue.keys()) {
      if (idx < currentIndex - 2) {
        this._bufferQueue.delete(idx);
      }
    }

    // Generate needed buffers (in parallel, limited concurrency)
    const generatePromises = needed.map(async (idx) => {
      const audio = await this._ttsEngine.synthesize(sentences[idx]);
      this._bufferQueue.set(idx, audio);
    });

    await Promise.all(generatePromises);
  }
}
```

### 8.2 Position Auto-save (Debounced)

```javascript
class ReadingStateController {
  _saveTimeout = null;

  _schedulePositionSave() {
    if (this._saveTimeout) {
      clearTimeout(this._saveTimeout);
    }

    this._saveTimeout = setTimeout(async () => {
      await this._storage.savePosition({
        bookId: this._currentBook.id,
        chapterIndex: this._position.chapterIndex,
        sentenceIndex: this._position.sentenceIndex,
        updatedAt: Date.now()
      });
    }, 5000);  // Save 5 seconds after last position change
  }

  // Called on every sentence change
  _onSentenceChange(newIndex) {
    this._position.sentenceIndex = newIndex;
    this._schedulePositionSave();
    this._notifyUI();
  }
}
```

### 8.3 Context Gathering for Q&A

```javascript
class ReadingStateController {
  getContextSentences(count = 20) {
    const context = [];
    let remaining = count;

    // Start from current position, go backwards
    let chapterIdx = this._position.chapterIndex;
    let sentenceIdx = this._position.sentenceIndex;

    while (remaining > 0 && chapterIdx >= 0) {
      const chapter = this._currentBook.chapters[chapterIdx];
      const startIdx = Math.max(0, sentenceIdx - remaining + 1);
      const sentences = chapter.sentences.slice(startIdx, sentenceIdx + 1);

      context.unshift(...sentences);
      remaining -= sentences.length;

      // Move to previous chapter
      chapterIdx--;
      if (chapterIdx >= 0) {
        sentenceIdx = this._currentBook.chapters[chapterIdx].sentences.length - 1;
      }
    }

    return context.slice(-count);  // Ensure we don't exceed count
  }
}
```

---

## 9. Error Handling

### 9.1 TTS Model Loading Failure
- Show loading progress indicator during model download
- If model fails to load, display clear error with retry option
- Cache model in IndexedDB after first successful load

### 9.2 STT Errors
- Handle "not-allowed" (microphone permission denied)
- Handle "network" errors gracefully
- Provide fallback: text input for Q&A if STT unavailable

### 9.3 LLM API Errors
- Validate API key format before saving
- Handle rate limits (429) with user-friendly message
- Handle network errors with retry option

### 9.4 EPUB Parsing Errors
- Validate file is actually EPUB format
- Handle malformed/corrupted EPUBs
- Show specific error for DRM-protected files

---

## 10. Performance Considerations

### 10.1 TTS in Web Worker
```javascript
// tts-worker.js
importScripts('./lib/onnxruntime-web/ort.min.js');

let session = null;

self.onmessage = async (e) => {
  if (e.data.type === 'init') {
    session = await ort.InferenceSession.create(e.data.modelPath, {
      executionProviders: ['wasm']
    });
    self.postMessage({ type: 'ready' });
  }

  if (e.data.type === 'synthesize') {
    const audioData = await runInference(session, e.data.text);
    self.postMessage({ type: 'audio', id: e.data.id, data: audioData });
  }
};
```

### 10.2 Memory Management
- Limit buffered audio to current ±2 sentences + 3 ahead
- Clear chapter sentence arrays when switching chapters (keep only current)
- Use transferable objects when passing audio data from worker

### 10.3 Mobile-Specific
- Use `requestIdleCallback` for non-critical operations
- Respect `prefers-reduced-motion` for UI animations
- Handle audio focus/interruptions (phone calls, etc.)

---

## 11. Implementation Phases

### Phase 1: Core Reading (MVP)
1. EPUB upload and parsing
2. Basic text display with sentence segmentation
3. Kokoro TTS integration (single sentence playback)
4. Play/pause controls
5. Basic sentence highlighting

### Phase 2: Enhanced Playback
1. Audio pre-buffering
2. Speed control
3. Skip forward/backward
4. Chapter navigation
5. IndexedDB persistence (position, books)

### Phase 3: Q&A Mode
1. STT integration (Web Speech API)
2. LLM integration (Groq)
3. Q&A TTS response
4. Context gathering logic
5. Q&A UI overlay

### Phase 4: Polish
1. Bookmarks
2. Settings persistence
3. Model caching
4. Error handling improvements
5. Mobile UI optimizations
6. Loading states and progress indicators

---

## 12. External Dependencies

| Dependency | Version | Size | Purpose |
|------------|---------|------|---------|
| epub.js | 0.3.x | ~100KB | EPUB parsing |
| ONNX Runtime Web | 1.17.x | ~2MB | ML inference |
| Kokoro Model | v0.19 | ~87MB | TTS model |
| idb | 8.x | ~5KB | IndexedDB wrapper |

**CDN Loading Strategy:**
```html
<!-- Core dependencies -->
<script src="https://cdn.jsdelivr.net/npm/epubjs/dist/epub.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/ort.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/idb/build/umd.js"></script>

<!-- Kokoro model loaded asynchronously after page load -->
```

---

## 13. Security Considerations

1. **API Key Storage**: Store Groq API key in IndexedDB (not localStorage) - while not perfectly secure, acceptable for client-side app with user's own key

2. **EPUB Content**: Sanitize HTML content before display to prevent XSS from malicious EPUB files

3. **CORS**: All API calls go to Groq's CORS-enabled endpoint; no proxy needed

4. **Content Security Policy**: Configure GitHub Pages CSP to allow:
   - `script-src` for CDN dependencies
   - `connect-src` for Groq API
   - `worker-src` for TTS Web Worker

---

## 14. Testing Strategy

### Unit Tests (if time permits)
- Sentence splitting edge cases
- Position persistence logic
- Context gathering algorithm

### Manual Testing Checklist
- [ ] EPUB upload (various formats)
- [ ] TTS playback quality
- [ ] Playback controls responsiveness
- [ ] Position persistence across reload
- [ ] Chapter navigation
- [ ] Q&A flow end-to-end
- [ ] Mobile touch interactions
- [ ] Landscape/portrait orientation
- [ ] Background/foreground app switching

---

## 15. Future Enhancements (Out of Scope)

- Multiple language support
- Offline Q&A with local LLM (too slow currently)
- Image descriptions via vision model
- Sync across devices
- Social features (shared bookmarks/notes)
- Alternative TTS engines
- SSML support for better prosody
