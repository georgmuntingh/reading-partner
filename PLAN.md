# Implementation Plan: Local AI Inference (Whisper STT + Local LLM)

## Design Decisions Summary

| Decision | Choice |
|---|---|
| UX model | Independent backends (separate STT/LLM selectors) |
| Web Workers | Yes, both in separate dedicated workers |
| Model download | Explicit settings button + auto-download on first use |
| LLM scope | All features (Q&A, lookup, quiz, text generation) |
| LLM architecture | Strategy pattern (LLMProvider interface) |
| STT architecture | New WhisperSTTService class (same public API) |
| Device selection | Auto-detect WebGPU with settings override |
| Worker design | Separate workers (whisper-worker.js, llm-worker.js) |
| LLM streaming | Worker postMessage token streaming |
| Missing model UX | Prompt to download with progress |
| Whisper interim results | Final only (record → transcribe) |

---

## Step 1: Add transformers.js dependency

- Add `@huggingface/transformers` to `package.json` (or use CDN import like kokoro-js)
- Decision: Use CDN ESM import (`https://cdn.jsdelivr.net/npm/@huggingface/transformers@3`) to match the existing kokoro-js pattern (no bundler config changes needed)

## Step 2: Create the Whisper Web Worker (`js/workers/whisper-worker.js`)

**Messages IN (from main thread):**
- `{ type: 'load', model: 'onnx-community/whisper-tiny.en', device: 'webgpu'|'wasm', dtype: {...} }`
- `{ type: 'transcribe', audio: Float32Array (PCM 16kHz mono) }`
- `{ type: 'unload' }`

**Messages OUT (to main thread):**
- `{ type: 'loading', progress: { status, file, loaded, total } }` — model download progress
- `{ type: 'ready' }` — model loaded, ready for inference
- `{ type: 'result', text: string }` — transcription result
- `{ type: 'error', error: string }`

**Implementation details:**
- Import `pipeline` from transformers.js CDN
- Create `automatic-speech-recognition` pipeline with per-module dtype: `{ encoder_model: 'fp32', decoder_model_merged: 'q4' }`
- Use `chunk_length_s: 30`, `stride_length_s: 5` for longer audio
- Track inference count for memory leak workaround (reinitialize pipeline every ~20 calls)

## Step 3: Create the WhisperSTTService (`js/services/whisper-stt-service.js`)

**Same public API as STTService:**
- `startListening()` → Promise<string>
- `stopListening()`
- `requestPermission()` → Promise<boolean>
- `isSupported()` → boolean
- `setSilenceTimeout(ms)`
- Callbacks: `onInterimResult`, `onStart`, `onEnd`, `onError`

**Internal implementation:**
- Uses `MediaRecorder` API to capture audio from microphone
- Silence detection via `AudioContext` + `AnalyserNode` (monitor volume, stop after threshold)
- On stop: extract PCM Float32Array from recorded audio, send to whisper-worker
- Wait for `result` message, resolve promise with transcription text
- No interim results (per design decision) — show a "listening..." indicator instead
- Model loading: lazy on first `startListening()` call, show download progress if needed

**Audio processing pipeline:**
```
getUserMedia → MediaStream → AudioContext
                                ├→ AnalyserNode (silence detection)
                                └→ AudioWorklet/ScriptProcessor → PCM buffer
On silence: PCM buffer → resample to 16kHz → Float32Array → worker
```

## Step 4: Create the LLM Web Worker (`js/workers/llm-worker.js`)

**Messages IN:**
- `{ type: 'load', model: 'HuggingFaceTB/SmolLM2-360M-Instruct', device: 'webgpu'|'wasm', dtype: 'q4f16' }`
- `{ type: 'generate', messages: [{role, content}], options: { max_new_tokens, temperature, do_sample } }`
- `{ type: 'abort' }` — cancel current generation
- `{ type: 'unload' }`

**Messages OUT:**
- `{ type: 'loading', progress: { status, file, loaded, total } }`
- `{ type: 'ready' }`
- `{ type: 'token', token: string }` — each generated token (for streaming)
- `{ type: 'complete', text: string }` — full generated text
- `{ type: 'error', error: string }`

**Implementation details:**
- Import transformers.js, create `text-generation` pipeline
- Use the model's chat template via `tokenizer.apply_chat_template()`
- Stream tokens via the `streamer` callback in `pipeline()` options
- Post each token via `postMessage({ type: 'token', token })`
- Support abort via `AbortController` or flag check between token generations

## Step 5: Refactor LLMClient to Strategy Pattern

**New file structure:**
- `js/services/llm-provider.js` — Provider interface / base class
- `js/services/openrouter-provider.js` — Extracted from current LLMClient (OpenRouter HTTP calls)
- `js/services/local-llm-provider.js` — Local transformers.js via llm-worker
- `js/services/llm-client.js` — Facade that delegates to active provider

**LLMProvider interface (both providers implement):**
```js
class LLMProvider {
  async askQuestion(context, question, bookInfo) → string
  async askQuestionStreaming(context, question, bookInfo, { onChunk, onSentence }) → ReadableStream
  async lookupWord(phrase, sentence, bookTitle, targetLanguage) → object
  async generateQuizQuestion(context, bookInfo, options) → object
  async streamQuizChat(messages, { onChunk, onSentence }) → void
  async generateText(description, format) → string
  async isAvailable() → boolean  // check if model loaded / API key present
  async getModelInfo() → { name, size, loaded }
}
```

**LLMClient refactoring:**
- Extract all OpenRouter-specific code (HTTP calls, SSE parsing, API key handling) into `OpenRouterProvider`
- Keep LLMClient as the public API — delegates to `this._provider`
- `setBackend(type)` switches provider: `'openrouter'` or `'local'`
- All existing call sites (qa-controller, quiz-controller, lookup-service, app.js) remain unchanged

