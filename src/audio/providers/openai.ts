import type { TranscriptionProvider, TranscriptionResult } from './types'

export class OpenAIWhisperProvider implements TranscriptionProvider {
  constructor(private apiKey: string) {}

  async transcribe(audioBuffer: ArrayBuffer, filename: string): Promise<TranscriptionResult> {
    const blob = new Blob([audioBuffer], { type: 'audio/mpeg' })
    const formData = new FormData()
    formData.append('file', blob, filename)
    formData.append('model', 'whisper-1')
    formData.append('response_format', 'verbose_json')

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: formData,
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Whisper API error ${response.status}: ${error}`)
    }

    const data = await response.json()

    return {
      transcript: data.text ?? '',
      durationSec: data.duration ? Math.round(data.duration) : undefined,
      speakersDetected: false,  // Whisper doesn't do diarization
    }
  }
}
