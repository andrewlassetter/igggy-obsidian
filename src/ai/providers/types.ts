// Plugin-only provider interfaces.
// All shared types (NoteContent, TranscriptAnalysis, NoteType, etc.) now come from @igggy/core.

import type { TranscriptAnalysis, TranscriptMeta, NoteContent, NotePreferences } from '@igggy/core'

export interface SummarizeOptions {
  analysis?: TranscriptAnalysis
  includeTasks?: boolean       // default true
  customPrompt?: string
  preferences?: NotePreferences // density + tone for regeneration
}

export interface SummarizationProvider {
  analyze(transcript: string, meta?: TranscriptMeta): Promise<TranscriptAnalysis>
  summarize(transcript: string, meta?: TranscriptMeta, options?: SummarizeOptions): Promise<NoteContent>
}
