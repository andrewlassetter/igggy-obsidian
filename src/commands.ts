import { Menu, Notice, SuggestModal, TFile, normalizePath, requestUrl } from 'obsidian'
import { TRANSCRIPT_EDITING, SPEAKER_NAMING } from './feature-flags'
import type IgggyPlugin from './main'
import { preprocessAudio } from './audio/preprocessor'
import { IgggyClient, IgggyApiError } from './api/igggy-client'
import type { BYOKKeys, ProcessResponse, SyncPayload } from '@igggy/types'
import { normalizeNoteType, parseSpeakersJson, getSpeakerNames } from '@igggy/types'
import type { VaultNoteMetadata } from './notes/template'
import {
  createPlaceholder,
  createTextPlaceholder,
  setPlaceholderError,
  finalizePlaceholder,
} from './notes/writer'
import {
  extractMetadataBlock,
  parseAnalysis,
  extractSpeakersJson,
  parseDuration,
  parseAudioPath,
  extractTranscript,
  extractFrontmatter,
  parseIgggyId,
  parseDate,
  parseNoteId,
} from './notes/parser'
import { RegenerateModal, type RegenOptions } from './ui/regenerate-modal'
import { SpeakerModal } from './ui/speaker-modal'
import { EditTranscriptModal } from './ui/edit-transcript-modal'
import { PasteTranscriptModal } from './ui/paste-transcript-modal'

const AUDIO_EXTENSIONS = new Set(['m4a', 'mp3', 'wav', 'webm', 'ogg', 'flac', 'aac', 'mp4'])
export const APP_URL = 'https://app.igggy.ai'

// ── Supabase auth constants (public — safe to embed) ──────────────────────────

const SUPABASE_URL = 'https://fgxhtrwvpzawbnnlphji.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZneGh0cnd2cHphd2JubmxwaGppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0OTA0NTgsImV4cCI6MjA4ODA2NjQ1OH0.cH2Qp9UQmMeoBBA4EsndybNDBFaZSzsPzY4mJfQqaTI'

// ── API Client factory ────────────────────────────────────────────────────────

export function createClient(plugin: IgggyPlugin): IgggyClient {
  return new IgggyClient(APP_URL, () => getAuthToken(plugin))
}

// ── Cloud sync helper ─────────────────────────────────────────────────────────

/**
 * Non-blocking push of a completed note to the Igggy cloud DB.
 * Only fires when a valid access token is available.
 * Available to all authenticated users post-API-first.
 */
async function syncNoteToCloud(
  plugin: IgggyPlugin,
  payload: SyncPayload
): Promise<void> {
  const { settings } = plugin

  if (!settings.accessToken) {
    console.debug('[Igggy] Push sync skipped: no access token')
    return
  }

  const client = createClient(plugin)

  const attempt = async (): Promise<boolean> => {
    try {
      await client.pushSync(payload)
      return true
    } catch {
      return false
    }
  }

  const ok = await attempt()
  if (ok) return

  // Retry after 5s
  await new Promise((r) => setTimeout(r, 5000))
  const retryOk = await attempt()
  if (retryOk) return

  // Queue for later drain
  console.warn('[Igggy] Cloud sync failed after retry — queuing for later:', payload.igggy_id)
  new Notice('Note saved locally. Cloud sync will retry.', 3000)
  settings.pendingSyncs.push({ igggyId: payload.igggy_id, payload: payload as unknown as Record<string, unknown> })
  await plugin.saveSettings()
}

// ── Key validation ────────────────────────────────────────────────────────────

/**
 * Checks that all API keys required by the current provider selections are present.
 * In Open mode, keys are sent to the server BYOK-over-API (never used locally).
 * In Starter/Pro mode, validates auth tokens instead.
 */
