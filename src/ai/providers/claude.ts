/**
 * Claude summarization provider.
 *
 * Ported from web app src/lib/claude.ts.
 * Uses direct fetch instead of the Anthropic SDK — keeps the bundle lean
 * and avoids potential Node.js dependency issues in Obsidian/Electron.
 */

import { requestUrl } from 'obsidian'
import { buildPrompt } from '../prompt'
import type { TranscriptMeta } from '../prompt'
import type { SummarizationProvider, NoteContent } from './types'

export class ClaudeProvider implements SummarizationProvider {
  constructor(private apiKey: string) {}

  async summarize(transcript: string, meta?: TranscriptMeta): Promise<NoteContent> {
    const prompt = buildPrompt(meta)

    // Use Obsidian's requestUrl instead of fetch — bypasses CORS restrictions
    // that block direct renderer-process calls to api.anthropic.com
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

function parseNoteContent(text: string): NoteContent {
  // Strip markdown code fences if Claude includes them despite the instruction
  const cleaned = text
    .replace(/^```(?:json)?\n?/, '')
    .replace(/\n?```$/, '')
    .trim()

  const parsed = JSON.parse(cleaned)

  // Claude uses "keyHighlights" in the prompt for clarity; map to "keyTopics"
  if (parsed.keyHighlights && !parsed.keyTopics) {
    parsed.keyTopics = parsed.keyHighlights
    delete parsed.keyHighlights
  }

  // Ensure arrays exist even if Claude omits them
  parsed.keyTopics = parsed.keyTopics ?? []
  parsed.content = parsed.content ?? []
  parsed.decisions = parsed.decisions ?? []
  parsed.actionItems = parsed.actionItems ?? []

  return parsed as NoteContent
}
