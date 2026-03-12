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
  showTasks: boolean
  analysisJson?: string
}

export interface FinalizeOptions {
  date: string
  transcript?: string
  durationSec?: number
  audioPath?: string
  embedAudio: boolean
  showTasks: boolean
  analysisJson?: string
}

export async function writeNote(
  app: App,
  noteContent: NoteContent,
  options: WriteNoteOptions
): Promise<TFile> {
  const { outputFolder, date, transcript, durationSec, audioPath, embedAudio, showTasks, analysisJson } = options

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
    igggyId: crypto.randomUUID(),
    transcript,
    durationSec,
    audioPath,
    embedAudio,
    showTasks,
    analysisJson,
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

// ── Inline Processing Feedback ────────────────────────────────────────────────

/**
 * Creates a placeholder note file immediately when processing begins.
 * Uses the audio file's basename as the initial title — the real AI-generated
 * title is applied later by finalizePlaceholder().
 */
export async function createPlaceholder(
  app: App,
  audioFile: TFile,
  outputFolder: string
): Promise<TFile> {
  const igggyId = crypto.randomUUID()
  const date = new Date().toISOString().slice(0, 10)

  const safeTitle = audioFile.basename
    .replace(/[/\\:*?"<>|#^[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)

  const folderPath = normalizePath(outputFolder)
  const folder = app.vault.getAbstractFileByPath(folderPath)
  if (!folder) {
    await app.vault.createFolder(folderPath)
  }

  // Resolve path with collision handling
  let filePath = normalizePath(`${folderPath}/${date} - ${safeTitle}.md`)
  let counter = 2
  while (app.vault.getAbstractFileByPath(filePath) instanceof TFile) {
    filePath = normalizePath(`${folderPath}/${date} - ${safeTitle} ${counter}.md`)
    counter++
  }

  const placeholderMarkdown = [
    '---',
    `igggy_id: ${igggyId}`,
    'title: "Processing\u2026"',
    `date: ${date}`,
    'source: igggy',
    '---',
    '',
    '## Processing audio\u2026',
    '',
    '> Igggy is working on this note. This will update automatically.',
    '',
    '- \uD83D\uDCC2 Reading audio\u2026',
    '',
  ].join('\n')

  return app.vault.create(filePath, placeholderMarkdown)
}

/**
 * Updates the placeholder note body with the current pipeline stage.
 * Preserves the frontmatter and replaces the body.
 */
export async function updatePlaceholderStage(
  app: App,
  file: TFile,
  stageLines: string[]
): Promise<void> {
  const currentContent = await app.vault.read(file)
  const frontmatterMatch = currentContent.match(/^---\n[\s\S]*?\n---/)
  const frontmatter = frontmatterMatch ? frontmatterMatch[0] : ''

  const body = [
    '',
    '## Processing audio\u2026',
    '',
    '> Igggy is working on this note. This will update automatically.',
    '',
    stageLines.map((line) => `- ${line}`).join('\n'),
    '',
  ].join('\n')

  await app.vault.modify(file, frontmatter + body)
}

/**
 * Sets the placeholder note to an error state when the pipeline fails.
 * The note remains in the vault so the user can see what went wrong.
 */
export async function setPlaceholderError(
  app: App,
  file: TFile,
  stageName: string,
  errorMessage: string
): Promise<void> {
  const currentContent = await app.vault.read(file)
  const frontmatterMatch = currentContent.match(/^---\n[\s\S]*?\n---/)
  const frontmatter = frontmatterMatch ? frontmatterMatch[0] : ''

  const body = [
    '',
    '## Error',
    '',
    `Igggy encountered an error during ${stageName}.`,
    '',
    `**What happened**: ${errorMessage}`,
    '',
    '**What to try**:',
    '- Check that your API keys are correct in Igggy settings',
    '- Confirm the audio file is a supported format',
    '- Try processing the file again',
    '',
    '_The audio file has not been modified._',
    '',
  ].join('\n')

  await app.vault.modify(file, frontmatter + body)
}

// ── Recording Placeholder ─────────────────────────────────────────────────────

/**
 * Creates a recording placeholder note with an igggy-status code block.
 * The block processor in main.ts renders this as an animated waveform.
 */
export async function createRecordingPlaceholder(
  app: App,
  outputFolder: string
): Promise<TFile> {
  const igggyId = crypto.randomUUID()
  const date = new Date().toISOString().slice(0, 10)

  const folderPath = normalizePath(outputFolder)
  const folder = app.vault.getAbstractFileByPath(folderPath)
  if (!folder) {
    await app.vault.createFolder(folderPath)
  }

  // Collision-safe path
  let filePath = normalizePath(`${folderPath}/${date} - Recording\u2026.md`)
  let counter = 2
  while (app.vault.getAbstractFileByPath(filePath) instanceof TFile) {
    filePath = normalizePath(`${folderPath}/${date} - Recording\u2026 ${counter}.md`)
    counter++
  }

  const markdown = [
    '---',
    `igggy_id: ${igggyId}`,
    'title: "Recording\u2026"',
    `date: ${date}`,
    'source: igggy',
    '---',
    '',
    '```igggy-status',
    'recording',
    '```',
    '',
  ].join('\n')

  return app.vault.create(filePath, markdown)
}

/**
 * Replaces the state string inside the igggy-status code block.
 * Obsidian re-renders the block after the file is modified, triggering
 * the code block processor with the new state.
 */
export async function setRecordingState(
  app: App,
  file: TFile,
  state: 'recording' | 'paused' | 'processing'
): Promise<void> {
  const content = await app.vault.read(file)
  const updated = content.replace(
    /```igggy-status\n\w+\n```/,
    `\`\`\`igggy-status\n${state}\n\`\`\``
  )
  await app.vault.modify(file, updated)
}

/**
 * Transitions from recording placeholder → standard processing placeholder.
 * Removes the igggy-status block and writes the initial processing stage lines.
 * After this, all existing updatePlaceholderStage() calls work unchanged.
 */
export async function transitionToProcessing(app: App, file: TFile): Promise<void> {
  const currentContent = await app.vault.read(file)
  const frontmatterMatch = currentContent.match(/^---\n[\s\S]*?\n---/)
  const frontmatter = frontmatterMatch ? frontmatterMatch[0] : ''

  const body = [
    '',
    '## Processing audio\u2026',
    '',
    '> Igggy is working on this note. This will update automatically.',
    '',
    '- \uD83C\uDF99\uFE0F Recording ready \u2713',
    '- \uD83D\uDCC2 Reading audio\u2026',
    '',
  ].join('\n')

  await app.vault.modify(file, frontmatter + body)
}

/**
 * Replaces the placeholder content with the fully generated note and renames
 * the file to the AI-generated title. After this call, Igggy never modifies
 * this file again — the write-once invariant applies to the completed note.
 */
export async function finalizePlaceholder(
  app: App,
  file: TFile,
  noteContent: NoteContent,
  options: FinalizeOptions
): Promise<void> {
  const { date, transcript, durationSec, audioPath, embedAudio, showTasks, analysisJson } = options

  // Reuse the igggy_id generated during createPlaceholder
  const currentContent = await app.vault.read(file)
  const idMatch = currentContent.match(/^igggy_id: (.+)$/m)
  const igggyId = idMatch?.[1]?.trim() ?? crypto.randomUUID()

  const templateData: NoteTemplateData = {
    noteContent,
    date,
    igggyId,
    transcript,
    durationSec,
    audioPath,
    embedAudio,
    showTasks,
    analysisJson,
  }
  const finalMarkdown = generateMarkdown(templateData)

  await app.vault.modify(file, finalMarkdown)

  // Rename to the real AI-generated title if it differs from the placeholder name
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
}
