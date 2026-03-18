/**
 * Legacy markdown generator for structured NoteContent data.
 *
 * Used only by pull sync — cloud notes arrive as structured data (not
 * pre-rendered markdown), so we render them client-side. New notes created
 * through the processing pipeline use wrapMarkdownForVault() instead.
 */
import type { NoteContent } from '@igggy/types'
import { normalizeNoteType, formatTranscriptParagraphs, parseSpeakerLabel, parseSpeakersJson, getSpeakerNames } from '@igggy/types'

export interface LegacyNoteTemplateData {
  noteContent: NoteContent
  date: string
  igggyId: string
  transcript?: string
  durationSec?: number
  audioPath?: string
  embedAudio: boolean
  showTasks: boolean
  analysisJson?: string
  speakersJson?: string
  noteSource?: string
}

export function generateMarkdownFromContent(data: LegacyNoteTemplateData): string {
  const { noteContent, date, igggyId, transcript, durationSec, audioPath, embedAudio, showTasks, analysisJson, speakersJson, noteSource } = data
  const { title, summary, content, keyTopics, decisions, actionItems } = noteContent
  const noteType = normalizeNoteType(noteContent.noteType)

  const frontmatterLines = [
    '---',
    `igggy_id: ${igggyId}`,
    `title: "${title}"`,
    `date: ${date}`,
    'source: igggy',
    `tags: [igggy, ${noteType.toLowerCase()}]`,
    '---',
  ]
  const frontmatter = frontmatterLines.join('\n')

  const metadataLines = [
    '> [!info]- Igggy metadata',
    `> type: ${noteType}`,
    durationSec != null ? `> duration_sec: ${durationSec}` : null,
    audioPath ? `> audio: "${audioPath}"` : null,
    noteSource ? `> note_source: ${noteSource}` : null,
    speakersJson ? `> speakers: '${speakersJson.replace(/'/g, "''")}'` : null,
    analysisJson ? `> analysis: '${analysisJson.replace(/'/g, "''")}'` : null,
  ].filter(Boolean) as string[]
  const metadataCallout = metadataLines.join('\n')

  const audioEmbed = embedAudio && audioPath ? `![[${audioPath}]]` : null
  const summarySection = `## Summary\n\n${summary}`
  const contentSection = content.length > 0 ? content.join('\n\n') : null

  const keyHighlightsHeader = noteType === 'LECTURE' ? '## Main Points' : '## Key Highlights'
  const keyHighlightsSection =
    keyTopics.length > 0
      ? `${keyHighlightsHeader}\n\n${keyTopics
          .map((t) => `### ${t.topic}\n${t.bullets.map((b) => `- ${b}`).join('\n')}`)
          .join('\n\n')}`
      : null

  const decisionsSection =
    decisions.length > 0
      ? noteType === 'LECTURE'
        ? `## Key Terms\n\n${decisions.map((d) => `- ${d}`).join('\n')}`
        : `## Decisions\n\n${decisions.map((d) => `- ${d}`).join('\n')}`
      : null

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

  const speakerNames = speakersJson ? getSpeakerNames(parseSpeakersJson(speakersJson)) : {}
  const hasSpeakerNames = Object.keys(speakerNames).length > 0
  const transcriptSection = transcript
    ? `## Transcript\n\n${formatTranscriptParagraphs(transcript)
        .map((para) => {
          const { speaker, body } = parseSpeakerLabel(para)
          if (!speaker) return para
          const displayName = hasSpeakerNames && speakerNames[speaker] ? speakerNames[speaker] : speaker
          return `**${displayName}:** ${body}`
        })
        .join('\n\n')}`
    : null

  const sections: (string | null)[] = [frontmatter, audioEmbed, summarySection]

  if (noteType === 'MEMO') {
    sections.push(keyHighlightsSection, decisionsSection, contentSection, actionItemsSection)
  } else {
    sections.push(keyHighlightsSection, decisionsSection, actionItemsSection)
  }

  sections.push(transcriptSection, metadataCallout)

  return (sections.filter(Boolean) as string[]).join('\n\n') + '\n'
}
