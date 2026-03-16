import type { NoteContent } from '@igggy/core'
import { normalizeNoteType, formatTranscriptParagraphs, parseSpeakerLabel, parseSpeakersJson, getSpeakerNames } from '@igggy/core'

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
  speakersJson?: string  // JSON-stringified SpeakersData — stored for speaker naming + regen
  noteSource?: string    // which platform created this note: 'web', 'plugin', etc.
}


export function generateMarkdown(data: NoteTemplateData): string {
  const { noteContent, date, igggyId, transcript, durationSec, audioPath, embedAudio, showTasks, analysisJson, speakersJson, noteSource } = data
  const { title, summary, content, keyTopics, decisions, actionItems } = noteContent
  // Normalize legacy types (ONE_ON_ONE → MEETING, JOURNAL → MEMO) for frontmatter + tags
  const noteType = normalizeNoteType(noteContent.noteType)

  // --- Frontmatter ---
  // Minimal: only user-facing fields + fields required by Obsidian metadata cache
  // (igggy_id + source are used by context menu guards and reindex.ts)
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

  // --- Igggy metadata callout ---
  // Internal fields (type, duration, audio, analysis) stored in a collapsed callout
  // at the bottom of the note — hidden by default in Obsidian reading view.
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

  // --- Transcript (regular heading — foldable via Obsidian's native heading fold) ---
  // Speaker labels (e.g. "[Speaker 1]: ...") are rendered as **bold** in markdown
  // When speaker names are available, substitute "Speaker N" with real names
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

  // Section order varies by type — highlights-first for all types
  const sections: (string | null)[] = [frontmatter, audioEmbed, summarySection]

  if (noteType === 'MEMO') {
    // Memo: highlights (primary) → decisions → supplementary prose → tasks
    sections.push(keyHighlightsSection, decisionsSection, contentSection, actionItemsSection)
  } else {
    // Meeting / Lecture: highlights → decisions/keyTerms → tasks (no prose)
    sections.push(keyHighlightsSection, decisionsSection, actionItemsSection)
  }

  sections.push(transcriptSection, metadataCallout)

  return (sections.filter(Boolean) as string[]).join('\n\n') + '\n'
}
