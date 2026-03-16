import { Menu, Notice, SuggestModal, TFile, normalizePath, requestUrl } from 'obsidian'
import { TRANSCRIPT_EDITING, SPEAKER_NAMING } from './feature-flags'
import type IgggyPlugin from './main'
import { preprocessAudio } from './audio/preprocessor'
import { OpenAIWhisperProvider } from './audio/providers/openai'
import { DeepgramProvider } from './audio/providers/deepgram'
import { ClaudeProvider } from './ai/providers/claude'
import { OpenAIGPT4oProvider } from './ai/providers/openai'
import { normalizeNoteType, parseSpeakersJson, getSpeakerNames } from '@igggy/core'
import type { TranscriptAnalysis } from '@igggy/core'
import type { SummarizationProvider } from './ai/providers/types'
import {
  createPlaceholder,
  createTextPlaceholder,
  setPlaceholderError,
  finalizePlaceholder,
} from './notes/writer'
import { generateMarkdown, type NoteTemplateData } from './notes/template'
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
} from './notes/parser'
import { RegenerateModal, type RegenOptions } from './ui/regenerate-modal'
import { SpeakerModal } from './ui/speaker-modal'
import { EditTranscriptModal } from './ui/edit-transcript-modal'
import { PasteTranscriptModal } from './ui/paste-transcript-modal'

const AUDIO_EXTENSIONS = new Set(['m4a', 'mp3', 'wav', 'webm', 'ogg', 'flac', 'aac', 'mp4'])
export const APP_URL = 'https://app.igggy.ai'

// ── Cloud sync helper ─────────────────────────────────────────────────────────

/**
 * Non-blocking push of a completed note to the Igggy cloud DB via
 * POST /api/notes/sync. Fires after every successful vault write.
 *
 * Retry behavior: on first failure, waits 5s and retries once.
 * On second failure, queues the payload in pendingSyncs (drained on next pull cycle).
 *
 * Only fires when:
 *   - cloudBackupEnabled + folderSyncEnabled are both true in settings
 *   - A valid access token is available (Starter/Pro tier)
 */
async function syncNoteToCloud(
  plugin: IgggyPlugin,
  igggyId: string,
  noteContent: { title: string; noteType: string; summary: string; keyTopics?: unknown; content?: unknown; decisions?: unknown; actionItems?: Array<{ content: string; owner?: string | null; context?: string }> },
  extras: { transcript?: string; durationSec?: number; date?: string; analysisJson?: string; source?: string }
): Promise<void> {
  const { settings } = plugin

  if (!settings.cloudBackupEnabled || !settings.folderSyncEnabled) return
  if (!settings.accessToken) return

  const token = await getAuthToken(plugin)

  const body: Record<string, unknown> = {
    igggy_id: igggyId,
    title: noteContent.title,
    type: noteContent.noteType,
    date: extras.date ? `${extras.date}T00:00:00Z` : new Date().toISOString(),
    duration_sec: extras.durationSec ?? null,
    source: extras.source ?? 'plugin',
    transcript: extras.transcript ?? '',
    summary: noteContent.summary,
    key_topics: noteContent.keyTopics ?? null,
    content: noteContent.content ?? null,
    decisions: noteContent.decisions ?? null,
    tasks: (noteContent.actionItems ?? []).map((t) => ({
      content: t.content,
      owner: t.owner ?? null,
      context: t.context ?? null,
    })),
    analysis_json: extras.analysisJson ? JSON.parse(extras.analysisJson) : null,
  }

  const attempt = async (): Promise<boolean> => {
    try {
      const res = await requestUrl({
        url: `${APP_URL}/api/notes/sync`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        throw: false,
      })
      return res.status >= 200 && res.status < 300
    } catch {
      return false
    }
  }

  // First attempt (non-blocking)
  const ok = await attempt()
  if (ok) return

  // Retry after 5s
  await new Promise((r) => setTimeout(r, 5000))
  const retryOk = await attempt()
  if (retryOk) return

  // Queue for later drain
  console.warn('[Igggy] Cloud sync failed after retry — queuing for later:', igggyId)
  new Notice('Note saved locally. Cloud sync will retry.', 3000)
  settings.pendingSyncs.push({ igggyId, payload: body })
  await plugin.saveSettings()
}

