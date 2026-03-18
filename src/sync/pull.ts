import { Notice, TFile, normalizePath } from 'obsidian'
import { normalizeNoteType, formatNoteFilename } from '@igggy/types'
import type { PullSyncNote } from '@igggy/types'
import type IgggyPlugin from '../main'
import { createClient, getAuthToken } from '../commands'
import { generateMarkdownFromContent } from '../notes/template-legacy'
import type { LegacyNoteTemplateData } from '../notes/template-legacy'

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Parse a JSON string field from the DB, or pass through if already an array/object. */
function parseJsonField<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback
  if (typeof value !== 'string') return value as T
  try { return JSON.parse(value) as T } catch { return fallback }
}

// ── igggyId index ────────────────────────────────────────────────────────────

/**
 * Scans markdown files in the configured output folder and builds a Set of
 * igggyIds already present in the vault. Uses the metadata cache (no file reads).
 */
export function buildIgggyIdIndex(plugin: IgggyPlugin): Set<string> {
  const index = new Set<string>()
  const outputFolder = normalizePath(plugin.settings.outputFolder)

  for (const file of plugin.app.vault.getMarkdownFiles()) {
    if (!file.path.startsWith(outputFolder + '/') && file.path !== outputFolder) continue

    const cache = plugin.app.metadataCache.getFileCache(file)
    const igggyId = cache?.frontmatter?.igggy_id
    if (typeof igggyId === 'string' && igggyId) {
      index.add(igggyId)
    }
  }

  return index
}

// ── Pull sync ────────────────────────────────────────────────────────────────

/**
 * Pulls notes from the Igggy cloud that don't exist locally.
 * Creates vault files for new notes. Handles pagination.
 *
 * Only runs when mode is 'starter' or 'pro' and cloudBackupEnabled is true.
 */
export async function pullFromCloud(plugin: IgggyPlugin): Promise<void> {
  const { settings } = plugin

  if (!settings.cloudBackupEnabled) {
    console.debug('[Igggy] Pull sync skipped: cloudBackupEnabled is false')
    return
  }
  if (!settings.accessToken) {
    console.debug('[Igggy] Pull sync skipped: no access token')
    return
  }

  try {
    const client = createClient(plugin)
    const localIndex = buildIgggyIdIndex(plugin)
    let since = settings.lastPulledAt ?? new Date(0).toISOString()
    let totalCreated = 0
    let hasMore = true

    while (hasMore) {
      const data = await client.pullSync(since)

      for (const note of data.notes) {
        if (!note.igggyId) continue
        if (localIndex.has(note.igggyId)) continue

        await createVaultFileFromCloud(plugin, note)
        localIndex.add(note.igggyId)
        totalCreated++
      }

      hasMore = data.hasMore
      if (hasMore && data.notes.length > 0) {
        since = data.notes[data.notes.length - 1].createdAt
      } else {
        hasMore = false
      }

      settings.lastPulledAt = data.serverTime
      await plugin.saveSettings()
    }

    if (totalCreated > 0) {
      new Notice(`Igggy: Pulled ${totalCreated} note${totalCreated !== 1 ? 's' : ''} from cloud.`, 4000)
    }
  } catch (err) {
    console.error('[Igggy] Pull sync error:', err)
  }
}

// ── Create vault file from cloud note ────────────────────────────────────────

async function createVaultFileFromCloud(plugin: IgggyPlugin, note: PullSyncNote): Promise<void> {
  const noteType = normalizeNoteType(note.noteType)
  const date = new Date(note.createdAt).toISOString().slice(0, 10)

  const keyTopics = parseJsonField(note.keyTopics, [])
  const content = parseJsonField(note.content, [])
  const decisions = parseJsonField(note.decisions, [])

  const templateData: LegacyNoteTemplateData = {
    noteContent: {
      title: note.title,
      noteType,
      summary: note.aiSummary,
      keyTopics,
      content,
      decisions,
      actionItems: note.tasks.map((t) => ({
        content: t.content,
        owner: t.owner ?? null,
        context: t.sourceSegment ?? '',
      })),
    },
    date,
    igggyId: note.igggyId,
    transcript: note.rawTranscript,
    durationSec: note.audioDurationSec ?? undefined,
    embedAudio: false,
    showTasks: plugin.settings.showTasks,
    analysisJson: note.analysisJson
      ? (typeof note.analysisJson === 'string' ? note.analysisJson : JSON.stringify(note.analysisJson))
      : undefined,
    speakersJson: note.speakers
      ? (typeof note.speakers === 'string' ? note.speakers : JSON.stringify(note.speakers))
      : undefined,
    noteSource: note.source ?? undefined,
  }

  const markdown = generateMarkdownFromContent(templateData)

  const folderPath = normalizePath(plugin.settings.outputFolder)
  const folder = plugin.app.vault.getAbstractFileByPath(folderPath)
  if (!folder) {
    await plugin.app.vault.createFolder(folderPath)
  }

  const filename = formatNoteFilename(note.title, date)
  let filePath = normalizePath(`${folderPath}/${filename}`)

  let counter = 2
  while (plugin.app.vault.getAbstractFileByPath(filePath) instanceof TFile) {
    const base = filename.replace(/\.md$/, '')
    filePath = normalizePath(`${folderPath}/${base} ${counter}.md`)
    counter++
  }

  await plugin.app.vault.create(filePath, markdown)
}

// ── Pending syncs drain ──────────────────────────────────────────────────────

/**
 * Attempts to push any queued sync payloads that previously failed.
 * Removes successful ones from the queue. Called at the start of each pull cycle.
 */
export async function drainPendingSyncs(plugin: IgggyPlugin): Promise<void> {
  const { settings } = plugin
  if (settings.pendingSyncs.length === 0) return
  if (!settings.accessToken) return

  const client = createClient(plugin)
  const remaining: typeof settings.pendingSyncs = []

  for (const entry of settings.pendingSyncs) {
    try {
      await client.pushSync(entry.payload as unknown as import('@igggy/types').SyncPayload)
    } catch {
      remaining.push(entry)
    }
  }

  settings.pendingSyncs = remaining
  await plugin.saveSettings()
}
