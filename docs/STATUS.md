# Igggy Obsidian Plugin — Project Status

_Last updated: 2026-03-05_

---

## ✅ Completed

### Core Pipeline (end-to-end working)
- **Plugin entry point** — `src/main.ts`: loads settings, registers ribbon icon (`audio-waveform`), registers commands, registers settings tab
- **Audio pre-processor** — `src/audio/preprocessor.ts`: Web Audio API + lamejs; skips files under 10MB, decodes to PCM, mixes to mono, downsamples to 16kHz, encodes to 32kbps MP3; ~57MB → ~14MB for 1-hour meetings
- **OpenAI Whisper transcription** — `src/audio/providers/openai.ts`: `whisper-1`, `verbose_json` response format, returns transcript + durationSec
- **Deepgram Nova-3 transcription** — `src/audio/providers/deepgram.ts`: `nova-3` with `smart_format`, `diarize`, `paragraphs`; multi-speaker detection with `[Speaker N]:` prefixing
- **Shared prompt builder** — `src/ai/prompt.ts`: `buildPrompt()` with context hint (duration, weekday/weekend, time of day); targets `MEETING | ONE_ON_ONE | MEMO` classification
- **Claude summarization** — `src/ai/providers/claude.ts`: `claude-sonnet-4-6`, 3000 max tokens, uses `requestUrl` (CORS fix), strips code fences, maps `keyHighlights` → `keyTopics`
- **GPT-4o Mini summarization** — `src/ai/providers/openai.ts`: `gpt-4o-mini`, JSON mode (`response_format: json_object`), same prompt via system message, uses `requestUrl`
- **Note writer** — `src/notes/writer.ts`: sanitizes title for filename, creates output folder if missing, file collision handling (modify existing vs. create new)
- **Markdown template** — `src/notes/template.ts`: YAML frontmatter (title, date, type, duration, source, tags), audio embed (`![[path]]`), Summary, prose content paragraphs, Key Highlights, Decisions, Action Items (as `- [ ]` checkboxes with owner + context), collapsible Transcript `<details>`
- **`content` section rendering** — `src/notes/template.ts` renders `content: string[]` prose paragraphs between Summary and Key Highlights
- **Settings** — `src/settings.ts` + `src/settings-tab.ts`: provider dropdowns (OpenAI/Deepgram, OpenAI/Anthropic), API key fields, output folder, embed audio toggle; saved via `loadData()/saveData()`
- **License key placeholder removed** — `licenseKey` field removed from settings and UI (deferred to Pro monetization phase)

### Entry Points & UX
- **Ribbon icon** — `audio-waveform` icon → opens `AudioFileSuggestModal`
- **Command: "Process audio file…"** — opens `AudioFileSuggestModal` (fuzzy search across vault audio files)
- **Command: "Process active audio file"** — `checkCallback` only available when active file is an audio format
- **File explorer context menu** — "Process with Igggy" (mic icon) on audio files only
- **Editor context menu** — "Process with Igggy" when active file is an audio format
- **Progress notices** — `Notice` at each pipeline step: reading, pre-processing (with before/after size), transcribing, generating, writing
- **Error handling** — step-contexted error messages; `friendlyError()` maps 401, 429, 413, network, decode errors to plain-English notices (10s timeout)
- **API key validation** — guards at pipeline start; surfaces which key is missing before any processing begins

### Build & Tooling
- **TypeScript build** — `esbuild.config.mjs` (standard Obsidian scaffold), `tsconfig.json`
- **lamejs type stub** — `src/types/lamejs.d.ts`
- **`manifest.json`** — plugin ID `igggy`, name `Igggy`, v0.1.0, `isDesktopOnly: true`

### Supported audio formats
`m4a`, `mp3`, `wav`, `webm`, `ogg`, `flac`, `aac`, `mp4`

---

## 🔄 In Progress

Active uncommitted changes across `src/ai/`, `src/audio/providers/`, `src/notes/template.ts`, `src/settings.ts`, `src/settings-tab.ts` — exact scope TBD.

---

## 📋 Planned — Near Term

