/**
 * GPT-4o Mini summarization provider — two-pass adaptive pipeline.
 *
 * Uses the same prompts as ClaudeProvider (from src/ai/prompt.ts).
 * Key adaptations for GPT-4o:
 *   - Prompt goes in { role: 'system' } instead of a top-level system param
 *   - response_format: { type: 'json_object' } enables JSON mode
 *   - Model: gpt-4o-mini for both analysis and summarization (cheaper, fast)
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

export class OpenAIGPT4oProvider implements SummarizationProvider {
  constructor(private apiKey: string) {}

  /**
   * Pass 1: Analyze transcript with GPT-4o Mini (fast, cheap).
   * Returns structured content signals used to compose the adaptive prompt.
   */
  async analyze(transcript: string, meta?: TranscriptMeta): Promise<TranscriptAnalysis> {
    const prompt = buildAnalysisPrompt(meta)

    const response = await requestUrl({
      url: 'https://api.openai.com/v1/chat/completions',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 1000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: `Transcript:\n---\n${transcript}\n---` },
        ],
      }),
      throw: false,
    })

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`OpenAI API error ${response.status}: ${response.text}`)
    }

    const data = JSON.parse(response.text)
    const text: string = data.choices?.[0]?.message?.content ?? ''

    return parseAnalysis(text)
  }

  /**
   * Pass 2: Summarize transcript with GPT-4o Mini.
   * When options.analysis is provided, uses adaptive prompt composition.
   */
  async summarize(transcript: string, meta?: TranscriptMeta, options?: SummarizeOptions): Promise<NoteContent> {
    const prompt = buildPrompt(meta, options?.preferences, {
      analysis: options?.analysis,
      includeTasks: options?.includeTasks,
      customPrompt: options?.customPrompt,
    })

    const response = await requestUrl({
      url: 'https://api.openai.com/v1/chat/completions',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 3000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: `Transcript:\n---\n${transcript}\n---` },
        ],
      }),
      throw: false,
    })

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`OpenAI API error ${response.status}: ${response.text}`)
    }

    const data = JSON.parse(response.text)
    const text: string = data.choices?.[0]?.message?.content ?? ''

    return parseNoteContent(text)
  }
}

// ── JSON parsers ─────────────────────────────────────────────────────────────

function parseAnalysis(text: string): TranscriptAnalysis {
  const parsed = JSON.parse(text.trim())

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
  const parsed = JSON.parse(text.trim())

  // Normalize note type
  parsed.noteType = normalizeNoteType(parsed.noteType ?? 'MEETING')

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
