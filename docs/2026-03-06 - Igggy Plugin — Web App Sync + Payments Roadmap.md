# Igggy Plugin — Web App Sync + Payments Roadmap

_Created: 2026-03-06_

This doc captures the analysis of what the plugin needs to do following the `276b08b` web app commit (which shipped `@igggy/core`, `GET /api/notes`, and vault-compatible frontmatter). It also documents the payments/Lemon Squeezy strategy.

---

## What Changed in the Web App (Commit `276b08b`)

Three things with direct plugin implications:

1. **`@igggy/core` shared package** (`packages/core/`) — canonical types (`NoteContent`, `NoteTask`, `NoteType`, `TranscriptMeta`), `buildPrompt()`, `buildContextHint()`, `toMarkdown()`, `validateNoteContent()`. The plugin's `src/ai/prompt.ts` and `src/ai/providers/types.ts` are now manual duplicates of this.

2. **`GET /api/notes?since=&limit=` endpoint** — ready for plugin polling. Returns all user notes updated after `since`, in ascending `updatedAt` order, with tasks inline. This is the endpoint the plugin will use for web app → vault sync.

3. **Canonical vault frontmatter schema** — `toMarkdown()` in core now produces:
   ```yaml
   ---
   igggy_id: <uuid>
   created: 2026-03-06T09:30:00Z
   type: MEETING
   duration_sec: 2160
   source: igggy
   ---
   ```
   The plugin's `template.ts` frontmatter is currently diverged from this.

---

## Lemon Squeezy / Payments Status

**Nothing is built yet. It's backlog in both repos.**

The strategy is documented in the web app's `docs/PLUGIN-INTEGRATION.md`:

- **Web app**: `POST /api/license/validate → { valid: boolean, plan: string }` endpoint
- **Plugin**: `licenseKey` field in `IggyNoteSettings` → calls validate on save → gates pro features:
  - Unlimited recordings/month (free tier: 5/month)
  - Deepgram transcription option
  - Unified task list view

### Recommended order before building payments

1. ✅ `npm run build` — confirmed clean (2026-03-06)
2. E2E test all 6 scenarios in a live vault (see STATUS.md checklist)
3. Create GitHub release `0.1.0` + submit PR to `obsidianmd/obsidian-releases`
4. Build Framer marketing site + Loops waitlist while awaiting review (2–8 weeks)
5. Set up Lemon Squeezy product + build `POST /api/license/validate`
6. Add license key field to plugin settings + gate pro features

---

## Plugin Changes Needed

### Priority 1 — Before Marketplace Submission

#### 1. Fix frontmatter in `src/notes/template.ts`

Current frontmatter:
```yaml
---
title: "..."
date: YYYY-MM-DD
type: MEETING
duration: "X min"        ← string, uses source field for audio path
source: "audio/file.m4a" ← this is the audio path, not igggy identity
tags: [igggy, meeting]
---
```

Target (aligned with `@igggy/core`):
```yaml
---
igggy_id: <crypto.randomUUID()>   ← NEW — stable identity for dedup
title: "..."
date: YYYY-MM-DD
type: MEETING
duration_sec: 2160               ← NEW — raw number, not "X min" string
audio: "audio/file.m4a"          ← RENAMED from source
source: igggy                    ← NEW — always "igggy", identifies Igggy-created files
tags: [igggy, meeting]
---
```

**Changes to `generateMarkdown()` in `template.ts`:**
- Add `iggyId?: string` to `NoteTemplateData` interface
- Generate `iggyId` upstream in `writer.ts` via `crypto.randomUUID()` (available in Electron/Chromium)
- Add `igggy_id: ${iggyId}` as first frontmatter field
- Rename `source:` audio path field to `audio:`
- Add `source: igggy` always (omit if no audio path for audio field, but source: igggy always present)
- Change `duration: "${durationStr}"` → `duration_sec: ${durationSec}` (raw number, omit if null)

> **Why now?** Adding `igggy_id` before marketplace submission means every note created from day one has a stable identity. This makes the future sync/dedup feature work with notes created by early adopters — no migration needed.

#### 2. Add `JOURNAL` note type

The plugin's `buildPrompt()` (in `src/ai/prompt.ts`) only classifies into `MEETING | ONE_ON_ONE | MEMO`. The web app's `@igggy/core` has a 4th type: `JOURNAL`.

