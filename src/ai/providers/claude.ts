/**
 * Claude summarization provider — two-pass adaptive pipeline.
 *
 * Ported from web app src/lib/claude.ts.
 * Uses direct fetch instead of the Anthropic SDK — keeps the bundle lean
 * and avoids potential Node.js dependency issues in Obsidian/Electron.
 *
 * Pass 1 (analyze): Haiku — fast, cheap classification
 * Pass 2 (summarize): Sonnet — full adaptive summarization
 */

import { requestUrl } from 'obsidian'
import { buildAnalysisPrompt, buildPrompt } from '../prompt'
import type { TranscriptMeta } from './types'
import type {
  SummarizationProvider,
  SummarizeOptions,
  NoteContent,
  TranscriptAnalysis,
} from './types'
import { normalizeNoteType } from './types'

export class ClaudeProvider implements SummarizationProvider {
  constructor(private apiKey: string) {}

  /**
   * Pass 1: Analyze transcript with Haiku (fast, cheap).
   * Returns structured content signals used to compose the adaptive prompt.
   */
  async analyze(transcript: string, meta?: TranscriptMeta): Promise<TranscriptAnalysis> {
    const prompt = buildAnalysisPrompt(meta)

    const response = await requestUrl({
      url: 'https://api.anthropic.com/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 1000,
        messages: [
          {
            role: 'user',
            content: `${prompt}\n\nTranscript:\n---\n${transcript}\n---`,
          },
        ],
      }),
      throw: false,
    })

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Claude API error ${response.status}: ${response.text}`)
    }

    const data = JSON.parse(response.text)
    const text: string = data.content?.[0]?.type === 'text' ? data.content[0].text : ''

    return parseAnalysis(text)
  }

  /**
   * Pass 2: Summarize transcript with Sonnet (full quality).
   * When options.analysis is provided, uses adaptive prompt composition.
   */
  async summarize(transcript: string, meta?: TranscriptMeta, options?: SummarizeOptions): Promise<NoteContent> {
    const prompt = buildPrompt(meta, undefined, {
      analysis: options?.analysis,
      includeTasks: options?.includeTasks,
      customPrompt: options?.customPrompt,
    })

    const response = await requestUrl({
      url: 'https://api.anthropic.com/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 3000,
        messages: [
          {
            role: 'user',
            content: `${prompt}\n\nTranscript:\n---\n${transcript}\n---`,
          },
        ],
      }),
      throw: false,
    })

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Claude API error ${response.status}: ${response.text}`)
    }

    const data = JSON.parse(response.text)
    const text: string = data.content?.[0]?.type === 'text' ? data.content[0].text : ''

    return parseNoteContent(text)
  }
}

// ── JSON parsers ─────────────────────────────────────────────────────────────

function parseAnalysis(text: string): TranscriptAnalysis {
  const cleaned = text
    .replace(/^```(?:json)?\n?/, '')
    .replace(/\n?```$/, '')
    .trim()

  const parsed = JSON.parse(cleaned)

  // Normalize recording type (in case AI returns a legacy value)
  parsed.recordingType = normalizeNoteType(parsed.recordingType ?? 'MEETING')

  // Ensure all content signals exist with boolean defaults
  const signals = parsed.contentSignals ?? {}
  parsed.contentSignals = {
    hasDecisions: Boolean(signals.hasDecisions),
    hasFollowUps: Boolean(signals.hasFollowUps),
    hasKeyTerms: Boolean(signals.hasKeyTerms),
    hasSpeakerDiscussion: Boolean(signals.hasSpeakerDiscussion),
    hasReflectiveProse: Boolean(signals.hasReflectiveProse),
    hasIdeaDevelopment: Boolean(signals.hasIdeaDevelopment),
  }

  parsed.speakerCount = parsed.speakerCount ?? 1
  parsed.voiceInstructions = parsed.voiceInstructions ?? null
  parsed.toneRegister = parsed.toneRegister === 'casual' ? 'casual' : 'formal'
  parsed.primaryFocus = parsed.primaryFocus ?? ''

  return parsed as TranscriptAnalysis
}

function parseNoteContent(text: string): NoteContent {
  // Strip markdown code fences if Claude includes them despite the instruction
  const cleaned = text
    .replace(/^```(?:json)?\n?/, '')
    .replace(/\n?```$/, '')
    .trim()

  const parsed = JSON.parse(cleaned)

  // Normalize note type
  parsed.noteType = normalizeNoteType(parsed.noteType ?? 'MEETING')

  // Ensure arrays exist even if the model omits them
  parsed.keyTopics = parsed.keyTopics ?? []
  parsed.content = parsed.content ?? []
  parsed.decisions = parsed.decisions ?? []
  parsed.actionItems = parsed.actionItems ?? []

  // For LECTURE notes, route keyTerms into the decisions field (lectures never have
  // decisions). Mirrors the same logic in web app validate.ts.
  if (parsed.noteType === 'LECTURE' && Array.isArray(parsed.keyTerms) && parsed.keyTerms.length > 0) {
    parsed.decisions = parsed.keyTerms
  }
  delete parsed.keyTerms

  return parsed as NoteContent
}