// ── Key validation ────────────────────────────────────────────────────────────

/**
 * Checks that all API keys required by the current provider selections are present.
 * Returns a user-facing error string if a key is missing, or null if everything is valid.
 * In Starter/Pro mode, keys are not required — validates auth tokens instead.
 */
export function validateKeys(plugin: IgggyPlugin): string | null {
  const { settings } = plugin

  // Starter/Pro mode — no Open keys needed
  if (['starter', 'pro'].includes(settings.mode)) {
    if (!settings.accessToken || !settings.refreshToken) {
      return 'Igggy: Sign in to your Igggy account. Open plugin settings → Connection mode.'
    }
    return null
  }

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
 * Regen doesn't need transcription keys since it reuses the stored transcript.
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

/** Returns a SummarizationProvider based on the current settings. */
function getSummarizationProvider(plugin: IgggyPlugin): SummarizationProvider {
  const { settings } = plugin
  return settings.summarizationProvider === 'anthropic'
    ? new ClaudeProvider(settings.anthropicKey)
    : new OpenAIGPT4oProvider(settings.openaiKey)
}

// ── Auth: token refresh ───────────────────────────────────────────────────────

/**
 * Returns a valid Bearer token for Starter/Pro tiers.
 * If the current access token is near expiry, refreshes it automatically and
 * saves the new tokens to plugin settings.
 */
// Supabase project constants (public values — safe to embed in plugin)
const SUPABASE_URL = 'https://fgxhtrwvpzawbnnlphji.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZneGh0cnd2cHphd2JubmxwaGppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0OTA0NTgsImV4cCI6MjA4ODA2NjQ1OH0.cH2Qp9UQmMeoBBA4EsndybNDBFaZSzsPzY4mJfQqaTI'

export async function getAuthToken(plugin: IgggyPlugin): Promise<string> {
  const { settings } = plugin

  // Refresh if within 60 seconds of expiry
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
        // expires_at from Supabase is in seconds
        if (body.expires_at) plugin.settings.tokenExpiry = body.expires_at * 1000
        await plugin.saveSettings()
        return body.access_token
      }
    } catch (err) {
      console.error('[Igggy] Token refresh failed:', err)
      // Fall through to use existing token and let the server reject it
    }
  }

  return settings.accessToken
}

// ── Managed: API pipeline ─────────────────────────────────────────────────────

interface ManagedNoteResult {
  id: string
  title: string
  createdAt: string
  noteType: string
  aiSummary: string
  keyTopics: string | null
  content: string | null
  decisions: string | null
  audioDurationSec: number | null
  rawTranscript: string
  tasks: Array<{ id: string; content: string; owner: string | null; done: boolean; sourceSegment: string | null }>
}

/**
 * Managed processing pipeline (Starter/Pro): upload audio to Igggy web app →
 * server handles transcription + summarization → fetch note → write to vault.
 */
