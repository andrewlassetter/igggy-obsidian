import type { NoteContent } from '../ai/providers/types'
import { normalizeNoteType } from '../ai/providers/types'

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

export function generateMarkdown(data: NoteTemplateData): string {
  const { noteContent, date, igggyId, transcript, durationSec, audioPath, embedAudio, showTasks, analysisJson } = data
  const { title, summary, content, keyTopics, decisions, actionItems } = noteContent
  // Normalize legacy types (ONE_ON_ONE → MEETING, JOURNAL → MEMO) for frontmatter + tags
  const noteType = normalizeNoteType(noteContent.noteType)

  // --- Frontmatter ---
  const frontmatterLines = [
    '---',
    `igggy_id: ${igggyId}`,
    `title: "${title}"`,
    `date: ${date}`,
    `type: ${noteType}`,
    durationSec != null ? `duration_sec: ${durationSec}` : null,
    audioPath ? `audio: "${audioPath}"` : null,
    analysisJson ? `igggy_analysis: '${analysisJson.replace(/'/g, "''")}'` : null,
    'source: igggy',
    `tags: [igggy, ${noteType.toLowerCase()}]`,
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

  // --- Transcript (collapsible) ---
  const transcriptSection = transcript
    ? `## Transcript\n\n<details>\n<summary>Full transcript</summary>\n\n${transcript}\n\n</details>`
    : null

  const sections = [
    frontmatter,
    audioEmbed,
    summarySection,
    contentSection,
    keyHighlightsSection,
    decisionsSection,
    actionItemsSection,
    transcriptSection,
  ].filter(Boolean) as string[]

  return sections.join('\n\n') + '\n'
}
