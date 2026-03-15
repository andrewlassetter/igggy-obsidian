export interface TranscriptionResult {
  transcript: string
  durationSec?: number
  speakersDetected: boolean  // true if diarization found multiple speakers
  speakerCount?: number      // number of unique speakers detected (Deepgram only)
}

export interface TranscriptionProvider {
  transcribe(audioBuffer: ArrayBuffer, filename: string): Promise<TranscriptionResult>
}
