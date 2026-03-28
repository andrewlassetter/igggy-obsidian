import { Notice, SuggestModal, TFile } from 'obsidian'
import type IgggyPlugin from '../main'
import type { ProcessResponse } from '@igggy/types'
import type { VaultNoteMetadata } from '../notes/template'
import { preprocessAudio } from '../audio/preprocessor'
import { IgggyApiError } from '../api/igggy-client'
import { createClient, validateKeys, buildBYOKKeys, AUDIO_EXTENSIONS } from '../auth'
import { createPlaceholder, setPlaceholderError, finalizePlaceholder } from '../notes/writer'
import { syncNoteToCloud } from '../sync/push'
import { buildSyncPayload } from '../sync/payload'
import { friendlyError } from './helpers'

// ── Unified Processing Pipeline ───────────────────────────────────────────────

/**
 * Unified processing pipeline: preprocess audio → upload to S3 → call v1/process API
 * → receive pre-rendered markdown → write to vault.
 *
 * Works for both Open mode (BYOK keys) and Managed mode (server keys).
 */
export async function runProcessingPipeline(
  plugin: IgggyPlugin,
  placeholderFile: TFile,
  rawBuffer: ArrayBuffer,
  filename: string,
  date: string,
  capturedAt: Date,
  firstStageLine: string,
  audioPath?: string,
  embedAudio = false,
  customPrompt?: string
): Promise<void> {
  const { app, settings } = plugin
  let step = 'pre-processing audio'

  try {
    const client = createClient(plugin)

    // ── Pre-process ──────────────────────────────────────────────────────────
    plugin.setStatusText('\uD83D\uDD0A Pre-processing audio\u2026')
    const processed = await preprocessAudio(rawBuffer, filename)

    // ── Upload to S3 ─────────────────────────────────────────────────────────
    step = 'uploading audio'
    plugin.setStatusText('\u2601\uFE0F Uploading audio\u2026')

    const { signedUrl, path: storagePath } = await client.getUploadUrl(processed.filename)
    await client.uploadAudio(signedUrl, processed.buffer, 'audio/webm')

    // ── Process via API ──────────────────────────────────────────────────────
    step = 'processing note'
    plugin.setStatusText('\u2728 Processing your note\u2026')

    const result: ProcessResponse = await client.process({
      type: 'audio',
      audioUrl: storagePath,
      customPrompt: customPrompt || undefined,
      preferences: { density: settings.noteDensity, tone: settings.noteTone },
      keys: buildBYOKKeys(plugin),
    })

    // ── Write to vault ───────────────────────────────────────────────────────
    step = 'writing note'
    const meta: VaultNoteMetadata = {
      title: result.content.title,
      noteType: result.content.noteType,
      date,
      igggyId: result.igggyId,
      noteId: result.noteId,
      durationSec: result.durationSec,
      audioPath,
      embedAudio,
      analysisJson: JSON.stringify(result.analysis),
      speakersJson: result.speakersJson,
      noteSource: 'plugin',
    }

    await finalizePlaceholder(app, placeholderFile, result.markdown, meta)

    plugin.setStatusText('')
    new Notice(`Note ready: ${result.content.title}`, 4000)

    // ── Sync to cloud (non-blocking) — server already has the note, but
    // we push the plugin's igggyId so pull sync recognizes it ──────────────
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

// ── File pipeline ─────────────────────────────────────────────────────────────

export async function processAudioFile(plugin: IgggyPlugin, file: TFile): Promise<void> {
  const { settings, app } = plugin

  const keyError = validateKeys(plugin)
  if (keyError) {
    new Notice(keyError, 6000)
    return
  }

  let placeholderFile: TFile
  try {
    placeholderFile = await createPlaceholder(app, file, settings.outputFolder)
    await app.workspace.getLeaf(false).openFile(placeholderFile)
  } catch (err) {
    console.error('[Igggy] Failed to create placeholder note:', err)
    new Notice('Failed to create note file \u2014 check your output folder setting.', 6000)
    return
  }

  let rawBuffer: ArrayBuffer
  try {
    rawBuffer = await app.vault.readBinary(file)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[Igggy] Failed to read audio file:', err)
    await setPlaceholderError(app, placeholderFile, 'reading file', friendlyError(message, 'reading file'))
    return
  }

  const firstStageLine = '\uD83D\uDCC2 Reading audio \u2713'
  const date = new Date().toISOString().slice(0, 10)

  await runProcessingPipeline(
    plugin,
    placeholderFile,
    rawBuffer,
    file.name,
    date,
    new Date(file.stat.ctime),
    firstStageLine,
    settings.embedAudio ? file.path : undefined,
    settings.embedAudio
  )
}

// ── File Picker Modal ─────────────────────────────────────────────────────────

export class AudioFileSuggestModal extends SuggestModal<TFile> {
  constructor(private plugin: IgggyPlugin) {
    super(plugin.app)
    this.setPlaceholder('Type to filter audio files\u2026')
  }

  getSuggestions(query: string): TFile[] {
    return this.plugin.app.vault.getFiles().filter((f) => {
      const ext = f.extension.toLowerCase()
      if (!AUDIO_EXTENSIONS.has(ext)) return false
      if (!query) return true
      return (
        f.name.toLowerCase().includes(query.toLowerCase()) ||
        f.path.toLowerCase().includes(query.toLowerCase())
      )
    })
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    el.createEl('div', { text: file.name })
    el.createEl('small', { text: file.parent?.path ?? '', cls: 'igggy-file-path' })
  }

  onChooseSuggestion(file: TFile): void {
    void processAudioFile(this.plugin, file)
  }
}
