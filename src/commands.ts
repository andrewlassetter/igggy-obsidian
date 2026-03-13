import { Menu, Notice, SuggestModal, TFile, normalizePath, requestUrl } from 'obsidian'
import type IgggyPlugin from './main'
import { preprocessAudio } from './audio/preprocessor'
import { OpenAIWhisperProvider } from './audio/providers/openai'
import { DeepgramProvider } from './audio/providers/deepgram'
import { ClaudeProvider } from './ai/providers/claude'
import { OpenAIGPT4oProvider } from './ai/providers/openai'
import { normalizeNoteType } from '@igggy/core'
import type { TranscriptAnalysis } from '@igggy/core'
import type { SummarizationProvider } from './ai/providers/types'
import {
  createPlaceholder,
  updatePlaceholderStage,
  setPlaceholderError,
  finalizePlaceholder,
} from './notes/writer'
import { generateMarkdown, type NoteTemplateData } from './notes/template'
import { RegenerateModal, type RegenOptions } from './ui/regenerate-modal'

const AUDIO_EXTENSIONS = new Set(['m4a', 'mp3', 'wav', 'webm', 'ogg', 'flac', 'aac', 'mp4'])
const APP_URL = 'https://app.igggy.ai'

// ── Cloud sync helper ─────────────────────────────────────────────────────────

/**
 * Non-blocking push of a completed note to the Igggy cloud DB via
 * POST /api/notes/sync. Fires after every successful vault write.
 * Failures are logged but never surface to the user — the vault file
 * is always the reliable output; the cloud DB is a backup.
 *
 * Only fires when:
 *   - cloudBackupEnabled + folderSyncEnabled are both true in settings
 *   - A valid hosted access token is available
 */
