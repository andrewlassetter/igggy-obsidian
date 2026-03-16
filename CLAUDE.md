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

Obsidian plugin for audio-to-notes. Audio selected via fuzzy modal → preprocessed to 32kbps MP3 (`src/audio/preprocessor.ts`) → transcribed (Whisper/Deepgram) → two-pass AI pipeline via `@igggy/core` → markdown note written to vault (`src/notes/template.ts` → `src/notes/writer.ts`). All HTTP calls use `Obsidian.requestUrl` except multipart audio uploads.

**`@igggy/core` dependency:** `file:../igggy-web/packages/core` — shared types, prompts, validation. esbuild inlines it into `main.js`. Run `npm run build:core` after modifying core. Behavioral rules in `../igggy-web/docs/contracts/`.

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

Two platforms: web app (`../igggy-web`) + this plugin. Shared contracts in `../igggy-web/docs/contracts/`. If a change touches `@igggy/core`, frontmatter, settings, or prompt logic, flag cross-platform impact. Read `../igggy-web/docs/PARITY-MANIFEST.md` during planning. Every plan must include a "## Cross-Platform Implications" section.

## Behavioral Contracts

Structured documentation of product invariants and behavioral rules. Lives in `../igggy-web/docs/contracts/` (private repo — contracts cover both platforms).

| Contract | Covers |
|----------|--------|
| `../igggy-web/docs/contracts/ai-pipeline.md` | Two-pass pipeline ordering, signal semantics, InsufficientContentError retry, model selection |
| `../igggy-web/docs/contracts/core-types.md` | NoteContent, TranscriptAnalysis, NoteType, SpeakersData — shapes, normalization |
| `../igggy-web/docs/contracts/frontmatter.md` | YAML frontmatter schema, metadata callout format, section layout by note type |
| `../igggy-web/docs/contracts/api-endpoints.md` | Request/response contracts for endpoints this plugin consumes |
| `../igggy-web/docs/contracts/settings-parity.md` | Settings that must exist on both platforms, defaults, known gaps |
| `../igggy-web/docs/contracts/search.md` | FTS vector update invariant, search query format, vector must be updated after all note mutations |
| `../igggy-web/docs/contracts/sync.md` | Immutable note model, insert-only push, create-only pull, igggyId as sync key, note source tracking |

## Feature Flags

`src/feature-flags.ts` contains launch-time feature visibility toggles.

| Flag | Default | Purpose |
|------|---------|---------|
| `TASKS_ENABLED` | `false` | Hides task UI (settings toggle, regen modal toggle). Tasks are still extracted and stored in note metadata. Flip to `true` when ready to launch. |
| `TRANSCRIPT_EDITING` | `false` | Hides "Edit transcript" command and context menu item. Editing modal code stays but is unreachable. |
| `SPEAKER_NAMING` | `false` | Hides "Name speakers" command and context menu item. Deepgram diarization still runs. |

**Scope — which files trigger which contracts:**
- `src/ai/providers/*.ts`, `src/commands.ts` (pipeline orchestration) → `ai-pipeline.md`
- `src/notes/template.ts`, `src/notes/parser.ts` → `frontmatter.md`
- `src/settings.ts`, `src/settings-tab.ts` → `settings-parity.md`
- Files consuming `@igggy/core` types → `core-types.md`
- `src/sync/*.ts` → `sync.md`
- Other files → no contract check needed

**Conflict guard — before implementing any change:**
If a requested change would violate a contract invariant or conflict with a When/Then rule, STOP and flag it before writing code. Present: (1) the specific contract and rule that would be violated, (2) what the request conflicts with, (3) two options: adjust the approach to comply, or proceed AND update the contract — user must explicitly confirm. Never silently update or ignore a contract.

**Cost guard — before implementing any change:**
If a change introduces a new external service, upgrades a tier, adds usage-based API calls, increases storage/compute, or would push a free-tier service past its limits, STOP and flag it before writing code. Present: (1) what the cost impact is, (2) whether it's one-time or recurring, (3) rough estimate if possible. Reference `../igggy-web/docs/SERVICES.md` (if it exists) for current services and tiers. Never silently introduce new costs. See `~/.claude/docs/cost-awareness.md` for full guidance.

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
