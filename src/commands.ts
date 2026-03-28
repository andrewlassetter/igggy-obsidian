import { Menu, Notice, TFile } from 'obsidian'
import { TRANSCRIPT_EDITING, SPEAKER_NAMING } from './feature-flags'
import type IgggyPlugin from './main'
import { parseSpeakersJson } from '@igggy/types'
import { AUDIO_EXTENSIONS, validateKeys, validateSummarizationKeys } from './auth'
import {
  extractMetadataBlock,
  extractSpeakersJson,
  extractTranscript,
} from './notes/parser'
import { SpeakerModal } from './ui/speaker-modal'
import { EditTranscriptModal } from './ui/edit-transcript-modal'
import { PasteTranscriptModal } from './ui/paste-transcript-modal'
import { processAudioFile, AudioFileSuggestModal } from './pipelines/audio'
import { processPastedTranscript } from './pipelines/text'
import { openRegenerateModal } from './pipelines/regenerate'

// ── Re-exports for consuming modules ──────────────────────────────────────────

export {
  validateKeys,
  createClient,
  getAuthToken,
  APP_URL,
} from './auth'

export { runProcessingPipeline } from './pipelines/audio'
export { openAudioFilePicker, openSystemAudioFilePicker } from './pipelines/helpers'

// ── Ribbon / Menu Entry Points ────────────────────────────────────────────────

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
