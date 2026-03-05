import { Menu, Notice, SuggestModal, TFile } from 'obsidian'
import type IggyNotePlugin from './main'
import { preprocessAudio } from './audio/preprocessor'
import { OpenAIWhisperProvider } from './audio/providers/openai'
import { DeepgramProvider } from './audio/providers/deepgram'
import { ClaudeProvider } from './ai/providers/claude'
import { OpenAIGPT4oProvider } from './ai/providers/openai'
import { writeNote } from './notes/writer'

const AUDIO_EXTENSIONS = new Set(['m4a', 'mp3', 'wav', 'webm', 'ogg', 'flac', 'aac', 'mp4'])

// ── Pipeline ──────────────────────────────────────────────────────────────────

async function processAudioFile(plugin: IggyNotePlugin, file: TFile): Promise<void> {
  const { settings, app } = plugin

  // Validate required keys before starting
  if (settings.transcriptionProvider === 'openai' && !settings.openaiKey) {
    new Notice('Iggy Note: OpenAI API key required. Open plugin settings to add it.', 6000)
    return
  }
  if (settings.transcriptionProvider === 'deepgram' && !settings.deepgramKey) {
    new Notice('Iggy Note: Deepgram API key required. Open plugin settings to add it.', 6000)
    return
  }
  if (settings.summarizationProvider === 'anthropic' && !settings.anthropicKey) {
    new Notice('Iggy Note: Anthropic API key required. Open plugin settings to add it.', 6000)
    return
  }
  if (settings.summarizationProvider === 'openai' && !settings.openaiKey) {
    new Notice('Iggy Note: OpenAI API key required. Open plugin settings to add it.', 6000)
    return
  }

  try {
    new Notice(`Iggy Note: Reading "${file.name}"…`)
    const rawBuffer = await app.vault.readBinary(file)

    new Notice('Iggy Note: Pre-processing audio…')
    const processed = await preprocessAudio(rawBuffer, file.name)
    if (processed.wasCompressed) {
      new Notice(`Iggy Note: Compressed ${formatBytes(rawBuffer.byteLength)} → ${formatBytes(processed.buffer.byteLength)}`)
    }

    new Notice('Iggy Note: Transcribing…')
    const transcriptionProvider =
      settings.transcriptionProvider === 'deepgram'
        ? new DeepgramProvider(settings.deepgramKey)
        : new OpenAIWhisperProvider(settings.openaiKey)

    const { transcript, durationSec } = await transcriptionProvider.transcribe(
      processed.buffer,
      processed.filename
    )

    new Notice('Iggy Note: Generating structured note…')
    const summarizationProvider =
      settings.summarizationProvider === 'anthropic'
        ? new ClaudeProvider(settings.anthropicKey)
        : new OpenAIGPT4oProvider(settings.openaiKey)

    const meta = {
      durationSec,
      capturedAt: new Date(file.stat.ctime),
    }
    const noteContent = await summarizationProvider.summarize(transcript, meta)

    const date = new Date().toISOString().slice(0, 10)
    const createdFile = await writeNote(app, noteContent, {
      outputFolder: settings.outputFolder,
      date,
      transcript,
      durationSec,
      audioPath: settings.embedAudio ? file.path : undefined,
      embedAudio: settings.embedAudio,
    })

    new Notice(`Iggy Note: ✓ Created "${createdFile.name}"`, 6000)

    // Open the generated note
    const leaf = app.workspace.getLeaf(false)
    await leaf.openFile(createdFile)
  } catch (err) {
    console.error('[Iggy Note] Pipeline error:', err)
    new Notice(
      `Iggy Note: Error — ${err instanceof Error ? err.message : String(err)}`,
      10000
    )
  }
}

// ── File Picker Modal ─────────────────────────────────────────────────────────

class AudioFileSuggestModal extends SuggestModal<TFile> {
  constructor(
    private plugin: IggyNotePlugin
  ) {
    super(plugin.app)
    this.setPlaceholder('Type to filter audio files…')
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
    el.createEl('small', { text: file.parent?.path ?? '', cls: 'iggy-note-file-path' })
  }

  onChooseSuggestion(file: TFile): void {
    processAudioFile(this.plugin, file)
  }
}

// ── Ribbon / Menu Entry Points ────────────────────────────────────────────────

export function openAudioFilePicker(plugin: IggyNotePlugin): void {
  new AudioFileSuggestModal(plugin).open()
}

export function registerMenus(plugin: IggyNotePlugin): void {
  // File explorer context menu — only shown for audio files
  plugin.registerEvent(
    plugin.app.workspace.on('file-menu', (menu: Menu, file) => {
      if (!(file instanceof TFile)) return
      if (!AUDIO_EXTENSIONS.has(file.extension.toLowerCase())) return
      menu.addItem((item) =>
        item
          .setTitle('Process with Iggy Note')
          .setIcon('mic')
          .onClick(() => processAudioFile(plugin, file))
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
          .setTitle('Process with Iggy Note')
          .setIcon('mic')
          .onClick(() => processAudioFile(plugin, file))
      )
    })
  )
}

// ── Command Registration ──────────────────────────────────────────────────────

export function registerCommands(plugin: IggyNotePlugin): void {
  // Process the currently focused audio file
  plugin.addCommand({
    id: 'process-active-file',
    name: 'Process active audio file',
    checkCallback: (checking: boolean) => {
      const file = plugin.app.workspace.getActiveFile()
      if (!file) return false
      if (!AUDIO_EXTENSIONS.has(file.extension.toLowerCase())) return false
      if (!checking) processAudioFile(plugin, file)
      return true
    },
  })

  // Pick any audio file from the vault via modal
  plugin.addCommand({
    id: 'process-audio-file',
    name: 'Process audio file…',
    callback: () => {
      new AudioFileSuggestModal(plugin).open()
    },
  })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
