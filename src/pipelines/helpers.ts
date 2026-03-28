import { Notice, normalizePath, TFile } from 'obsidian'
import type IgggyPlugin from '../main'
import { AUDIO_EXTENSIONS } from '../auth'

// ── Friendly error messages ──────────────────────────────────────────────────

export function friendlyError(message: string, step: string): string {
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

// ── File picker helpers ──────────────────────────────────────────────────────

export function openAudioFilePicker(plugin: IgggyPlugin): void {
  // Import dynamically to avoid circular dependency — AudioFileSuggestModal
  // is in the audio pipeline module
  void import('./audio').then(({ AudioFileSuggestModal }) => {
    new AudioFileSuggestModal(plugin).open()
  })
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
        const { processAudioFile } = await import('./audio')
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

// Re-export AUDIO_EXTENSIONS for convenience
export { AUDIO_EXTENSIONS }