async function runManagedPipeline(
  plugin: IgggyPlugin,
  placeholderFile: TFile,
  rawBuffer: ArrayBuffer,
  filename: string,
  firstStageLine: string,
  audioPath?: string,
  embedAudio = false
): Promise<void> {
  const { app } = plugin
  let step = 'preparing upload'

  try {
    const token = await getAuthToken(plugin)
    const authHeader = { Authorization: `Bearer ${token}` }

    // ── Step 1: Get presigned upload URL ─────────────────────────────────────
    plugin.setStatusText('☁️ Uploading audio…')
    step = 'getting upload URL'

    const urlRes = await requestUrl({
      url: `${APP_URL}/api/upload-url`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify({ filename }),
    })

    const { signedUrl, path: storagePath } = urlRes.json as { signedUrl: string; path: string }

    // ── Step 2: PUT audio to Supabase Storage (presigned URL) ─────────────────
    step = 'uploading audio'
    const putRes = await requestUrl({
      url: signedUrl,
      method: 'PUT',
      body: rawBuffer,
      headers: { 'Content-Type': 'audio/webm' },
    })

    if (putRes.status >= 300) {
      throw new Error(`Upload to storage failed (${putRes.status})`)
    }

    // ── Step 3: Trigger server-side transcription + summarization ─────────────
    step = 'processing note'
    plugin.setStatusText('✨ Processing your note…')

    const uploadRes = await requestUrl({
      url: `${APP_URL}/api/upload`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify({ storagePath }),
    })

    if (uploadRes.status === 402) {
      throw new Error('Free recordings used up — upgrade your Igggy plan at app.igggy.ai')
    }
    if (uploadRes.status >= 300) {
      const err = (uploadRes.json as { error?: string }).error ?? 'Processing failed'
      throw new Error(err)
    }

    const { noteId } = uploadRes.json as { noteId: string }

    // ── Step 4: Fetch note content ────────────────────────────────────────────
    step = 'fetching note'
    const noteRes = await requestUrl({
      url: `${APP_URL}/api/notes/${noteId}`,
      headers: { ...authHeader },
    })

    const { note } = noteRes.json as { note: ManagedNoteResult }

    // ── Step 5: Convert and write to vault ────────────────────────────────────
    step = 'writing note'
    await finalizePlaceholderFromManaged(plugin, placeholderFile, note, {
      audioPath,
      embedAudio,
      showTasks: plugin.settings.showTasks,
    })

    plugin.setStatusText('')
    new Notice(`Note ready: ${note.title}`, 4000)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[Igggy] Managed pipeline error during "${step}":`, err)
    plugin.setStatusText('')
    await setPlaceholderError(app, placeholderFile, step, message)
  }
}

/**
 * Adapts the web app note format into the plugin's finalizePlaceholder call,
 * then pushes the note to the cloud DB to register the vault igggyId.
 */
async function finalizePlaceholderFromManaged(
  plugin: IgggyPlugin,
  placeholderFile: TFile,
  note: ManagedNoteResult,
  opts: { audioPath?: string; embedAudio?: boolean; showTasks?: boolean }
): Promise<void> {
  const app = plugin.app
  // Parse JSON fields stored as strings in the DB
  const keyTopics = note.keyTopics
    ? JSON.parse(note.keyTopics) as Array<{ topic: string; bullets: string[] }>
    : []
  const content = note.content ? JSON.parse(note.content) as string[] : []
  const decisions = note.decisions ? JSON.parse(note.decisions) as string[] : []

  const noteContent = {
    title: note.title,
    noteType: normalizeNoteType(note.noteType),
    summary: note.aiSummary,
    keyTopics,
    content,
    decisions,
    actionItems: note.tasks.map((t) => ({
      content: t.content,
      owner: t.owner ?? null,
      context: t.sourceSegment ?? '',
    })),
  }

  const date = new Date(note.createdAt).toISOString().slice(0, 10)
  const igggyId = await finalizePlaceholder(app, placeholderFile, noteContent, {
    date,
    transcript: note.rawTranscript,
    durationSec: note.audioDurationSec ?? undefined,
    audioPath: opts.audioPath,
    embedAudio: opts.embedAudio ?? false,
    showTasks: opts.showTasks ?? true,
  })

  // Register the vault igggyId on the DB record (non-blocking)
  void syncNoteToCloud(plugin, igggyId, noteContent, {
    transcript: note.rawTranscript,
    durationSec: note.audioDurationSec ?? undefined,
    date,
    source: 'plugin',
  })
}

// ── Shared processing pipeline ────────────────────────────────────────────────

/**
 * Runs the full processing pipeline: preprocess → transcribe → summarize → finalize.
 * Assumes the placeholder note is already created and open in the editor.
 *
 * @param firstStageLine - Initial ✓ line shown above the current step.
 *   File pipeline:      '\uD83D\uDCC2 Reading audio \u2713'       (📂 Reading audio ✓)
 *   Recording pipeline: '\uD83C\uDF99\uFE0F Recording ready \u2713' (🎙️ Recording ready ✓)
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
    // ── Pre-process ──────────────────────────────────────────────────────────
    plugin.setStatusText('\uD83D\uDD0A Pre-processing audio\u2026')
    const processed = await preprocessAudio(rawBuffer, filename)
    const audioLine = processed.wasCompressed
      ? `\uD83D\uDD0A Compressed: ${formatBytes(rawBuffer.byteLength)} \u2192 ${formatBytes(processed.buffer.byteLength)} \u2713`
      : '\uD83D\uDD0A Audio ready \u2713'

    // ── Transcribe ───────────────────────────────────────────────────────────
    step = 'transcribing'
    plugin.setStatusText('\uD83C\uDF99\uFE0F Transcribing\u2026')
    const transcriptionProvider =
      settings.transcriptionProvider === 'deepgram'
        ? new DeepgramProvider(settings.deepgramKey)
        : new OpenAIWhisperProvider(settings.openaiKey)

    const { transcript, durationSec, speakerCount } = await transcriptionProvider.transcribe(
      processed.buffer,
      processed.filename
    )

    // Build speaker data for Deepgram multi-speaker recordings
    let speakersJson: string | undefined
    if (speakerCount && speakerCount > 1) {
      const speakers = Array.from({ length: speakerCount }, (_, i) => ({ id: i, label: `Speaker ${i + 1}` }))
      speakersJson = JSON.stringify({ count: speakerCount, speakers })
    }

    // ── Analyze (Pass 1) ────────────────────────────────────────────────────
    step = 'analyzing transcript'
    plugin.setStatusText('\uD83D\uDD0D Analyzing transcript\u2026')
    const summarizationProvider = getSummarizationProvider(plugin)

    const analysis = await summarizationProvider.analyze(transcript, { durationSec, capturedAt })
    const analysisJson = JSON.stringify(analysis)

    // ── Summarize (Pass 2) ───────────────────────────────────────────────────
    step = 'generating note'
    plugin.setStatusText('\u2728 Generating note\u2026')

    const noteContent = await summarizationProvider.summarize(transcript, { durationSec, capturedAt }, {
      analysis,
      customPrompt,
      preferences: { density: settings.noteDensity, tone: settings.noteTone },
    })

    // ── Finalize ─────────────────────────────────────────────────────────────
    step = 'writing note'
    const igggyId = await finalizePlaceholder(app, placeholderFile, noteContent, {
      date,
      transcript,
      durationSec,
      audioPath,
      embedAudio,
      showTasks: settings.showTasks,
      analysisJson,
      speakersJson,
    })

    // ── Push to cloud (non-blocking) ──────────────────────────────────────────
    void syncNoteToCloud(plugin, igggyId, noteContent, { transcript, durationSec, date, analysisJson })

    plugin.setStatusText('')
    new Notice(`Note ready: ${noteContent.title}`, 4000)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
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

  if (['starter', 'pro'].includes(settings.mode)) {
    await runManagedPipeline(
      plugin,
      placeholderFile,
      rawBuffer,
      file.name,
      firstStageLine,
      settings.embedAudio ? file.path : undefined,
      settings.embedAudio
    )
  } else {
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
 * Parses an Igggy note file and regenerates it using the AI pipeline.
 * When stored analysis is available, only Pass 2 runs (fast path).
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

  const igggyId = parseIgggyId(fm) ?? crypto.randomUUID()
  const date = parseDate(fm) ?? new Date().toISOString().slice(0, 10)
  const metaBlock = extractMetadataBlock(content)
  const durationSec = parseDuration(fm, metaBlock)
  const audioPath = parseAudioPath(fm, metaBlock)

  let analysis: TranscriptAnalysis | undefined = parseAnalysis(fm, metaBlock)
  if (!analysis) {
    console.warn('[Igggy] Could not parse stored analysis — will run full pipeline')
  }

  const speakersJson = extractSpeakersJson(metaBlock)
  const speakersData = speakersJson ? parseSpeakersJson(speakersJson) : null
  const speakerNames = getSpeakerNames(speakersData)
  const hasSpeakerNames = Object.keys(speakerNames).length > 0

  // ── 2. Extract transcript ───────────────────────────────────────────────────
  const transcript = extractTranscript(content)
  if (!transcript) {
    new Notice('Igggy: This note has no transcript \u2014 cannot regenerate.', 5000)
    return
  }

  // ── 3. Run AI ───────────────────────────────────────────────────────────────
  new Notice('Regenerating note\u2026', 3000)

  try {
    const provider = getSummarizationProvider(plugin)

    let analysisJson: string | undefined
    if (!analysis) {
      // Full path: Pass 1 + Pass 2
      analysis = await provider.analyze(transcript, { durationSec })
    }
    analysisJson = JSON.stringify(analysis)

    const noteContent = await provider.summarize(transcript, { durationSec }, {
      analysis,
      includeTasks: options.includeTasks,
      customPrompt: options.customPrompt || undefined,
      preferences: { density: options.density, tone: plugin.settings.noteTone },
      forcedType: options.forcedType,
      ...(hasSpeakerNames ? { speakerNames } : {}),
    })

    // ── 4. Write result (always creates a new note) ──────────────────────
    const newIgggyId = crypto.randomUUID()
    const templateData: NoteTemplateData = {
      noteContent,
      date,
      igggyId: newIgggyId,
      transcript,
      durationSec,
      audioPath,
      embedAudio: !!audioPath && plugin.settings.embedAudio,
      showTasks: options.includeTasks,
      analysisJson,
      speakersJson,
    }
    const markdown = generateMarkdown(templateData)

    const safeTitle = noteContent.title
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

    // Push new note to cloud (was missing — regen notes never synced before)
    syncNoteToCloud(plugin, newIgggyId, noteContent, {
      transcript,
      durationSec,
      date,
      analysisJson,
      source: 'plugin',
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
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

/**
 * Opens a native system file dialog (Finder on macOS) for selecting audio files.
 * Used by the sidebar recording view. The selected file is copied into the vault
 * output folder so it can be embedded in the note, then processed through the
 * standard audio pipeline.
 */
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

      // Ensure output folder exists
      const folder = settings.outputFolder || ''
      if (folder) {
        const existing = app.vault.getAbstractFileByPath(folder)
        if (!existing) {
          await app.vault.createFolder(folder)
        }
      }

      // Copy audio into vault so the note can embed it
      const safeName = file.name.replace(/[/\\:*?"<>|#^[\]]/g, '_')
      const audioVaultPath = normalizePath(folder ? `${folder}/${safeName}` : safeName)

      // Avoid overwriting — append timestamp if file exists
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
  // File explorer context menu — only shown for audio files
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

  // Editor context menu — only shown when the active file is an audio file
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

  // File explorer context menu — "Regenerate with Igggy" on Igggy note files
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

  // File explorer context menu — "Name speakers" on Igggy notes with speaker data
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

  // File explorer context menu — "Edit transcript" on Igggy notes
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
  // Process the currently focused audio file
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

  // Pick any audio file from the vault via modal
  plugin.addCommand({
    id: 'process-audio-file',
    name: 'Process audio file\u2026',
    callback: () => {
      new AudioFileSuggestModal(plugin).open()
    },
  })

  // Regenerate an existing Igggy note
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

  // Name speakers in an Igggy note
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

  // Edit transcript of an Igggy note
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

  // Paste transcript to generate a note
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

  // Strip bold speaker labels back to raw [Speaker N]: format for editing
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

  let step = 'analyzing transcript'

  try {
    // ── Analyze (Pass 1) ────────────────────────────────────────────────────
    plugin.setStatusText('\uD83D\uDD0D Analyzing transcript\u2026')
    const provider = getSummarizationProvider(plugin)

    const analysis = await provider.analyze(transcript, {})
    const analysisJson = JSON.stringify(analysis)

    // ── Summarize (Pass 2) ───────────────────────────────────────────────────
    step = 'generating note'
    plugin.setStatusText('\u2728 Generating note\u2026')

    const noteContent = await provider.summarize(transcript, {}, {
      analysis,
      preferences: { density: settings.noteDensity, tone: settings.noteTone },
    })

    // ── Finalize ─────────────────────────────────────────────────────────────
    step = 'writing note'
    const igggyId = await finalizePlaceholder(app, placeholderFile, noteContent, {
      date,
      transcript,
      embedAudio: false,
      showTasks: settings.showTasks,
      analysisJson,
    })

    // ── Push to cloud (non-blocking) ──────────────────────────────────────────
    void syncNoteToCloud(plugin, igggyId, noteContent, { transcript, date, analysisJson })

    plugin.setStatusText('')
    new Notice(`Note ready: ${noteContent.title}`, 4000)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[Igggy] Error during "${step}":`, err)
    plugin.setStatusText('')
    await setPlaceholderError(app, placeholderFile, step, friendlyError(message, step))
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

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
