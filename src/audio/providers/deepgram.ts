/**
 * Deepgram Nova-3 transcription provider.
 *
 * Ported from web app src/lib/deepgram.ts.
 * Key difference: accepts ArrayBuffer directly instead of a signed Supabase URL —
 * audio is sent as the request body to the Deepgram REST API.
 *
 * Speaker diarization is enabled: when multiple speakers are detected, each
 * paragraph is prefixed with [Speaker N] so the AI can attribute action items.
 */

import { requestUrl } from 'obsidian'
import type { TranscriptionProvider, TranscriptionResult } from './types'

export class DeepgramProvider implements TranscriptionProvider {
  constructor(private apiKey: string) {}

  async transcribe(audioBuffer: ArrayBuffer, filename: string): Promise<TranscriptionResult> {
    const params = new URLSearchParams({
      model: 'nova-3',
      smart_format: 'true',
      diarize: 'true',
      paragraphs: 'true',
    })

    // Detect MIME type from extension
    const ext = filename.split('.').pop()?.toLowerCase() ?? 'mp3'
    const mimeType = MIME_TYPES[ext] ?? 'audio/mpeg'

    const response = await requestUrl({
      url: `https://api.deepgram.com/v1/listen?${params}`,
      method: 'POST',
      headers: {
        Authorization: `Token ${this.apiKey}`,
        'Content-Type': mimeType,
      },
      body: audioBuffer,
      throw: false,
    })

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Deepgram API error ${response.status}: ${response.text}`)
    }

    const data = JSON.parse(response.text)
    const paragraphs: DeepgramParagraph[] =
      data.results?.channels?.[0]?.alternatives?.[0]?.paragraphs?.paragraphs ?? []
    const durationSec = data.metadata?.duration
      ? Math.round(data.metadata.duration)
      : undefined

    const speakerIds = new Set(
      paragraphs.map((p) => p.speaker).filter((s) => s != null)
    )
    const isMultiSpeaker = speakerIds.size > 1

    const transcript = paragraphs
      .map((p) => {
        const text = p.sentences.map((s) => s.text).join(' ')
        return isMultiSpeaker ? `[Speaker ${(p.speaker ?? 0) + 1}]: ${text}` : text
      })
      .join('\n\n')

    return { transcript, durationSec, speakersDetected: isMultiSpeaker }
  }
}

interface DeepgramParagraph {
  speaker?: number
  sentences: Array<{ text: string }>
}

const MIME_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  wav: 'audio/wav',
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
}