export function validateKeys(plugin: IgggyPlugin): string | null {
  const { settings } = plugin

  if (['starter', 'pro'].includes(settings.mode)) {
    if (!settings.accessToken || !settings.refreshToken) {
      return 'Igggy: Sign in to your Igggy account. Open plugin settings → Connection mode.'
    }
    return null
  }

  // Open mode — keys are required (sent to server per-request)
  if (settings.transcriptionProvider === 'openai' && !settings.openaiKey) {
    return 'Igggy: OpenAI API key required. Open plugin settings to add it.'
  }
  if (settings.transcriptionProvider === 'deepgram' && !settings.deepgramKey) {
    return 'Igggy: Deepgram API key required. Open plugin settings to add it.'
  }
  if (settings.summarizationProvider === 'anthropic' && !settings.anthropicKey) {
    return 'Igggy: Anthropic API key required. Open plugin settings to add it.'
  }
  if (settings.summarizationProvider === 'openai' && !settings.openaiKey) {
    return 'Igggy: OpenAI API key required. Open plugin settings to add it.'
  }
  return null
}

/**
 * Narrower validation for regeneration — only checks summarization provider key.
 */
export function validateSummarizationKeys(plugin: IgggyPlugin): string | null {
  const { settings } = plugin

  if (['starter', 'pro'].includes(settings.mode)) {
    if (!settings.accessToken || !settings.refreshToken) {
      return 'Igggy: Sign in to your Igggy account. Open plugin settings → Connection mode.'
    }
    return null
  }

  if (settings.summarizationProvider === 'anthropic' && !settings.anthropicKey) {
    return 'Igggy: Anthropic API key required. Open plugin settings to add it.'
  }
  if (settings.summarizationProvider === 'openai' && !settings.openaiKey) {
    return 'Igggy: OpenAI API key required. Open plugin settings to add it.'
  }
  return null
}

/** Build BYOK keys object from settings (Open mode only). */
function buildBYOKKeys(plugin: IgggyPlugin): BYOKKeys | undefined {
  const { settings } = plugin
  if (['starter', 'pro'].includes(settings.mode)) return undefined

  return {
    transcriptionProvider: settings.transcriptionProvider,
    transcriptionKey: settings.transcriptionProvider === 'deepgram'
      ? settings.deepgramKey
      : settings.openaiKey,
    aiProvider: settings.summarizationProvider,
    aiKey: settings.summarizationProvider === 'anthropic'
      ? settings.anthropicKey
      : settings.openaiKey,
  }
}

// ── Auth: token refresh ───────────────────────────────────────────────────────

