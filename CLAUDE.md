# Igggy Obsidian Plugin — Developer Guide

**Repo:** https://github.com/andrewlassetter/igggy-obsidian

## Commands

```bash
npm run dev       # esbuild in watch mode — auto-rebuilds to main.js on save
npm run build     # tsc type-check + esbuild production bundle (no sourcemaps)
npm run lint      # eslint on src/ (TypeScript)
```

## Dev Environment

- **No `.env` file** — BYOK plugin; API keys are entered at runtime in Obsidian settings, not build-time config
- **Output file** — esbuild writes to `main.js` at the repo root (not `dist/`); this is what Obsidian loads
- **Install in Obsidian for testing** — symlink or copy the repo into `<vault>/.obsidian/plugins/igggy/`; enable the plugin in Obsidian → Settings → Community plugins
- **Rebuild required** — Obsidian does not hot-reload plugins; after `npm run dev` rebuilds, use the "Reload app without saving" command in Obsidian (or disable/re-enable the plugin)
- **Desktop only** — `isDesktopOnly: true` in `manifest.json`; mobile Obsidian will not load this plugin

## Architecture

Audio files in the user's Obsidian vault are selected via a fuzzy modal or context menu. The audio is pre-processed by `src/audio/preprocessor.ts` (Web Audio API + lamejs: mono 16kHz 32kbps MP3) to reduce size before upload. The compressed audio is sent to a transcription provider (OpenAI Whisper or Deepgram Nova-3) via HTTP.

### AI Summarization (Two-Pass Pipeline)

The transcript goes through a two-pass adaptive pipeline (ported from web app `packages/core/src/prompt.ts`):

1. **Pass 1 — Analysis** (Haiku / GPT-4o Mini): Classifies recording type (`MEETING`, `MEMO`, `LECTURE`), counts speakers, detects 6 content signals (`hasDecisions`, `hasFollowUps`, `hasKeyTerms`, `hasSpeakerDiscussion`, `hasReflectiveProse`, `hasIdeaDevelopment`), detects voice instructions to Igggy, assesses tone, identifies primary focus. Output: `TranscriptAnalysis` JSON.
2. **Pass 2 — Adaptive Summarization** (Sonnet / GPT-4o Mini): `buildSummarizationPrompt()` composes sections dynamically based on analysis signals — only includes Decisions, Tasks, Key Terms, Speaker Attribution, etc. when signals warrant. Output: `NoteContent` JSON.

The pipeline is orchestrated by `runProcessingPipeline()` in `commands.ts`: preprocess → transcribe → **analyze (Pass 1)** → **summarize (Pass 2)** → finalize.

`src/notes/writer.ts` feeds the result into `src/notes/template.ts` to generate markdown with YAML frontmatter, then writes the file to the vault using the Obsidian API. All HTTP calls use `Obsidian.requestUrl` to avoid CORS in Electron, except multipart audio uploads which use native `fetch`.

## Key Files

| File | Purpose |
|---|---|
| `src/main.ts` | Plugin entry: registers ribbon icon, commands, settings tab |
| `src/settings.ts` | `IgggySettings` interface + `DEFAULT_SETTINGS` |
| `src/settings-tab.ts` | Settings UI — provider dropdowns, API key inputs, output folder |
| `src/commands.ts` | `registerCommands`, `registerMenus`, `openAudioFilePicker` |
| `src/audio/preprocessor.ts` | Web Audio API + lamejs: compress audio to 32kbps MP3 before upload |
| `src/audio/providers/openai.ts` | OpenAI Whisper transcription (`whisper-1`, `verbose_json`) |
| `src/audio/providers/deepgram.ts` | Deepgram Nova-3 transcription with speaker diarization |
| `src/ai/prompt.ts` | `buildAnalysisPrompt()` (Pass 1), `buildSummarizationPrompt()` (Pass 2 adaptive), `buildPrompt()` (router) |
| `src/ai/providers/types.ts` | `NoteType` (3 values), `TranscriptAnalysis`, `NoteContent`, `SummarizationProvider`, `normalizeNoteType()` |
| `src/ai/providers/claude.ts` | Claude provider: `analyze()` (Haiku) + `summarize()` (Sonnet) |
| `src/ai/providers/openai.ts` | OpenAI provider: `analyze()` + `summarize()` (GPT-4o Mini for both) |
| `src/notes/template.ts` | `generateMarkdown()` — builds the full markdown note from `NoteContent` |
| `src/notes/writer.ts` | Vault file write + collision handling |
| `src/types/lamejs.d.ts` | TypeScript type stub for lamejs |
| `manifest.json` | Plugin ID, name, version, min Obsidian version |
| `esbuild.config.mjs` | Build config: entry `src/main.ts` → `main.js`, watch or production mode |

## Conventions

### Naming
- Brand is **Igggy** (triple-g) — never "Iggy" in user-facing text, identifiers, filenames, or docs
- TypeScript class/interface names: `IgggyPlugin`, `IgggySettings`, `IgggySettingsTab`
- CSS classes: `igggy-*` prefix
- Frontmatter field: `igggy_id` (triple-g, snake_case); generated via `crypto.randomUUID()`

### Terminology
- **Tasks** — always. Never "action items" in markdown section headers, UI text, or docs
- **Key Highlights** — the rendered `## Key Highlights` section header (field name in code: `keyTopics`)
- Note types in UI: Meeting, Memo, Lecture (title case) — only 3 types
- Note types in code/frontmatter: `MEETING`, `MEMO`, `LECTURE` (screaming snake case)
- Legacy types `ONE_ON_ONE` and `JOURNAL` are mapped via `normalizeNoteType()` in `types.ts` — never create new records with these values

### AI field names vs. display names (do not conflate)
The prompt (`src/ai/prompt.ts`) asks the AI to return `keyTopics` and `actionItems` — these are the AI-facing JSON keys. They map to display names in `src/notes/template.ts`:
- `keyTopics` → rendered as `## Key Highlights`
- `actionItems` → rendered as `## Tasks`

Do not rename the AI-facing field names in the prompt — it would break parsing of AI responses.

### Sync with web app
This plugin ports shared logic from `@igggy/core` (web app `packages/core/`) rather than consuming it as a dependency. When the web app changes `NoteContent` shape, prompt rules, or frontmatter schema, mirror the change here. Check `docs/PLUGIN-INTEGRATION.md` in the web app repo (`andrewlassetter/igggy`) for the living integration checklist.

## Docs (`/docs`)

| File | Description |
|---|---|
| `SERVICES.md` | Third-party services registry with rationale |
| (no `STATUS.md`)  | Status tracked in web app repo: `igggy/docs/STATUS.md` — single source of truth for both |
| `2026-03-06 - Obsidian Plugin UI Design Research.md` | Obsidian plugin UI capabilities: extension points, CSS variables, built-in components, design guidelines |
