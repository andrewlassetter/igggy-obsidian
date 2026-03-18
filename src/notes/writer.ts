import { App, TFile, normalizePath } from 'obsidian'
import { wrapMarkdownForVault, type VaultNoteMetadata } from './template'
import { sanitizeNoteTitle, formatNoteFilename } from '@igggy/types'

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
    '> Igggy is processing this note. It will update automatically when complete.',
    '',
  ].join('\n')

  return app.vault.create(filePath, placeholderMarkdown)
}

/**
 * Creates a placeholder note for pasted text (no audio file).
 */
export async function createTextPlaceholder(
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

  let filePath = normalizePath(`${folderPath}/${date} - Pasted text.md`)
  let counter = 2
  while (app.vault.getAbstractFileByPath(filePath) instanceof TFile) {
    filePath = normalizePath(`${folderPath}/${date} - Pasted text ${counter}.md`)
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
    '> Igggy is processing this note. It will update automatically when complete.',
    '',
  ].join('\n')

  return app.vault.create(filePath, placeholderMarkdown)
}

/**
 * Sets the placeholder note to an error state when the pipeline fails.
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
    '> Igggy is recording. This note will update automatically when complete.',
    '',
  ].join('\n')

  return app.vault.create(filePath, markdown)
}

/**
 * Replaces the placeholder content with pre-rendered markdown from the API,
 * wrapped with Obsidian frontmatter and metadata callout. Renames the file
 * to the AI-generated title.
 */
export async function finalizePlaceholder(
  app: App,
  file: TFile,
  preRenderedMarkdown: string,
  meta: VaultNoteMetadata
): Promise<string> {
  const finalMarkdown = wrapMarkdownForVault(preRenderedMarkdown, meta)

  await app.vault.modify(file, finalMarkdown)

  // Rename to the real AI-generated title
  const folderPath = file.parent?.path ?? ''
  const targetFilename = formatNoteFilename(meta.title, meta.date)
  const targetPath = normalizePath(
    folderPath ? `${folderPath}/${targetFilename}` : targetFilename
  )

  if (file.path !== targetPath && !app.vault.getAbstractFileByPath(targetPath)) {
    await app.vault.rename(file, targetPath)
  }

  return meta.igggyId
}