export async function getAuthToken(plugin: IgggyPlugin): Promise<string> {
  const { settings } = plugin

  const nearExpiry = Date.now() > settings.tokenExpiry - 60_000

  if (nearExpiry && settings.refreshToken) {
    try {
      const res = await requestUrl({
        url: `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ refresh_token: settings.refreshToken }),
      })

      const body = res.json as { access_token?: string; refresh_token?: string; expires_at?: number }

      if (body.access_token) {
        plugin.settings.accessToken = body.access_token
        if (body.refresh_token) plugin.settings.refreshToken = body.refresh_token
        if (body.expires_at) plugin.settings.tokenExpiry = body.expires_at * 1000
        await plugin.saveSettings()
        return body.access_token
      }
    } catch (err) {
      console.error('[Igggy] Token refresh failed:', err)
    }
  }

  return settings.accessToken
}

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
    void syncNoteToCloud(plugin, {
      igggy_id: result.igggyId,
      title: result.content.title,
      type: normalizeNoteType(result.content.noteType),
      date: `${date}T00:00:00Z`,
      duration_sec: result.durationSec,
      source: 'plugin',
      transcript: result.transcript,
      summary: result.content.summary,
      key_topics: result.content.keyTopics.length > 0 ? result.content.keyTopics : null,
      content: result.content.content.length > 0 ? result.content.content : null,
      decisions: result.content.decisions.length > 0 ? result.content.decisions : null,
      tasks: result.content.actionItems.map((t) => ({
        content: t.content,
        owner: t.owner ?? undefined,
        context: t.context ?? undefined,
      })),
    })
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

async function processAudioFile(plugin: IgggyPlugin, file: TFile): Promise<void> {
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
    new Notice('Failed to create note file — check your output folder setting.', 6000)
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

class AudioFileSuggestModal extends SuggestModal<TFile> {
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

    const markdown = (await import('./notes/template')).wrapMarkdownForVault(result.markdown, meta)

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
    void syncNoteToCloud(plugin, {
      igggy_id: result.igggyId,
      title: result.content.title,
      type: normalizeNoteType(result.content.noteType),
      date: `${date}T00:00:00Z`,
      duration_sec: result.durationSec ?? durationSec,
      source: 'plugin',
      transcript: result.transcript,
      summary: result.content.summary,
      key_topics: result.content.keyTopics.length > 0 ? result.content.keyTopics : null,
      content: result.content.content.length > 0 ? result.content.content : null,
      decisions: result.content.decisions.length > 0 ? result.content.decisions : null,
      tasks: result.content.actionItems.map((t) => ({
        content: t.content,
        owner: t.owner ?? undefined,
        context: t.context ?? undefined,
      })),
    })
  } catch (err) {
    const message = err instanceof IgggyApiError
      ? err.message
      : err instanceof Error ? err.message : String(err)
    console.error('[Igggy] Regeneration error:', err)
    new Notice(`Igggy: Regeneration failed \u2014 ${friendlyError(message, 'generating note')}`, 6000)
  }
}

function openRegenerateModal(plugin: IgggyPlugin, file: TFile): void {
  const keyError = validateSummarizationKeys(plugin)
  if (keyError) {
    new Notice(keyError, 6000)
    return
  }

  new RegenerateModal(plugin.app, plugin, file, (options) => {
    void regenerateNote(plugin, file, options)
  }).open()
}

// ── Ribbon / Menu Entry Points ────────────────────────────────────────────────

export function openAudioFilePicker(plugin: IgggyPlugin): void {
  new AudioFileSuggestModal(plugin).open()
}

export function openSystemAudioFilePicker(plugin: IgggyPlugin): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.m4a,.mp3,.wav,.webm,.ogg,.flac,.aac,.mp4'
  input.style.display = 'none'
  document.body.appendChild(input)

  input.addEventListener('change', async () => {
    const file = input.files?.[0]
    input.remove()
    if (!file) return

    try {
      const buffer = await file.arrayBuffer()
      const { app, settings } = plugin

      const folder = settings.outputFolder || ''
      if (folder) {
        const existing = app.vault.getAbstractFileByPath(folder)
        if (!existing) {
          await app.vault.createFolder(folder)
        }
      }

      const safeName = file.name.replace(/[/\\:*?"<>|#^[\]]/g, '_')
      const audioVaultPath = normalizePath(folder ? `${folder}/${safeName}` : safeName)

      let finalAudioPath = audioVaultPath
      if (app.vault.getAbstractFileByPath(audioVaultPath)) {
        const ext = safeName.lastIndexOf('.')
        const base = ext > 0 ? safeName.slice(0, ext) : safeName
        const suffix = ext > 0 ? safeName.slice(ext) : ''
        finalAudioPath = normalizePath(
          folder ? `${folder}/${base}-${Date.now()}${suffix}` : `${base}-${Date.now()}${suffix}`
        )
      }

      await app.vault.createBinary(finalAudioPath, buffer)
      const vaultFile = app.vault.getAbstractFileByPath(finalAudioPath)
      if (vaultFile instanceof TFile) {
        await processAudioFile(plugin, vaultFile)
      } else {
        new Notice('Igggy: Failed to import audio file into vault.', 5000)
      }
    } catch (err) {
      console.error('[Igggy] System file picker error:', err)
      new Notice('Igggy: Failed to import audio file.', 5000)
    }
  })

  input.click()
}

export function registerMenus(plugin: IgggyPlugin): void {
  plugin.registerEvent(
    plugin.app.workspace.on('file-menu', (menu: Menu, file) => {
      if (!(file instanceof TFile)) return
      if (!AUDIO_EXTENSIONS.has(file.extension.toLowerCase())) return
      menu.addItem((item) =>
        item
          .setTitle('Process with Igggy')
          .setIcon('mic')
          .onClick(() => { void processAudioFile(plugin, file) })
      )
    })
  )

  plugin.registerEvent(
    plugin.app.workspace.on('editor-menu', (menu: Menu, _editor, view) => {
      const file = view.file
      if (!file) return
      if (!AUDIO_EXTENSIONS.has(file.extension.toLowerCase())) return
      menu.addItem((item) =>
        item
          .setTitle('Process with Igggy')
          .setIcon('mic')
          .onClick(() => { void processAudioFile(plugin, file) })
      )
    })
  )

  plugin.registerEvent(
    plugin.app.workspace.on('file-menu', (menu: Menu, file) => {
      if (!(file instanceof TFile) || file.extension !== 'md') return
      const cache = plugin.app.metadataCache.getFileCache(file)
      if (cache?.frontmatter?.source !== 'igggy') return
      menu.addItem((item) =>
        item
          .setTitle('Regenerate with Igggy')
          .setIcon('refresh-cw')
          .onClick(() => { openRegenerateModal(plugin, file) })
      )
    })
  )

  if (SPEAKER_NAMING) {
    plugin.registerEvent(
      plugin.app.workspace.on('file-menu', (menu: Menu, file) => {
        if (!(file instanceof TFile) || file.extension !== 'md') return
        const cache = plugin.app.metadataCache.getFileCache(file)
        if (cache?.frontmatter?.source !== 'igggy') return
        menu.addItem((item) =>
          item
            .setTitle('Name speakers')
            .setIcon('users')
            .onClick(() => { void openSpeakerModal(plugin, file) })
        )
      })
    )
  }

  if (TRANSCRIPT_EDITING) {
    plugin.registerEvent(
      plugin.app.workspace.on('file-menu', (menu: Menu, file) => {
        if (!(file instanceof TFile) || file.extension !== 'md') return
        const cache = plugin.app.metadataCache.getFileCache(file)
        if (cache?.frontmatter?.source !== 'igggy') return
        menu.addItem((item) =>
          item
            .setTitle('Edit transcript')
            .setIcon('pencil')
            .onClick(() => { void openEditTranscriptModal(plugin, file) })
        )
      })
    )
  }
}

// ── Command Registration ──────────────────────────────────────────────────────

export function registerCommands(plugin: IgggyPlugin): void {
  plugin.addCommand({
    id: 'process-active-file',
    name: 'Process active audio file',
    checkCallback: (checking: boolean) => {
      const file = plugin.app.workspace.getActiveFile()
      if (!file) return false
      if (!AUDIO_EXTENSIONS.has(file.extension.toLowerCase())) return false
      if (!checking) void processAudioFile(plugin, file)
      return true
    },
  })

  plugin.addCommand({
    id: 'process-audio-file',
    name: 'Process audio file\u2026',
    callback: () => {
      new AudioFileSuggestModal(plugin).open()
    },
  })

  plugin.addCommand({
    id: 'regenerate-note',
    name: 'Regenerate note',
    checkCallback: (checking: boolean) => {
      const file = plugin.app.workspace.getActiveFile()
      if (!file || file.extension !== 'md') return false
      const cache = plugin.app.metadataCache.getFileCache(file)
      if (cache?.frontmatter?.source !== 'igggy') return false
      if (!checking) openRegenerateModal(plugin, file)
      return true
    },
  })

  if (SPEAKER_NAMING) {
    plugin.addCommand({
      id: 'name-speakers',
      name: 'Name speakers',
      checkCallback: (checking: boolean) => {
        const file = plugin.app.workspace.getActiveFile()
        if (!file || file.extension !== 'md') return false
        const cache = plugin.app.metadataCache.getFileCache(file)
        if (cache?.frontmatter?.source !== 'igggy') return false
        if (!checking) void openSpeakerModal(plugin, file)
        return true
      },
    })
  }

  if (TRANSCRIPT_EDITING) {
    plugin.addCommand({
      id: 'edit-transcript',
      name: 'Edit transcript',
      checkCallback: (checking: boolean) => {
        const file = plugin.app.workspace.getActiveFile()
        if (!file || file.extension !== 'md') return false
        const cache = plugin.app.metadataCache.getFileCache(file)
        if (cache?.frontmatter?.source !== 'igggy') return false
        if (!checking) void openEditTranscriptModal(plugin, file)
        return true
      },
    })
  }

  plugin.addCommand({
    id: 'paste-transcript',
    name: 'Paste transcript\u2026',
    callback: () => {
      const keyError = validateSummarizationKeys(plugin)
      if (keyError) {
        new Notice(keyError, 6000)
        return
      }
      new PasteTranscriptModal(plugin.app, (transcript) => {
        void processPastedTranscript(plugin, transcript)
      }).open()
    },
  })
}

// ── Speaker Naming ───────────────────────────────────────────────────────────

async function openSpeakerModal(plugin: IgggyPlugin, file: TFile): Promise<void> {
  const content = await plugin.app.vault.read(file)
  const metaBlock = extractMetadataBlock(content)
  const speakersJson = extractSpeakersJson(metaBlock)

  if (!speakersJson) {
    new Notice('Igggy: No speaker data found in this note. Speaker detection requires Deepgram transcription.', 5000)
    return
  }

  const speakersData = parseSpeakersJson(speakersJson)
  if (!speakersData) {
    new Notice('Igggy: Could not parse speaker data.', 5000)
    return
  }

  new SpeakerModal(plugin.app, file, speakersData).open()
}

// ── Transcript Editing ───────────────────────────────────────────────────────

async function openEditTranscriptModal(plugin: IgggyPlugin, file: TFile): Promise<void> {
  const content = await plugin.app.vault.read(file)
  const transcript = extractTranscript(content)

  if (!transcript) {
    new Notice('Igggy: No transcript found in this note.', 5000)
    return
  }

  const rawTranscript = transcript.replace(
    /\*\*(.+?):\*\*\s*/g,
    (_, label: string) => `[${label}]: `
  )

  new EditTranscriptModal(plugin.app, file, rawTranscript).open()
}

// ── Paste Transcript Pipeline ────────────────────────────────────────────────

async function processPastedTranscript(plugin: IgggyPlugin, transcript: string): Promise<void> {
  const { app, settings } = plugin
  const date = new Date().toISOString().slice(0, 10)

  let placeholderFile: TFile
  try {
    placeholderFile = await createTextPlaceholder(app, settings.outputFolder)
    await app.workspace.getLeaf(false).openFile(placeholderFile)
  } catch (err) {
    console.error('[Igggy] Failed to create text placeholder:', err)
    new Notice('Failed to create note file — check your output folder setting.', 6000)
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

    // Cloud sync
    void syncNoteToCloud(plugin, {
      igggy_id: result.igggyId,
      title: result.content.title,
      type: normalizeNoteType(result.content.noteType),
      date: `${date}T00:00:00Z`,
      source: 'plugin',
      transcript: result.transcript,
      summary: result.content.summary,
    })
  } catch (err) {
    const message = err instanceof IgggyApiError
      ? err.message
      : err instanceof Error ? err.message : String(err)
    console.error(`[Igggy] Error during "${step}":`, err)
    plugin.setStatusText('')
    await setPlaceholderError(app, placeholderFile, step, friendlyError(message, step))
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function friendlyError(message: string, step: string): string {
  const lower = message.toLowerCase()

  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('invalid_api_key')) {
    return 'invalid API key \u2014 check your key in plugin settings'
  }
  if (lower.includes('429') || lower.includes('rate limit') || lower.includes('quota')) {
    return 'API rate limit or quota exceeded \u2014 try again shortly'
  }
  if (lower.includes('413') || lower.includes('too large') || lower.includes('file size')) {
    return 'audio file is too large for the API \u2014 try a shorter recording'
  }
  if (lower.includes('fetch') || lower.includes('network') || lower.includes('econnrefused') || lower.includes('enotfound')) {
    return step === 'reading file'
      ? 'could not read file \u2014 ensure it is fully synced and not stored only in iCloud'
      : 'network request failed \u2014 check your internet connection'
  }
  if (lower.includes('could not decode') || lower.includes('decodeaudiodata') || lower.includes('dom exception')) {
    return 'could not decode audio \u2014 the file format may not be supported'
  }

  return message
}
