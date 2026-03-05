export interface TranscriptionResult {
  transcript: string
  durationSec?: number
  speakersDetected: boolean  // true if diarization found multiple speakers
}

export interface TranscriptionProvider {
  transcribe(audioBuffer: ArrayBuffer, filename: string): Promise<TranscriptionResult>
}
