import type { NoteContent } from '../ai/providers/types'

export interface NoteTemplateData {
  noteContent: NoteContent
  date: string           // YYYY-MM-DD
  transcript?: string
  durationSec?: number
  audioPath?: string     // vault-relative path to audio file
  embedAudio: boolean
}

export function generateMarkdown(data: NoteTemplateData): string {
  const { noteContent, date, transcript, durationSec, audioPath, embedAudio } = data
  const { noteType, title, summary, content, keyTopics, decisions, actionItems } = noteContent

  const durationStr = durationSec ? `${Math.round(durationSec / 60)} min` : null

  // --- Frontmatter ---
  const frontmatterLines = [
    '---',
    `title: "${title}"`,
    `date: ${date}`,
    `type: ${noteType}`,
    durationStr ? `duration: ${durationStr}` : null,
    audioPath ? `source: "${audioPath}"` : null,
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

  // --- Key Highlights ---
  const keyHighlightsSection =
    keyTopics.length > 0
      ? `## Key Highlights\n\n${keyTopics
          .map((t) => `### ${t.topic}\n${t.bullets.map((b) => `- ${b}`).join('\n')}`)
          .join('\n\n')}`
      : null

  // --- Decisions ---
  const decisionsSection =
    decisions.length > 0
      ? `## Decisions\n\n${decisions.map((d) => `- ${d}`).join('\n')}`
      : null

  // --- Action Items ---
  const actionItemsSection =
    actionItems.length > 0
      ? `## Action Items\n\n${actionItems
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
