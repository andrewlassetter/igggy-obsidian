import { Notice, TFile, normalizePath, requestUrl } from 'obsidian'
import { normalizeNoteType } from '@igggy/core'
import type IgggyPlugin from '../main'
import { getAuthToken, APP_URL } from '../commands'
import { generateMarkdown, type NoteTemplateData } from '../notes/template'
import { formatNoteFilename } from '@igggy/core'

// ── Types ────────────────────────────────────────────────────────────────────

interface CloudNote {
  id: string
  igggyId: string | null
  title: string
  noteType: string
  createdAt: string
  aiSummary: string
  rawTranscript: string
  audioDurationSec: number | null
  source: string | null
  keyTopics: string | null
  content: string | null
  decisions: string | null
  speakers: string | null
  analysisJson: string | null
  tasks: Array<{ content: string; owner: string | null; sourceSegment: string | null }>
}

interface PullResponse {
  notes: CloudNote[]
  serverTime: string
  hasMore: boolean
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
    // Only scan files in the output folder
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
 * Only runs when:
 *   - mode is 'starter' or 'pro'
 *   - cloudBackupEnabled is true
 */
export async function pullFromCloud(plugin: IgggyPlugin): Promise<void> {
  const { settings } = plugin

  // Guard: only authenticated users with cloud backup
  if (!['starter', 'pro'].includes(settings.mode)) return
  if (!settings.cloudBackupEnabled) return
  if (!settings.accessToken) return

  try {
    const token = await getAuthToken(plugin)
    const localIndex = buildIgggyIdIndex(plugin)
    let since = settings.lastPulledAt ?? new Date(0).toISOString()
    let totalCreated = 0
    let hasMore = true

    while (hasMore) {
      const res = await requestUrl({
        url: `${APP_URL}/api/notes/sync?since=${encodeURIComponent(since)}`,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        throw: false,
      })

      if (res.status === 403) {
        // Not Pro — silently skip pull
        return
      }

      if (res.status === 401) {
        console.warn('[Igggy] Pull sync unauthorized — token may be expired')
        return
      }

      if (res.status < 200 || res.status >= 300) {
        console.warn('[Igggy] Pull sync unexpected status:', res.status)
        return
      }

      const data = res.json as PullResponse

      for (const note of data.notes) {
        if (!note.igggyId) continue
        if (localIndex.has(note.igggyId)) continue

        // Create vault file for this cloud note
        await createVaultFileFromCloud(plugin, note)
        localIndex.add(note.igggyId)
        totalCreated++
      }

      hasMore = data.hasMore
      if (hasMore && data.notes.length > 0) {
        // Use the last note's createdAt as the next cursor
        since = data.notes[data.notes.length - 1].createdAt
      } else {
        hasMore = false
      }

      // Save serverTime as the new cursor
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

async function createVaultFileFromCloud(plugin: IgggyPlugin, note: CloudNote): Promise<void> {
  const noteType = normalizeNoteType(note.noteType)
  const date = new Date(note.createdAt).toISOString().slice(0, 10)

  const keyTopics = note.keyTopics
    ? JSON.parse(note.keyTopics) as Array<{ topic: string; bullets: string[] }>
    : []
  const content = note.content ? JSON.parse(note.content) as string[] : []
  const decisions = note.decisions ? JSON.parse(note.decisions) as string[] : []

  const templateData: NoteTemplateData = {
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
    igggyId: note.igggyId!,
    transcript: note.rawTranscript,
    durationSec: note.audioDurationSec ?? undefined,
    embedAudio: false, // No audio file in vault for cloud-pulled notes
    showTasks: plugin.settings.showTasks,
    analysisJson: note.analysisJson ?? undefined,
    speakersJson: note.speakers ?? undefined,
  }

  const markdown = generateMarkdown(templateData)

  // Write to output folder with collision handling
  const folderPath = normalizePath(plugin.settings.outputFolder)
  const folder = plugin.app.vault.getAbstractFileByPath(folderPath)
  if (!folder) {
    await plugin.app.vault.createFolder(folderPath)
  }

  const filename = formatNoteFilename(note.title, date)
  let filePath = normalizePath(`${folderPath}/${filename}`)

  // Collision resolution
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

  const token = await getAuthToken(plugin)
  const remaining: typeof settings.pendingSyncs = []

  for (const entry of settings.pendingSyncs) {
    try {
      const res = await requestUrl({
        url: `${APP_URL}/api/notes/sync`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(entry.payload),
        throw: false,
      })

      if (res.status >= 200 && res.status < 300) {
        // Success — drop from queue
        continue
      }
      // Non-success — keep in queue
      remaining.push(entry)
    } catch {
      remaining.push(entry)
    }
  }

  settings.pendingSyncs = remaining
  await plugin.saveSettings()
}
