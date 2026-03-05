import type { TranscriptMeta } from '../prompt'

export interface NoteContent {
  noteType: 'MEETING' | 'ONE_ON_ONE' | 'MEMO' | 'JOURNAL'
  title: string
  summary: string
  keyTopics: Array<{ topic: string; bullets: string[] }>
  content: string[]
  decisions: string[]
  actionItems: Array<{
    content: string
    owner: string | null
    context: string
  }>
}

export interface SummarizationProvider {
  summarize(transcript: string, meta?: TranscriptMeta): Promise<NoteContent>
}
