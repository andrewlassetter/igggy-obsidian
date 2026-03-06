# Igggy Obsidian Plugin — Services Registry

## AI & APIs

| Service | Purpose | Notes |
|---|---|---|
| OpenAI Whisper (`whisper-1`) | Audio transcription | Default path; one OpenAI key covers both transcription + summarization |
| OpenAI GPT-4o Mini | Note summarization | Default summarization provider; JSON mode via `response_format: json_object` |
| Deepgram Nova-3 | Audio transcription (upgrade) | Adds speaker diarization; called via `requestUrl` |
| Anthropic Claude Sonnet (`claude-sonnet-4-6`) | Note summarization (upgrade) | Higher quality output than GPT-4o Mini; called via `requestUrl` |

## Platform

| Service | Purpose | Notes |
|---|---|---|
| Obsidian Plugin API | Host platform, vault I/O, settings storage | `isDesktopOnly: true`; uses `requestUrl` for HTTP calls to bypass CORS in Electron |

---

## Why these over alternatives

**lamejs over ffmpeg.wasm** — lamejs is ~150KB bundled vs. ffmpeg.wasm at ~30MB. Obsidian plugins ship as a single `main.js` file distributed via the community plugin registry, so bundle size has a direct impact on install time and page load. The tradeoff is that lamejs only produces MP3; ffmpeg would offer more format flexibility, but MP3 at 32kbps is sufficient for Whisper and Deepgram.

**OpenAI as the default over Deepgram + Claude** — A single OpenAI key covers both Whisper (transcription) and GPT-4o Mini (summarization), lowering the barrier to entry for new users. Deepgram + Claude is the quality upgrade path for users who want speaker diarization or better note structure, but requiring two additional API keys as the default would add friction.

**`requestUrl` over native `fetch` for AI provider calls** — Obsidian runs inside an Electron shell that blocks cross-origin requests from the renderer process. `requestUrl` (Obsidian's own HTTP wrapper) routes through the main process and bypasses this restriction. The one exception is multipart/form-data requests (Whisper and Deepgram audio uploads), where `requestUrl` lacks FormData support and plain `fetch` is used instead.
