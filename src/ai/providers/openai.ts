/**
 * GPT-4o Mini summarization provider.
 *
 * Uses the same prompt as ClaudeProvider (from src/ai/prompt.ts).
 * Key adaptations for GPT-4o:
 *   - Prompt goes in { role: 'system' } instead of a top-level system param
 *   - response_format: { type: 'json_object' } enables JSON mode
 *   - Model: gpt-4o-mini (cheaper, fast)
 */

import { buildPrompt } from '../prompt'
import type { TranscriptMeta } from '../prompt'
import type { SummarizationProvider, NoteContent } from './types'

export class OpenAIGPT4oProvider implements SummarizationProvider {
  constructor(private apiKey: string) {}

  async summarize(transcript: string, meta?: TranscriptMeta): Promise<NoteContent> {
    const prompt = buildPrompt(meta)

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
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
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`OpenAI API error ${response.status}: ${error}`)
    }

    const data = await response.json()
    const text: string = data.choices?.[0]?.message?.content ?? ''

    return parseNoteContent(text)
  }
}

function parseNoteContent(text: string): NoteContent {
  const parsed = JSON.parse(text.trim())

  if (parsed.keyHighlights && !parsed.keyTopics) {
    parsed.keyTopics = parsed.keyHighlights
    delete parsed.keyHighlights
  }

  parsed.keyTopics = parsed.keyTopics ?? []
  parsed.content = parsed.content ?? []
  parsed.decisions = parsed.decisions ?? []
  parsed.actionItems = parsed.actionItems ?? []

  return parsed as NoteContent
}