- Add `JOURNAL` to the type options in the prompt
- Add `JOURNAL` to `NoteType` in `src/ai/providers/types.ts`
- Add `JOURNAL` to `NOTE_TYPE_LABELS` if used in settings UI

#### 3. Update `docs/STATUS.md` (plugin)

Under "Cross-Device Sync" backlog: note that `GET /api/notes` is live in the web app at `https://igggy.ai/api/notes?since=&limit=` — the server side is ready, plugin polling is the remaining piece.

---

### Priority 2 — Before Sync Feature (Phase 4)

#### 4. Consume `@igggy/core` instead of maintaining parallel copies

The plugin's `src/ai/prompt.ts` = copy of `packages/core/src/prompt.ts`.
The plugin's `src/ai/providers/types.ts` = copy of `packages/core/src/types.ts`.

These will drift. Before building sync, eliminate the copies:

```json
// igggy-obsidian/package.json
"@igggy/core": "github:andrewlassetter/igggy#main&path=packages/core"
```

Then in `src/ai/providers/claude.ts` and `src/ai/providers/openai.ts`:
```typescript
import { buildPrompt, buildContextHint } from '@igggy/core'
import type { NoteContent, TranscriptMeta, NoteType } from '@igggy/core'
```

Delete `src/ai/prompt.ts` and `src/ai/providers/types.ts`.

> **Note on esbuild**: esbuild handles the `@igggy/core` TypeScript source directly when bundling `main.js` — no separate build step needed. The path resolution works via the git reference in package.json.

#### 5. Web app → vault sync (write-once polling)

Using the live `GET /api/notes` endpoint:

```
On plugin load + every 15min (if syncWithWebApp: true):
  1. GET /api/notes?since=<lastSyncCursor>
  2. For each note:
     a. If note.id in writtenIds → skip (write-once invariant)
     b. Build NoteContent + NoteTask[] from response
     c. toMarkdown() from @igggy/core → produces frontmatter-complete .md
     d. vault.create(path, markdown)   ← create only, NEVER modify
     e. Add note.id to writtenIds (persisted in plugin.data)
  3. Update lastSyncCursor = newest updatedAt seen
```

New plugin settings: `syncWithWebApp: boolean`, `lastSyncCursor: string`, `writtenIds: string[]`.

#### 6. Regeneration modal ("Save as new" flow)

After regeneration completes in the plugin, show a modal:
> **Note regenerated** — the original vault file has not been modified.
> [Create new vault file] [Discard]

"Create new vault file" → writes with versioned filename: `YYYY-MM-DD - slug (v2).md`.
Same `igggy_id` as original (same source audio). Versioned suffix prevents overwrite.

---

## Files to Change

| File | Priority | Change |
|------|----------|--------|
| `src/notes/template.ts` | P1 | `igggy_id`, rename `source`→`audio`, add `source: igggy`, `duration_sec` |
| `src/notes/writer.ts` | P1 | Generate `iggyId = crypto.randomUUID()`, pass to `generateMarkdown()` |
| `src/ai/prompt.ts` | P1 | Add `JOURNAL` classification |
| `src/ai/providers/types.ts` | P1 | Add `JOURNAL` to `NoteType` |
| `docs/STATUS.md` | P1 | Note `GET /api/notes` is live |
| `package.json` | P2 | Add `@igggy/core` git reference |
| `src/ai/prompt.ts` | P2 | Replace with import from `@igggy/core` (delete file) |
| `src/ai/providers/types.ts` | P2 | Replace with import from `@igggy/core` (delete file) |
| (new) sync service | P2 | `fetchNewNotes()`, `writtenIds` Set, polling interval |
| (new) regen modal | P2 | "Create new vault file" / "Discard" |

---

## Verification

### After P1 changes
- `npm run build` — zero TS errors
- Process an audio file → open generated note → verify frontmatter has `igggy_id` (a UUID), `source: igggy`, `audio:` (path), `duration_sec` (number)
- Re-process same file → new note has a **different** `igggy_id` (each processing run generates a new UUID)
- Whisper-only path still works (no `audio:` field if embed disabled is fine, but `source: igggy` always present)

### After P2 sync
- Enable `syncWithWebApp` → create a note in the web app → wait for poll → note appears in vault with correct frontmatter
- Edit the vault file → next poll → file NOT modified (`igggy_id` in `writtenIds` → skip)
- Regenerate a note → modal appears → "Create new vault file" → `(v2)` file created → original untouched
