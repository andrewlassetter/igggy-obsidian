# Igggy Obsidian Plugin — Developer Guide

**Repo:** https://github.com/andrewlassetter/igggy-obsidian

## Commands

```bash
npm run dev       # builds @igggy/core, then esbuild in watch mode — auto-rebuilds to main.js on save
npm run build     # builds @igggy/core, tsc type-check + esbuild production bundle (no sourcemaps)
npm run build:core # builds @igggy/core only (cd ../igggy-web/packages/core && npm run build)
npm run lint      # eslint on src/ (TypeScript)
```

## Dev Environment

- **No `.env` file** — Igggy Open mode uses user-provided API keys entered at runtime in Obsidian settings, not build-time config
- **Output file** — esbuild writes to `main.js` at the repo root (not `dist/`); this is what Obsidian loads
- **Install in Obsidian for testing** — symlink or copy the repo into `<vault>/.obsidian/plugins/igggy/`; enable the plugin in Obsidian → Settings → Community plugins
- **Rebuild required** — Obsidian does not hot-reload plugins; after `npm run dev` rebuilds, use the "Reload app without saving" command in Obsidian (or disable/re-enable the plugin)
- **Desktop only** — `isDesktopOnly: true` in `manifest.json`; mobile Obsidian will not load this plugin

## Architecture

Audio files in the user's Obsidian vault are selected via a fuzzy modal or context menu. The audio is pre-processed by `src/audio/preprocessor.ts` (Web Audio API + lamejs: mono 16kHz 32kbps MP3) to reduce size before upload. The compressed audio is sent to a transcription provider (OpenAI Whisper or Deepgram Nova-3) via HTTP.

### `@igggy/core` Dependency

The plugin consumes `@igggy/core` via a `file:` dependency (`"@igggy/core": "file:../igggy-web/packages/core"`). Shared types (`NoteContent`, `TranscriptAnalysis`, `NoteType`, etc.), prompt builders (`buildAnalysisPrompt`, `buildSummarizationPrompt`, `buildPrompt`), and validators (`validateNoteContent`, `validateAnalysis`) all come from core. esbuild inlines the core package into `main.js` — no external dependency at runtime.

**When modifying core**: Run `npm run build:core` (or `npm run build` which does it automatically). The plugin's `node_modules/@igggy/core` is a symlink to `../igggy-web/packages/core`.

### AI Summarization (Two-Pass Pipeline)

The transcript goes through a two-pass adaptive pipeline via `@igggy/core`:

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
| `src/ai/providers/types.ts` | Plugin-only interfaces: `SummarizationProvider`, `SummarizeOptions`. Shared types come from `@igggy/core` |
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
- Legacy types `ONE_ON_ONE` and `JOURNAL` are mapped via `normalizeNoteType()` from `@igggy/core` — never create new records with these values

### AI field names vs. display names (do not conflate)
The prompt (`@igggy/core/src/prompt.ts`) asks the AI to return `keyHighlights` and `actionItems` — these are the AI-facing JSON keys. Core's `validateNoteContent()` maps `keyHighlights` → `keyTopics`. Display names in `src/notes/template.ts`:
- `keyTopics` → rendered as `## Key Highlights`
- `actionItems` → rendered as `## Tasks`

Do not rename the AI-facing field names in the core prompt — it would break parsing of AI responses.

## Cross-Platform Parity

Igggy ships on two platforms: the web app (`../igggy-web`) and this Obsidian plugin.

**When planning any feature or change:**
1. Read the web app's `../igggy-web/docs/PARITY-MANIFEST.md` for the shared contract surface and current feature parity state
2. Read `../igggy-web/docs/PLUGIN-INTEGRATION.md` for the living integration checklist
3. Identify if the change affects shared contracts (see list below)
4. If it does: include a **"Cross-Platform Implications"** section in the plan that specs what the web app needs. Ask the user how they want to handle the web side.
5. If it's a plugin-only feature (vault-specific, Obsidian UI), note that explicitly so the user can confirm.

**When implementing:**
- If you modify prompt logic, types, or validation: flag it. These must stay in sync with `@igggy/core`.
- If you add a new setting or preference: flag it. The web app may need a matching setting.
- If you change frontmatter schema: flag it. The web app's folder sync depends on this.
- After completing any feature work, update `../igggy-web/docs/PARITY-MANIFEST.md` and `../igggy-web/docs/PLUGIN-INTEGRATION.md` if parity state changed.

**Shared contracts to watch:**
- `@igggy/core` — consumed via `file:` reference; types, prompts, validation
- Frontmatter schema — `igggy_id`, `type`, `igggy_analysis`, `source`, `tags`
- Settings/preferences — tone, density, showTasks, provider selections
- Note types — MEETING, MEMO, LECTURE

**Plan mode requirement:** Every plan must include a "## Cross-Platform Implications" section with:
- Which shared contracts this feature touches
- What the web app needs to match (or why it doesn't apply)
- Spec for the web app implementation if applicable
- Ask the user: "How do you want to handle the web app side?"

## Behavioral Contracts

Structured documentation of product invariants and behavioral rules. Lives in `../igggy-web/docs/contracts/` (private repo — contracts cover both platforms).

| Contract | Covers |
|----------|--------|
| `../igggy-web/docs/contracts/ai-pipeline.md` | Two-pass pipeline ordering, signal semantics, InsufficientContentError retry, model selection |
| `../igggy-web/docs/contracts/core-types.md` | NoteContent, TranscriptAnalysis, NoteType, SpeakersData — shapes, normalization |
| `../igggy-web/docs/contracts/frontmatter.md` | YAML frontmatter schema, metadata callout format, section layout by note type |
| `../igggy-web/docs/contracts/api-endpoints.md` | Request/response contracts for endpoints this plugin consumes |
| `../igggy-web/docs/contracts/settings-parity.md` | Settings that must exist on both platforms, defaults, known gaps |

**Pre-ship checklist — before merging any change:**
1. Identify which contracts are touched by the changed files
2. Read those contracts and check all invariants still hold
3. Check When/Then rules for conflicts with the new behavior
4. If `@igggy/core` changed: run `npm test` in both `igggy-web/` and `igggy-obsidian/`
5. If behavior intentionally changed: update the affected contract docs

## Docs (`/docs`)

| File | Description |
|---|---|
| `SERVICES.md` | Third-party services registry with rationale |
| (no `STATUS.md`)  | Status tracked in web app repo: `igggy/docs/STATUS.md` — single source of truth for both |
| `2026-03-06 - Obsidian Plugin UI Design Research.md` | Obsidian plugin UI capabilities: extension points, CSS variables, built-in components, design guidelines |
