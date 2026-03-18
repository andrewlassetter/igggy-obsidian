import { normalizeNoteType } from '@igggy/types'

/**
 * Metadata needed to wrap pre-rendered API markdown with Obsidian-specific
 * frontmatter and metadata callout.
 */
export interface VaultNoteMetadata {
  title: string
  noteType: string
  date: string           // YYYY-MM-DD
  igggyId: string        // stable UUID — written as igggy_id in frontmatter
  noteId?: string        // server DB note ID — stored for regen via API
  durationSec?: number
  audioPath?: string     // vault-relative path to audio file
  embedAudio: boolean
  analysisJson?: string  // JSON-stringified TranscriptAnalysis — stored for regen
  speakersJson?: string  // JSON-stringified SpeakersData — stored for speaker naming
  noteSource?: string    // 'web' | 'plugin' | etc.
}

/**
 * Wraps pre-rendered markdown from the API with Obsidian-specific
 * frontmatter, audio embed, and metadata callout.
 *
 * The API returns the note body (summary, highlights, decisions, tasks,
 * transcript) as complete markdown. This function adds the vault-specific
 * wrapper that Obsidian needs.
 */
export function wrapMarkdownForVault(preRenderedMarkdown: string, meta: VaultNoteMetadata): string {
  const noteType = normalizeNoteType(meta.noteType)

  // --- Frontmatter ---
  const frontmatterLines = [
    '---',
    `igggy_id: ${meta.igggyId}`,
    `title: "${meta.title}"`,
    `date: ${meta.date}`,
    'source: igggy',
    `tags: [igggy, ${noteType.toLowerCase()}]`,
    '---',
  ]
  const frontmatter = frontmatterLines.join('\n')

  // --- Metadata callout ---
  const metadataLines = [
    '> [!info]- Igggy metadata',
    `> type: ${noteType}`,
    meta.durationSec != null ? `> duration_sec: ${meta.durationSec}` : null,
    meta.audioPath ? `> audio: "${meta.audioPath}"` : null,
    meta.noteSource ? `> note_source: ${meta.noteSource}` : null,
    meta.noteId ? `> note_id: ${meta.noteId}` : null,
    meta.speakersJson ? `> speakers: '${meta.speakersJson.replace(/'/g, "''")}'` : null,
    meta.analysisJson ? `> analysis: '${meta.analysisJson.replace(/'/g, "''")}'` : null,
  ].filter(Boolean) as string[]
  const metadataCallout = metadataLines.join('\n')

  // --- Audio embed ---
  const audioEmbed = meta.embedAudio && meta.audioPath ? `![[${meta.audioPath}]]` : null

  // --- Assemble ---
  const sections: (string | null)[] = [
    frontmatter,
    audioEmbed,
    preRenderedMarkdown.trim(),
    metadataCallout,
  ]

  return (sections.filter(Boolean) as string[]).join('\n\n') + '\n'
}

/**
 * Legacy: generates full markdown from structured NoteContent.
 * Used only for pull sync (cloud notes arrive as structured data, not pre-rendered markdown).
 * Uses @igggy/types utilities for transcript formatting and speaker labels.
 */
export { generateMarkdownFromContent } from './template-legacy'
