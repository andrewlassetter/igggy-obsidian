import { Notice, TFile } from 'obsidian'
import type IgggyPlugin from '../main'
import type { ProcessResponse } from '@igggy/types'
import type { VaultNoteMetadata } from '../notes/template'
import { IgggyApiError } from '../api/igggy-client'
import { createClient, buildBYOKKeys } from '../auth'
import { createTextPlaceholder, setPlaceholderError, finalizePlaceholder } from '../notes/writer'
import { syncNoteToCloud } from '../sync/push'
import { buildSyncPayload } from '../sync/payload'
import { friendlyError } from './helpers'

// ── Paste Transcript Pipeline ────────────────────────────────────────────────

export async function processPastedTranscript(plugin: IgggyPlugin, transcript: string): Promise<void> {
  const { app, settings } = plugin
  const date = new Date().toISOString().slice(0, 10)

  let placeholderFile: TFile
  try {
    placeholderFile = await createTextPlaceholder(app, settings.outputFolder)
    await app.workspace.getLeaf(false).openFile(placeholderFile)
  } catch (err) {
    console.error('[Igggy] Failed to create text placeholder:', err)
    new Notice('Failed to create note file \u2014 check your output folder setting.', 6000)
    return
  }

  let step = 'processing note'

  try {
    plugin.setStatusText('\u2728 Processing your note\u2026')
    const client = createClient(plugin)

    const result: ProcessResponse = await client.process({
      type: 'text',
      transcript,
      preferences: { density: settings.noteDensity, tone: settings.noteTone },
      keys: buildBYOKKeys(plugin),
    })

    // ── Write to vault ───────────────────────────────────────────────────
    step = 'writing note'
    const meta: VaultNoteMetadata = {
      title: result.content.title,
      noteType: result.content.noteType,
      date,
      igggyId: result.igggyId,
      noteId: result.noteId,
      embedAudio: false,
      analysisJson: JSON.stringify(result.analysis),
      noteSource: 'plugin',
    }

    await finalizePlaceholder(app, placeholderFile, result.markdown, meta)

    plugin.setStatusText('')
    new Notice(`Note ready: ${result.content.title}`, 4000)

    // Cloud sync — uses buildSyncPayload which includes all fields
    void syncNoteToCloud(plugin, buildSyncPayload(result, date))
  } catch (err) {
    const message = err instanceof IgggyApiError
      ? err.message
      : err instanceof Error ? err.message : String(err)
    console.error(`[Igggy] Error during "${step}":`, err)
    plugin.setStatusText('')
    await setPlaceholderError(app, placeholderFile, step, friendlyError(message, step))
  }
}
