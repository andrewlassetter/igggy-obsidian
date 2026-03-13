import type { NoteContent } from '@igggy/core'
import { normalizeNoteType } from '@igggy/core'

export interface NoteTemplateData {
  noteContent: NoteContent
  date: string           // YYYY-MM-DD
  igggyId: string        // stable UUID — written as igggy_id in frontmatter
  transcript?: string
  durationSec?: number
  audioPath?: string     // vault-relative path to audio file
  embedAudio: boolean
  showTasks: boolean     // feature flag — when false, Tasks section is omitted from output
  analysisJson?: string  // JSON-stringified TranscriptAnalysis from Pass 1 — stored for regen
}

/**
 * Split a wall-of-text transcript into readable paragraphs.
 * If the transcript already has paragraph breaks (\n\n), preserves them.
 * Otherwise, inserts breaks every ~150 words at sentence boundaries.
 */
function formatTranscriptParagraphs(raw: string): string[] {
  const existing = raw.split('\n\n').filter(Boolean)
  if (existing.length > 1) return existing

  // Single block — split at sentence boundaries every ~150 words
  const sentences = raw.split(/(?<=[.!?])\s+/)
  const paragraphs: string[] = []
  let current: string[] = []
  let wordCount = 0

  for (const sentence of sentences) {
    const words = sentence.split(/\s+/).length
    current.push(sentence)
    wordCount += words
    if (wordCount >= 150) {
      paragraphs.push(current.join(' '))
      current = []
      wordCount = 0
    }
  }
  if (current.length > 0) {
    paragraphs.push(current.join(' '))
  }

  return paragraphs.length > 0 ? paragraphs : [raw]
}

export function generateMarkdown(data: NoteTemplateData): string {
  const { noteContent, date, igggyId, transcript, durationSec, audioPath, embedAudio, showTasks, analysisJson } = data
  const { title, summary, content, keyTopics, decisions, actionItems } = noteContent
  // Normalize legacy types (ONE_ON_ONE → MEETING, JOURNAL → MEMO) for frontmatter + tags
  const noteType = normalizeNoteType(noteContent.noteType)

  // --- Frontmatter ---
  // All fields kept for regen compatibility (regen parses duration_sec, audio, igggy_analysis).
  // User hides the Properties pane via Obsidian settings for a clean look.
  const frontmatterLines = [
    '---',
    `igggy_id: ${igggyId}`,
    `title: "${title}"`,
    `date: ${date}`,
    `type: ${noteType}`,
    durationSec != null ? `duration_sec: ${durationSec}` : null,
    audioPath ? `audio: "${audioPath}"` : null,
    'source: igggy',
    `tags: [igggy, ${noteType.toLowerCase()}]`,
    analysisJson ? `igggy_analysis: '${analysisJson.replace(/'/g, "''")}'` : null,
    '---',
  ].filter(Boolean) as string[]
  const frontmatter = frontmatterLines.join('\n')

  // --- Audio embed ---
  const audioEmbed = embedAudio && audioPath ? `![[${audioPath}]]` : null

  // --- Summary ---
  const summarySection = `## Summary\n\n${summary}`

  // --- Content (prose narrative paragraphs) ---
  const contentSection = content.length > 0 ? content.join('\n\n') : null

  // --- Key Highlights / Main Points ---
  const keyHighlightsHeader = noteType === 'LECTURE' ? '## Main Points' : '## Key Highlights'
  const keyHighlightsSection =
    keyTopics.length > 0
      ? `${keyHighlightsHeader}\n\n${keyTopics
          .map((t) => `### ${t.topic}\n${t.bullets.map((b) => `- ${b}`).join('\n')}`)
          .join('\n\n')}`
      : null

  // --- Decisions / Key Terms ---
  // For LECTURE notes, the decisions field stores keyTerms (see providers/claude.ts).
  const decisionsSection =
    decisions.length > 0
      ? noteType === 'LECTURE'
        ? `## Key Terms\n\n${decisions.map((d) => `- ${d}`).join('\n')}`
        : `## Decisions\n\n${decisions.map((d) => `- ${d}`).join('\n')}`
      : null

  // --- Tasks (hidden when showTasks is false) ---
  const actionItemsSection =
    showTasks && actionItems.length > 0
      ? `## Tasks\n\n${actionItems
          .map((a) => {
            let line = `- [ ] ${a.content}`
            if (a.owner) line += ` (Owner: ${a.owner})`
            if (a.context) line += ` — ${a.context}`
            return line
          })
          .join('\n')}`
      : null

  // --- Transcript (collapsible Obsidian callout with paragraph breaks) ---
  const transcriptSection = transcript
    ? `> [!note]- Transcript\n>\n${formatTranscriptParagraphs(transcript).map(p => `> ${p}`).join('\n>\n')}`
    : null

  // Section order varies by type — highlights-first for all types
  const sections: (string | null)[] = [frontmatter, audioEmbed, summarySection]

  if (noteType === 'MEMO') {
    // Memo: highlights (primary) → decisions → supplementary prose → tasks
    sections.push(keyHighlightsSection, decisionsSection, contentSection, actionItemsSection)
  } else {
    // Meeting / Lecture: highlights → decisions/keyTerms → tasks (no prose)
    sections.push(keyHighlightsSection, decisionsSection, actionItemsSection)
  }

  sections.push(transcriptSection)

  return (sections.filter(Boolean) as string[]).join('\n\n') + '\n'
}