async function syncNoteToCloud(
  plugin: IgggyPlugin,
  igggyId: string,
  noteContent: { title: string; noteType: string; summary: string; keyTopics?: unknown; content?: unknown; decisions?: unknown; actionItems?: Array<{ content: string; owner?: string | null; context?: string }> },
  extras: { transcript?: string; durationSec?: number; date?: string; analysisJson?: string; source?: string }
): Promise<void> {
  const { settings } = plugin

  if (!settings.cloudBackupEnabled || !settings.folderSyncEnabled) return
  if (!settings.hostedAccessToken) return

  const token = await getHostedToken(plugin)

  const body = {
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

  // Fire-and-forget — don't await, don't throw
  requestUrl({
    url: `${APP_URL}/api/notes/sync`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  }).catch((err) => {
    console.warn('[Igggy] Cloud sync failed (non-blocking):', err)
  })
}

// ── Key validation ────────────────────────────────────────────────────────────

/**
 * Checks that all API keys required by the current provider selections are present.
 * Returns a user-facing error string if a key is missing, or null if everything is valid.
 * In hosted mode, keys are not required — validates auth tokens instead.
 */
export function validateKeys(plugin: IgggyPlugin): string | null {
  const { settings } = plugin

  // Hosted mode — no BYOK keys needed
  if (settings.mode === 'hosted') {
    if (!settings.hostedAccessToken || !settings.hostedRefreshToken) {
      return 'Igggy: Sign in to Igggy Pro. Open plugin settings \u2192 Igggy Pro mode.'
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

  if (settings.mode === 'hosted') {
    if (!settings.hostedAccessToken || !settings.hostedRefreshToken) {
      return 'Igggy: Sign in to Igggy Pro. Open plugin settings \u2192 Igggy Pro mode.'
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

// ── Hosted: token refresh ─────────────────────────────────────────────────────

/**
 * Returns a valid Bearer token for the hosted tier.
 * If the current access token is near expiry, refreshes it automatically and
 * saves the new tokens to plugin settings.
 */
// Supabase project constants (public values — safe to embed in plugin)
const SUPABASE_URL = 'https://fgxhtrwvpzawbnnlphji.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZneGh0cnd2cHphd2JubmxwaGppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0OTA0NTgsImV4cCI6MjA4ODA2NjQ1OH0.cH2Qp9UQmMeoBBA4EsndybNDBFaZSzsPzY4mJfQqaTI'

async function getHostedToken(plugin: IgggyPlugin): Promise<string> {
  const { settings } = plugin

  // Refresh if within 60 seconds of expiry
  const nearExpiry = Date.now() > settings.hostedTokenExpiry - 60_000

  if (nearExpiry && settings.hostedRefreshToken) {
    try {
      const res = await requestUrl({
        url: `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ refresh_token: settings.hostedRefreshToken }),
      })

      const body = res.json as { access_token?: string; refresh_token?: string; expires_at?: number }

      if (body.access_token) {
        plugin.settings.hostedAccessToken = body.access_token
        if (body.refresh_token) plugin.settings.hostedRefreshToken = body.refresh_token
        // expires_at from Supabase is in seconds
        if (body.expires_at) plugin.settings.hostedTokenExpiry = body.expires_at * 1000
        await plugin.saveSettings()
        return body.access_token
      }
    } catch (err) {
      console.error('[Igggy] Token refresh failed:', err)
      // Fall through to use existing token and let the server reject it
    }
  }

  return settings.hostedAccessToken
}

// ── Hosted: API pipeline ──────────────────────────────────────────────────────

interface HostedNoteResult {
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
 * Hosted processing pipeline: upload audio to Igggy web app → server handles
 * transcription + summarization → fetch note → write to vault.
 */
async function runHostedPipeline(
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
    const token = await getHostedToken(plugin)
    const authHeader = { Authorization: `Bearer ${token}` }

    // ── Step 1: Get presigned upload URL ─────────────────────────────────────
    await updatePlaceholderStage(app, placeholderFile, [
      firstStageLine,
      '☁️ Uploading audio…',
    ])
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
    await updatePlaceholderStage(app, placeholderFile, [
      firstStageLine,
      '☁️ Audio uploaded ✓',
      '✨ Processing your note…',
    ])

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

    const { note } = noteRes.json as { note: HostedNoteResult }

    // ── Step 5: Convert and write to vault ────────────────────────────────────
    step = 'writing note'
    await finalizePlaceholderFromHosted(plugin, placeholderFile, note, {
      audioPath,
      embedAudio,
      showTasks: plugin.settings.showTasks,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[Igggy] Hosted pipeline error during "${step}":`, err)
    await setPlaceholderError(app, placeholderFile, step, message)
  }
}

/**
 * Adapts the web app note format into the plugin's finalizePlaceholder call,
 * then pushes the note to the cloud DB to register the vault igggyId.
 */
async function finalizePlaceholderFromHosted(
  plugin: IgggyPlugin,
  placeholderFile: TFile,
  note: HostedNoteResult,
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
    await updatePlaceholderStage(app, placeholderFile, [
      firstStageLine,
      '\uD83D\uDD0A Pre-processing audio\u2026',
    ])
    const processed = await preprocessAudio(rawBuffer, filename)
    const audioLine = processed.wasCompressed
      ? `\uD83D\uDD0A Compressed: ${formatBytes(rawBuffer.byteLength)} \u2192 ${formatBytes(processed.buffer.byteLength)} \u2713`
      : '\uD83D\uDD0A Audio ready \u2713'

    // ── Transcribe ───────────────────────────────────────────────────────────
    step = 'transcribing'
    await updatePlaceholderStage(app, placeholderFile, [
      firstStageLine,
      audioLine,
      '\uD83C\uDF99\uFE0F Transcribing\u2026',
    ])
    const transcriptionProvider =
      settings.transcriptionProvider === 'deepgram'
        ? new DeepgramProvider(settings.deepgramKey)
        : new OpenAIWhisperProvider(settings.openaiKey)

    const { transcript, durationSec } = await transcriptionProvider.transcribe(
      processed.buffer,
      processed.filename
    )

    // ── Analyze (Pass 1) ────────────────────────────────────────────────────
    step = 'analyzing transcript'
    await updatePlaceholderStage(app, placeholderFile, [
      firstStageLine,
      audioLine,
      '\uD83C\uDF99\uFE0F Transcript ready \u2713',
      '\uD83D\uDD0D Analyzing transcript\u2026',
    ])
    const summarizationProvider = getSummarizationProvider(plugin)

    const analysis = await summarizationProvider.analyze(transcript, { durationSec, capturedAt })
    const analysisJson = JSON.stringify(analysis)

    // ── Summarize (Pass 2) ───────────────────────────────────────────────────
    step = 'generating note'
    await updatePlaceholderStage(app, placeholderFile, [
      firstStageLine,
      audioLine,
      '\uD83C\uDF99\uFE0F Transcript ready \u2713',
      '\uD83D\uDD0D Analysis complete \u2713',
      '\u2728 Generating note\u2026',
    ])

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
    })

    // ── Push to cloud (non-blocking) ──────────────────────────────────────────
    void syncNoteToCloud(plugin, igggyId, noteContent, { transcript, durationSec, date, analysisJson })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[Igggy] Error during "${step}":`, err)
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

  if (settings.mode === 'hosted') {
    await runHostedPipeline(
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
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (!frontmatterMatch) {
    new Notice('Igggy: Could not read note frontmatter.', 5000)
    return
  }
  const fm = frontmatterMatch[1]

  // Extract frontmatter fields
  const igggyId = fm.match(/^igggy_id:\s*(.+)$/m)?.[1]?.trim() ?? crypto.randomUUID()
  const date = fm.match(/^date:\s*(.+)$/m)?.[1]?.trim() ?? new Date().toISOString().slice(0, 10)
  const durationStr = fm.match(/^duration_sec:\s*(\d+)$/m)?.[1]
  const durationSec = durationStr ? parseInt(durationStr, 10) : undefined
  const audioPath = fm.match(/^audio:\s*"?(.+?)"?\s*$/m)?.[1]?.trim()

  // Parse stored analysis (single-quoted YAML scalar — unescape '' → ')
  let analysis: TranscriptAnalysis | undefined
  const analysisMatch = fm.match(/^igggy_analysis:\s*'([\s\S]*?)'\s*$/m)
  if (analysisMatch) {
    try {
      const raw = analysisMatch[1].replace(/''/g, "'")
      analysis = JSON.parse(raw) as TranscriptAnalysis
    } catch {
      console.warn('[Igggy] Could not parse stored analysis — will run full pipeline')
    }
  }

  // ── 2. Extract transcript ───────────────────────────────────────────────────
  let transcript: string | undefined

  // Try Obsidian callout pattern first (new plugin-generated notes)
  const calloutMatch = content.match(/> \[!note\]-?\s*Transcript\s*\n((?:>.*\n?)*)/i)
  if (calloutMatch) {
    // Strip leading "> " from each line and rejoin
    transcript = calloutMatch[1]
      .split('\n')
      .map(line => line.replace(/^>\s?/, ''))
      .join('\n')
      .trim()
  }

  // Try <details> pattern (older plugin-generated notes)
  if (!transcript) {
    const detailsMatch = content.match(
      /## Transcript\s*\n+<details>\s*\n*<summary>Full transcript<\/summary>\s*\n+([\s\S]*?)\n*\s*<\/details>/
    )
    if (detailsMatch) {
      transcript = detailsMatch[1].trim()
    }
  }

  if (!transcript) {
    // Fall back to bare transcript (web app synced notes)
    const bareMatch = content.match(/## Transcript\s*\n+([\s\S]*?)(?=\n## |\n---\s*$|$)/)
    if (bareMatch) {
      transcript = bareMatch[1].trim()
    }
  }

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
    })

    // ── 4. Write result ─────────────────────────────────────────────────────
    const templateData: NoteTemplateData = {
      noteContent,
      date,
      igggyId: options.action === 'replace' ? igggyId : crypto.randomUUID(),
      transcript,
      durationSec,
      audioPath,
      embedAudio: !!audioPath && plugin.settings.embedAudio,
      showTasks: options.includeTasks,
      analysisJson,
    }
    const markdown = generateMarkdown(templateData)

    if (options.action === 'replace') {
      await app.vault.modify(file, markdown)

      // Rename if title changed
      const safeTitle = noteContent.title
        .replace(/[/\\:*?"<>|#^[\]]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 100)

      const folderPath = file.parent?.path ?? ''
      const targetFilename = `${date} - ${safeTitle}.md`
      const targetPath = normalizePath(
        folderPath ? `${folderPath}/${targetFilename}` : targetFilename
      )

      if (file.path !== targetPath && !app.vault.getAbstractFileByPath(targetPath)) {
        await app.vault.rename(file, targetPath)
      }

      new Notice('Note regenerated.', 3000)
    } else {
      // Save as new note
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

      new Notice('New note created.', 3000)
    }
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
