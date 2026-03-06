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

Audio files in the user's Obsidian vault are selected via a fuzzy modal or context menu. The audio is pre-processed by `src/audio/preprocessor.ts` (Web Audio API + lamejs: mono 16kHz 32kbps MP3) to reduce size before upload. The compressed audio is sent to a transcription provider (OpenAI Whisper or Deepgram Nova-3) via HTTP. The transcript is passed to a summarization provider (GPT-4o Mini or Claude Sonnet) with a structured prompt from `src/ai/prompt.ts` that returns a typed `NoteContent` JSON object. `src/notes/writer.ts` feeds that into `src/notes/template.ts` to generate markdown with YAML frontmatter, then writes the file to the vault using the Obsidian API. All HTTP calls use `Obsidian.requestUrl` to avoid CORS in Electron, except multipart audio uploads which use native `fetch`.

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
| `src/ai/prompt.ts` | `buildPrompt()` — shared prompt with duration/time-of-day context |
| `src/ai/providers/types.ts` | `NoteContent` type, `SummarizationProvider` interface |
| `src/ai/providers/claude.ts` | Anthropic Claude Sonnet summarization |
| `src/ai/providers/openai.ts` | GPT-4o Mini summarization (JSON mode) |
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
- Note types: `MEETING`, `ONE_ON_ONE`, `MEMO`, `JOURNAL` (screaming snake case in code/frontmatter)

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
| `STATUS.md` | What's built, in progress, planned, and backlog |
| `SERVICES.md` | Third-party services registry with rationale |
| `2026-03-06 - Obsidian Plugin UI Design Research.md` | Obsidian plugin UI capabilities: extension points, CSS variables, built-in components, design guidelines |
