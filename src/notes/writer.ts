import { App, TFile, normalizePath } from 'obsidian'
import { generateMarkdown, type NoteTemplateData } from './template'
import type { NoteContent } from '../ai/providers/types'

export interface WriteNoteOptions {
  outputFolder: string
  date: string
  transcript?: string
  durationSec?: number
  audioPath?: string
  embedAudio: boolean
}

export async function writeNote(
  app: App,
  noteContent: NoteContent,
  options: WriteNoteOptions
): Promise<TFile> {
  const { outputFolder, date, transcript, durationSec, audioPath, embedAudio } = options

  // Sanitize title for use as filename
  const safeTitle = noteContent.title
    .replace(/[/\\:*?"<>|#^[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)

  const filename = `${date} - ${safeTitle}.md`
  const folderPath = normalizePath(outputFolder)
  const filePath = normalizePath(`${folderPath}/${filename}`)

  // Ensure output folder exists
  const folder = app.vault.getAbstractFileByPath(folderPath)
  if (!folder) {
    await app.vault.createFolder(folderPath)
  }

  const templateData: NoteTemplateData = {
    noteContent,
    date,
    transcript,
    durationSec,
    audioPath,
    embedAudio,
  }
  const markdown = generateMarkdown(templateData)

  // Create or overwrite the file
  const existing = app.vault.getAbstractFileByPath(filePath)
  if (existing instanceof TFile) {
    await app.vault.modify(existing, markdown)
    return existing
  }

  return app.vault.create(filePath, markdown)
}
