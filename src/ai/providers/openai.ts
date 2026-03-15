/**
 * GPT-4o Mini summarization provider — two-pass adaptive pipeline.
 *
 * Key adaptations for GPT-4o:
 *   - Prompt goes in { role: 'system' } instead of a top-level system param
 *   - response_format: { type: 'json_object' } enables JSON mode
 *   - Model: gpt-4o-mini for both analysis and summarization (cheaper, fast)
 *
 * Prompts and validators come from @igggy/core.
 */

import { requestUrl } from 'obsidian'
import { buildAnalysisPrompt, buildPrompt, validateNoteContent, validateAnalysis } from '@igggy/core'
import type { TranscriptMeta, NoteContent, TranscriptAnalysis } from '@igggy/core'
import type { SummarizationProvider, SummarizeOptions } from './types'

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

    return validateAnalysis(JSON.parse(text.trim()))
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
      forcedType: options?.forcedType,
      speakerNames: options?.speakerNames,
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

    return validateNoteContent(JSON.parse(text.trim()))
  }
}
