import { Notice, normalizePath } from 'obsidian'
import type { SyncPayload } from '@igggy/types'
import type IgggyPlugin from '../main'
import { createClient } from '../commands'
import { IgggyApiError } from '../api/igggy-client'
import { drainPendingSyncs, pullFromCloud } from './pull'

const BATCH_SIZE = 50
const BATCH_DELAY_MS = 200

/**
 * Extracts the minimum required fields for POST /api/v1/notes/sync from
 * a note's raw markdown content. Returns null if required fields are missing.
 */
function parseNoteForSync(content: string): SyncPayload | null {
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

  const summaryMatch = content.match(/## Summary\s*\n\n([\s\S]*?)(?=\n\n##|\n\n> \[!note\]|$)/)
  const summary = summaryMatch?.[1]?.trim()
  if (!summary) return null

  let transcript: string | undefined

  const calloutMatch = content.match(/> \[!note\]-?\s*Transcript\s*\n((?:>.*\n?)*)/)
  if (calloutMatch) {
    transcript = calloutMatch[1]
      .split('\n')
      .map((line) => line.replace(/^>\s?/, ''))
      .join('\n')
      .trim()
  }

  if (!transcript) {
    const detailsMatch = content.match(
      /## Transcript\s*\n+<details>\s*\n*<summary>Full transcript<\/summary>\s*\n+([\s\S]*?)\n*\s*<\/details>/
    )
    if (detailsMatch) transcript = detailsMatch[1].trim()
  }

  // Also try bare ## Transcript heading
  if (!transcript) {
    const bareMatch = content.match(/## Transcript\s*\n+([\s\S]*?)(?=\n## |\n> \[!info\]|\n---\s*$|$)/)
    if (bareMatch) transcript = bareMatch[1].trim()
  }

  if (!transcript) return null

  return {
    igggy_id: igggyId,
    title,
    transcript,
    summary,
    type: (type ?? 'MEETING') as SyncPayload['type'],
    date,
    duration_sec,
    source: 'reindex',
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Scans the entire vault for Igggy notes and pushes each to the sync endpoint
 * in batches. Starter/Pro only — rate-limited to once per hour.
 */
export async function reindexVault(plugin: IgggyPlugin): Promise<void> {
  await drainPendingSyncs(plugin)
  await pullFromCloud(plugin)

  const outputFolder = normalizePath(plugin.settings.outputFolder)
  const igggyFiles = plugin.app.vault.getMarkdownFiles().filter((f) => {
    if (!f.path.startsWith(outputFolder + '/') && f.path !== outputFolder) return false
    const cache = plugin.app.metadataCache.getFileCache(f)
    return !!cache?.frontmatter?.igggy_id
  })

  if (igggyFiles.length === 0) {
    new Notice('Igggy: No notes found to sync.', 4000)
    return
  }

  const client = createClient(plugin)
  const progressNotice = new Notice(`Syncing notes\u2026 0 / ${igggyFiles.length}`, 0)

  let synced = 0
  let failed = 0

  for (let i = 0; i < igggyFiles.length; i++) {
    const file = igggyFiles[i]
    progressNotice.setMessage(`Syncing notes\u2026 ${i + 1} / ${igggyFiles.length}`)

    try {
      const content = await plugin.app.vault.read(file)
      const payload = parseNoteForSync(content)

      if (!payload) {
        failed++
        continue
      }

      await client.pushSync(payload)
      synced++
    } catch (err) {
      if (err instanceof IgggyApiError && err.status === 429) {
        progressNotice.hide()
        new Notice(err.message, 6000)
        return
      }
      console.warn('[Igggy] Reindex error for', file.path, err)
      failed++
    }

    if ((i + 1) % BATCH_SIZE === 0 && i + 1 < igggyFiles.length) {
      await sleep(BATCH_DELAY_MS)
    }
  }

  plugin.settings.lastSyncedAt = Date.now()
  await plugin.saveSettings()

  progressNotice.hide()

  const message =
    failed > 0
      ? `Synced ${synced} note${synced !== 1 ? 's' : ''} \u00B7 ${failed} failed`
      : `Synced ${synced} note${synced !== 1 ? 's' : ''} \u2713`
  new Notice(`Igggy: ${message}`, 5000)
}