### Known Code Issues
- **`keyHighlights` vs `keyTopics` naming** — the prompt uses `keyHighlights`, both providers remap to `keyTopics` internally; consider aligning the prompt field name to `keyTopics` to eliminate the remap step
- **`JOURNAL` note type gap** — `NoteContent` type includes `JOURNAL` in the union but the prompt only instructs the AI to return `MEETING | ONE_ON_ONE | MEMO`; template has no special handling for it
- **Whisper provider uses `fetch` not `requestUrl`** — `src/audio/providers/openai.ts` uses plain `fetch` (multipart/form-data); `requestUrl` doesn't support FormData. Document this intentional exception or find a workaround for consistency
- **Deepgram provider uses `fetch` not `requestUrl`** — same situation; `requestUrl` with a raw `ArrayBuffer` body may work but hasn't been tested

### Testing & Validation
- End-to-end test in a live Obsidian vault (all 8 verification scenarios from Plugin Plan doc)
- Test OpenAI-only path (one key, both Whisper + GPT-4o Mini)
- Test Deepgram + Claude path; verify speaker diarization appears in transcript + propagates to note
- Test >10MB file → confirm preprocessor runs and compression notice fires
- Test "Process active file" command with an audio file focused in the editor
- Verify generated note structure: frontmatter fields, section headers, checkbox format, transcript collapsible

### Marketplace Prep
- Add `README.md` at repo root (required for Obsidian community plugins submission)
- Verify `manifest.json` fields against [Obsidian plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
- Create a GitHub release with `manifest.json`, `main.js`, `styles.css` (even if empty) as release assets
- Submit PR to [obsidianmd/obsidian-releases](https://github.com/obsidianmd/obsidian-releases) adding plugin to `community-plugins.json`

---

## 💭 Backlog / Future

### Monetization Infrastructure (Phase 2/3 — Strategic Overview)
- Lemon Squeezy: create "Igggy Pro BYOK" product ($4/mo or $39/yr) + license key management
- License key validation in plugin against Lemon Squeezy API or a lightweight backend
- Free tier enforcement: 5 recordings/month cap for users without a license key
- Hosted tier ($7/mo or $59/yr): plugin authenticates via Supabase JWT instead of BYOK

### Marketing Site (Phase 2)
- Framer marketing site: hero → how it works → features → pricing → FAQ → footer
- Loops waitlist: 3-email nurture sequence (immediately / day 3 / day 7)
- Featurebase feedback board: Feature Requests + Bug Reports boards, public roadmap

### Cross-Device Sync (Sync Architecture doc)
- `iggy_id` UUID injected into frontmatter at note creation (decouples identity from file path)
- `synced_at` frontmatter field
- Local `index.db` (SQLite) tracking UUID → vault path mapping
- Vault file watcher: `vault.on('rename', ...)` to remap paths on move
- UUID scan on vault open: recover from Finder-moves-while-Obsidian-closed case
- Sync API: `GET /api/notes?since=<timestamp>` for plugin to pull new/changed notes
- Conflict resolution: last-write-wins per field with server Lamport timestamp
- Tombstone + 60s grace period before propagating deletions

### iOS (Phase 4)
- iOS Share Extension: Voice Memos → share sheet → Igggy pipeline → note in vault
- Capacitor wrapper for the web app

### Desktop Wrapper (Phase 5)
- Tauri wrapper (Mac + Windows)
- OS keychain for API key storage (replaces Obsidian config)
- Background processing, system tray

### Additional Integrations (Phase 6)
- Notion, Logseq, Roam, Bear — same pipeline, different `NoteWriter` adapters

### Additional Capture Types (Phase 7)
- Images/screenshots: OCR + AI description → NoteContent
- PDFs and web clips
- **Email capture** (Email Capture Layer doc): forward-to-inbox via Postmark Inbound → `/api/email-inbound` → `EMAIL` note type → plugin sync; estimated ~2–3 days after hosted plan ships

### Plugin Feature Backlog (from competitive gap analysis)
- **Unified task list** — aggregate `- [ ]` action items across all Igggy notes into a single view (Pro feature)
- **Smart audio deletion** — optional: delete source audio after successful transcription (user opt-in setting)
- In-progress recording capture (native record button in plugin, not just file-picker)
