// ── Note Types ───────────────────────────────────────────────────────────────

export type NoteType = 'MEETING' | 'MEMO' | 'LECTURE'

// Legacy type values still present in vault files from before the 5 → 3 consolidation.
// normalizeNoteType() maps these to the canonical 3-bucket types.
export type LegacyNoteType = 'ONE_ON_ONE' | 'JOURNAL'
export type AnyNoteType = NoteType | LegacyNoteType

/** Maps legacy 5-type values to the canonical 3-bucket values. */
export function normalizeNoteType(raw: string): NoteType {
  switch (raw) {
    case 'ONE_ON_ONE': return 'MEETING'
    case 'JOURNAL':    return 'MEMO'
    case 'MEETING':
    case 'MEMO':
    case 'LECTURE':
      return raw
    default:
      return 'MEETING' // safe fallback
  }
}

// ── Note Content ─────────────────────────────────────────────────────────────

export interface NoteContent {
  noteType: NoteType
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

// ── Transcript Metadata ──────────────────────────────────────────────────────
// Metadata signals that improve type auto-detection.
// Passed after transcription — no extra API calls needed.

export interface TranscriptMeta {
  durationSec?: number  // audio length — strong signal (memos <8 min, meetings 20–90 min)
  capturedAt?: Date     // when the recording was made — day/time pattern signals
}

// ── Transcript Analysis (Pass 1 output) ──────────────────────────────────────
// Structured signals extracted from the transcript by a lightweight AI pass.
// Used to compose the adaptive summarization prompt (Pass 2).

export interface TranscriptAnalysis {
  recordingType: NoteType
  speakerCount: number                    // 1 = solo, 2+ = multi-speaker
  contentSignals: {
    hasDecisions: boolean                 // something was decided or resolved
    hasFollowUps: boolean                 // tasks, action items, next steps
    hasKeyTerms: boolean                  // technical terms, concepts, vocabulary
    hasSpeakerDiscussion: boolean         // back-and-forth between speakers
    hasReflectiveProse: boolean           // personal reflection, journaling
    hasIdeaDevelopment: boolean           // working through / developing an idea
  }
  voiceInstructions: string | null        // instructions the user spoke to Igggy, or null
  toneRegister: 'formal' | 'casual'
  primaryFocus: string                    // 1-sentence: what this recording is about
}

// ── Preferences ──────────────────────────────────────────────────────────────

export interface NotePreferences {
  tone: 'casual' | 'professional'               // default: 'professional'
  density: 'concise' | 'standard' | 'detailed'  // default: 'standard'
}

// ── Provider Interfaces ──────────────────────────────────────────────────────

export interface SummarizeOptions {
  analysis?: TranscriptAnalysis
  includeTasks?: boolean       // default true
  customPrompt?: string
}

export interface SummarizationProvider {
  analyze(transcript: string, meta?: TranscriptMeta): Promise<TranscriptAnalysis>
  summarize(transcript: string, meta?: TranscriptMeta, options?: SummarizeOptions): Promise<NoteContent>
}