**LocalLLMProvider specifics:**
- Manages the llm-worker lifecycle (load/unload)
- Converts `postMessage` token stream into the same callback pattern as OpenRouter SSE
- Builds chat messages array (system + user) matching the model's expected format
- Prompt engineering adapted for SmolLM2's capabilities (simpler prompts, more explicit JSON instructions)

## Step 6: Model Management Utility (`js/services/model-manager.js`)

**Responsibilities:**
- Track which models are downloaded (check IndexedDB/Cache API)
- Provide download progress callbacks
- Report model sizes and storage usage
- Support pre-download and on-demand download

**API:**
```js
class ModelManager {
  async isModelCached(modelId) → boolean
  async getModelSize(modelId) → { download, memory }
  async getStorageUsage() → { used, available }
  onProgress(callback)  // download progress
}
```

**Note:** transformers.js handles its own caching internally (Cache API / IndexedDB). ModelManager wraps this to provide UI-friendly progress info and checks.

## Step 7: Update Settings UI (`js/ui/settings-modal.js`)

**New settings sections:**

**STT Settings (new section between Voice & Speed and Q&A):**
```
Speech Recognition
├─ Backend: [Web Speech API ▼] / [Whisper (Local) ▼]
├─ Whisper Model: [whisper-tiny.en ▼] (future: whisper-base, whisper-small)
├─ Device: [Auto ▼] / WebGPU / WASM
├─ Model status: "Downloaded (65 MB)" or [Download Model] button with progress
└─ (Whisper settings only shown when Whisper backend selected)
```

**Q&A Settings (modify existing):**
```
Q&A Settings
├─ LLM Backend: [OpenRouter (Cloud) ▼] / [Local (On-Device) ▼]
├─ (If OpenRouter): API Key, Model dropdown (existing UI)
├─ (If Local): Model: [SmolLM2-360M-Instruct ▼] (future: more models)
│             Device: [Auto ▼] / WebGPU / WASM
│             Model status: "Downloaded (250 MB)" or [Download Model] button
└─ Context settings (existing, shared by both backends)
```

**New IndexedDB settings keys:**
- `sttBackend`: `'web-speech'` | `'whisper'` (default: `'web-speech'`)
- `whisperModel`: model ID string (default: `'onnx-community/whisper-tiny.en'`)
- `whisperDevice`: `'auto'` | `'webgpu'` | `'wasm'` (default: `'auto'`)
- `llmBackend`: `'openrouter'` | `'local'` (default: `'openrouter'`)
- `localLlmModel`: model ID string (default: `'HuggingFaceTB/SmolLM2-360M-Instruct'`)
- `localLlmDevice`: `'auto'` | `'webgpu'` | `'wasm'` (default: `'auto'`)

## Step 8: Integrate into app.js and controllers

**app.js changes:**
- Import `WhisperSTTService`
- On init: read `sttBackend` and `llmBackend` settings
- Instantiate appropriate STT service based on setting
- Call `llmClient.setBackend(setting)` to activate correct provider
- Handle model download prompts (when local backend selected but model not downloaded)

**qa-controller.js changes:**
- Accept STT service as parameter (instead of importing singleton)
- No other changes needed — it calls `sttService.startListening()` and `llmClient.askQuestionStreaming()` which both maintain the same API

**quiz-controller.js / lookup-service.js changes:**
- Minimal — they call `llmClient.generateQuizQuestion()` / `llmClient.lookupWord()` which delegate to the active provider

## Step 9: Download Progress UI Component

**New UI component: `js/ui/model-download-modal.js`**
- Reusable modal/overlay showing model download progress
- Shows: model name, file being downloaded, progress bar, total size, cancel button
- Used by both Settings (explicit download) and on-demand download prompts
- Triggered via callback from ModelManager / worker progress messages

---

## File Changes Summary

| File | Action | Description |
|---|---|---|
| `js/workers/whisper-worker.js` | **NEW** | Whisper inference in Web Worker |
| `js/workers/llm-worker.js` | **NEW** | LLM inference in Web Worker |
| `js/services/whisper-stt-service.js` | **NEW** | Whisper STT with same API as STTService |
| `js/services/llm-provider.js` | **NEW** | Base LLMProvider class |
| `js/services/openrouter-provider.js` | **NEW** | Extracted OpenRouter logic |
| `js/services/local-llm-provider.js` | **NEW** | Local LLM via worker |
| `js/services/model-manager.js` | **NEW** | Model download/cache management |
| `js/ui/model-download-modal.js` | **NEW** | Download progress UI |
| `js/services/llm-client.js` | **MODIFY** | Refactor to facade + strategy pattern |
| `js/services/stt-service.js` | **MINOR** | No changes (kept as-is for Web Speech) |
| `js/ui/settings-modal.js` | **MODIFY** | Add STT/LLM backend selectors + download buttons |
| `js/app.js` | **MODIFY** | Initialize correct backends, handle settings changes |
| `js/controllers/qa-controller.js` | **MINOR** | Accept STT service param |
| `index.html` | **MINOR** | (if needed for worker script tags) |
| `css/components.css` | **MINOR** | Styles for download progress UI |

**8 new files, 5-6 modified files.**

---

## Implementation Order

1. **Workers first** (whisper-worker.js, llm-worker.js) — can be tested standalone
2. **WhisperSTTService** — wraps whisper-worker, testable independently
3. **LLMClient refactor** — extract OpenRouterProvider, create LocalLLMProvider
4. **Model management** — download tracking and progress
5. **Settings UI** — backend selectors, download buttons
6. **App integration** — wire everything together
7. **Download progress modal** — polish the download UX
