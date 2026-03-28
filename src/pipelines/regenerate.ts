import { Notice, TFile, normalizePath } from 'obsidian'
import type IgggyPlugin from '../main'
import type { ProcessResponse } from '@igggy/types'
import type { VaultNoteMetadata } from '../notes/template'
import { IgggyApiError } from '../api/igggy-client'
import { createClient, validateSummarizationKeys, buildBYOKKeys } from '../auth'
import {
  extractMetadataBlock,
  extractSpeakersJson,
  parseDuration,
  parseAudioPath,
  extractTranscript,
  extractFrontmatter,
  parseDate,
  parseNoteId,
} from '../notes/parser'
import { RegenerateModal, type RegenOptions } from '../ui/regenerate-modal'
import { syncNoteToCloud } from '../sync/push'
import { buildSyncPayload } from '../sync/payload'
import { friendlyError } from './helpers'

// ── Regeneration Pipeline ─────────────────────────────────────────────────────

/**
 * Regenerates a note via the API. When a server noteId is stored in metadata,
 * uses the regen endpoint (fast path — server has transcript + analysis).
 * Otherwise, sends transcript to the process endpoint as text.
 */
async function regenerateNote(
  plugin: IgggyPlugin,
  file: TFile,
  options: RegenOptions
): Promise<void> {
  const { app } = plugin

  // ── 1. Parse existing note ──────────────────────────────────────────────────
  const content = await app.vault.read(file)
  const fm = extractFrontmatter(content)
  if (!fm) {
    new Notice('Igggy: Could not read note frontmatter.', 5000)
    return
  }

  const date = parseDate(fm) ?? new Date().toISOString().slice(0, 10)
  const metaBlock = extractMetadataBlock(content)
  const durationSec = parseDuration(fm, metaBlock)
  const audioPath = parseAudioPath(fm, metaBlock)
  const speakersJson = extractSpeakersJson(metaBlock)
  const storedNoteId = parseNoteId(metaBlock)

  const transcript = extractTranscript(content)
  if (!transcript) {
    new Notice('Igggy: This note has no transcript \u2014 cannot regenerate.', 5000)
    return
  }

  // ── 2. Call API ───────────────────────────────────────────────────────────
  new Notice('Regenerating note\u2026', 3000)

  try {
    const client = createClient(plugin)
    let result: ProcessResponse

    if (storedNoteId) {
      // Fast path: regen via server (has transcript + analysis cached)
      result = await client.regenerate(storedNoteId, {
        forcedNoteType: options.forcedType,
        includeTasks: options.includeTasks,
        customPrompt: options.customPrompt || undefined,
        preferences: { density: options.density, tone: plugin.settings.noteTone },
        keys: buildBYOKKeys(plugin),
      })
    } else {
      // Fallback: send transcript as text to process endpoint
      result = await client.process({
        type: 'text',
        transcript,
        customPrompt: options.customPrompt || undefined,
        preferences: { density: options.density, tone: plugin.settings.noteTone },
        keys: buildBYOKKeys(plugin),
      })
    }

    // ── 3. Write result (always creates a new note) ──────────────────────
    const meta: VaultNoteMetadata = {
      title: result.content.title,
      noteType: result.content.noteType,
      date,
      igggyId: result.igggyId,
      noteId: result.noteId,
      durationSec: result.durationSec ?? durationSec,
      audioPath,
      embedAudio: !!audioPath && plugin.settings.embedAudio,
      analysisJson: JSON.stringify(result.analysis),
      speakersJson: result.speakersJson ?? speakersJson,
      noteSource: 'plugin',
    }

    const markdown = (await import('../notes/template')).wrapMarkdownForVault(result.markdown, meta)

    const safeTitle = result.content.title
      .replace(/[/\\:*?"<>|#^[\]]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100)

    const folderPath = normalizePath(plugin.settings.outputFolder)
    const folder = app.vault.getAbstractFileByPath(folderPath)
    if (!folder) {
      await app.vault.createFolder(folderPath)
    }

    let filePath = normalizePath(`${folderPath}/${date} - ${safeTitle}.md`)
    let counter = 2
    while (app.vault.getAbstractFileByPath(filePath) instanceof TFile) {
      filePath = normalizePath(`${folderPath}/${date} - ${safeTitle} ${counter}.md`)
      counter++
    }

    const newFile = await app.vault.create(filePath, markdown)
    await app.workspace.getLeaf(false).openFile(newFile)

    new Notice('New note created. Original note unchanged.', 4000)

    // Sync to cloud
    void syncNoteToCloud(plugin, buildSyncPayload(result, date, {
      durationSec: result.durationSec ?? durationSec,
    }))
  } catch (err) {
    const message = err instanceof IgggyApiError
      ? err.message
      : err instanceof Error ? err.message : String(err)
    console.error('[Igggy] Regeneration error:', err)
    new Notice(`Igggy: Regeneration failed \u2014 ${friendlyError(message, 'generating note')}`, 6000)
  }
}

export function openRegenerateModal(plugin: IgggyPlugin, file: TFile): void {
  const keyError = validateSummarizationKeys(plugin)
  if (keyError) {
    new Notice(keyError, 6000)
    return
  }

  new RegenerateModal(plugin.app, plugin, file, (options) => {
    void regenerateNote(plugin, file, options)
  }).open()
}
