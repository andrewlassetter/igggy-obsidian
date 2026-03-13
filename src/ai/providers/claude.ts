/**
 * Claude summarization provider — two-pass adaptive pipeline.
 *
 * Pass 1 (analyze): Haiku — fast, cheap classification
 * Pass 2 (summarize): Sonnet — full adaptive summarization
 *
 * Prompts and validators come from @igggy/core.
 */

import { requestUrl } from 'obsidian'
import { buildAnalysisPrompt, buildPrompt, validateNoteContent, validateAnalysis } from '@igggy/core'
import type { TranscriptMeta, NoteContent, TranscriptAnalysis } from '@igggy/core'
import type { SummarizationProvider, SummarizeOptions } from './types'

/** Strip markdown code fences that Claude sometimes includes despite instructions. */
function stripCodeFences(text: string): string {
  return text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
}

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
        model: 'claude-haiku-4-5',
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

    return validateAnalysis(JSON.parse(stripCodeFences(text)))
  }

  /**
   * Pass 2: Summarize transcript with Sonnet (full quality).
   * When options.analysis is provided, uses adaptive prompt composition.
   */
  async summarize(transcript: string, meta?: TranscriptMeta, options?: SummarizeOptions): Promise<NoteContent> {
    const prompt = buildPrompt(meta, options?.preferences, {
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

    return validateNoteContent(JSON.parse(stripCodeFences(text)))
  }
}
