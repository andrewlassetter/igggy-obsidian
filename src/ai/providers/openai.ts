/**
 * GPT-4o Mini summarization provider.
 *
 * Uses the same prompt as ClaudeProvider (from src/ai/prompt.ts).
 * Key adaptations for GPT-4o:
 *   - Prompt goes in { role: 'system' } instead of a top-level system param
 *   - response_format: { type: 'json_object' } enables JSON mode
 *   - Model: gpt-4o-mini (cheaper, fast)
 */

import { requestUrl } from 'obsidian'
import { buildPrompt } from '../prompt'
import type { TranscriptMeta } from '../prompt'
import type { SummarizationProvider, NoteContent } from './types'

export class OpenAIGPT4oProvider implements SummarizationProvider {
  constructor(private apiKey: string) {}

  async summarize(transcript: string, meta?: TranscriptMeta): Promise<NoteContent> {
    const prompt = buildPrompt(meta)

    // Use Obsidian's requestUrl for consistency — avoids any future CORS issues
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

function parseNoteContent(text: string): NoteContent {
  const parsed = JSON.parse(text.trim())

  parsed.keyTopics = parsed.keyTopics ?? []
  parsed.content = parsed.content ?? []
  parsed.decisions = parsed.decisions ?? []
  parsed.actionItems = parsed.actionItems ?? []

  return parsed as NoteContent
}
