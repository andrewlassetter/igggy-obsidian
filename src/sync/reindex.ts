import { Notice, requestUrl } from 'obsidian'
import type IgggyPlugin from '../main'
import { getAuthToken, APP_URL } from '../commands'

const BATCH_SIZE = 50
const BATCH_DELAY_MS = 200

interface SyncPayload {
  igggy_id: string
  title: string
  transcript: string
  summary: string
  type?: string
  date?: string
  duration_sec?: number
  source: string
}

/**
 * Extracts the minimum required fields for POST /api/notes/sync from
 * a note's raw markdown content. Returns null if required fields are missing.
 */
function parseNoteForSync(content: string): SyncPayload | null {
  // ── Frontmatter ───────────────────────────────────────────────────────────
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (!fmMatch) return null
  const fm = fmMatch[1]

  const igggyId = fm.match(/^igggy_id:\s*(.+)$/m)?.[1]?.trim()
  if (!igggyId) return null

  const title = fm.match(/^title:\s*"?(.+?)"?\s*$/m)?.[1]?.trim()
  if (!title) return null

  const date = fm.match(/^date:\s*(.+)$/m)?.[1]?.trim()
  const type = fm.match(/^type:\s*(.+)$/m)?.[1]?.trim()
  const durationStr = fm.match(/^duration_sec:\s*(\d+)$/m)?.[1]
  const duration_sec = durationStr ? parseInt(durationStr, 10) : undefined

  // ── Summary ───────────────────────────────────────────────────────────────
  const summaryMatch = content.match(/## Summary\s*\n\n([\s\S]*?)(?=\n\n##|\n\n> \[!note\]|$)/)
  const summary = summaryMatch?.[1]?.trim()
  if (!summary) return null

  // ── Transcript ────────────────────────────────────────────────────────────
  let transcript: string | undefined

  // Callout pattern (current plugin format): > [!note]- Transcript
  const calloutMatch = content.match(/> \[!note\]-?\s*Transcript\s*\n((?:>.*\n?)*)/)
  if (calloutMatch) {
    transcript = calloutMatch[1]
      .split('\n')
      .map((line) => line.replace(/^>\s?/, ''))
      .join('\n')
      .trim()
  }

  // <details> pattern (older plugin notes)
  if (!transcript) {
    const detailsMatch = content.match(
      /## Transcript\s*\n+<details>\s*\n*<summary>Full transcript<\/summary>\s*\n+([\s\S]*?)\n*\s*<\/details>/
    )
    if (detailsMatch) transcript = detailsMatch[1].trim()
  }

  if (!transcript) return null

  return { igggy_id: igggyId, title, transcript, summary, type, date, duration_sec, source: 'reindex' }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Scans the entire vault for Igggy notes (markdown files with an igggy_id
 * frontmatter field) and pushes each to POST /api/notes/sync in batches of 50.
 *
 * Starter/Pro only — the server rate-limits this to once per hour.
 * Shows live progress via Obsidian Notice. Handles 429 gracefully.
 */
export async function reindexVault(plugin: IgggyPlugin): Promise<void> {
  // Use the metadata cache to find Igggy notes without reading every file
  const igggyFiles = plugin.app.vault.getMarkdownFiles().filter((f) => {
    const cache = plugin.app.metadataCache.getFileCache(f)
    return !!cache?.frontmatter?.igggy_id
  })

  if (igggyFiles.length === 0) {
    new Notice('Igggy: No notes found to sync.', 4000)
    return
  }

  const token = await getAuthToken(plugin)
  const progressNotice = new Notice(`Syncing notes… 0 / ${igggyFiles.length}`, 0)

  let synced = 0
  let failed = 0

  for (let i = 0; i < igggyFiles.length; i++) {
    const file = igggyFiles[i]
    progressNotice.setMessage(`Syncing notes… ${i + 1} / ${igggyFiles.length}`)

    try {
      const content = await plugin.app.vault.read(file)
      const payload = parseNoteForSync(content)

      if (!payload) {
        failed++
        continue
      }

      const res = await requestUrl({
        url: `${APP_URL}/api/notes/sync`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
        throw: false, // don't throw on non-2xx — handle manually
      })

      if (res.status === 429) {
        progressNotice.hide()
        const retryAfterSec = (res.json as { retryAfterSec?: number }).retryAfterSec
        const mins = retryAfterSec ? Math.ceil(retryAfterSec / 60) : 60
        new Notice(
          `Igggy: Already synced recently — try again in ${mins} minute${mins !== 1 ? 's' : ''}.`,
          6000
        )
        return
      }

      if (res.status >= 200 && res.status < 300) {
        synced++
      } else {
        console.warn('[Igggy] Reindex unexpected status', res.status, 'for', file.path)
        failed++
      }
    } catch (err) {
      console.error('[Igggy] Reindex error for', file.path, err)
      failed++
    }

    // Brief pause between batches to avoid DB connection exhaustion
    if ((i + 1) % BATCH_SIZE === 0 && i + 1 < igggyFiles.length) {
      await sleep(BATCH_DELAY_MS)
    }
  }

  // Persist lastSyncedAt and refresh settings display
  plugin.settings.lastSyncedAt = Date.now()
  await plugin.saveSettings()

  progressNotice.hide()

  const message =
    failed > 0
      ? `Synced ${synced} note${synced !== 1 ? 's' : ''} · ${failed} failed`
      : `Synced ${synced} note${synced !== 1 ? 's' : ''} ✓`
  new Notice(`Igggy: ${message}`, 5000)
}
