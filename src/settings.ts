export interface IggyNoteSettings {
  // Transcription
  transcriptionProvider: 'openai' | 'deepgram'
  openaiKey: string       // used for Whisper and optionally GPT-4o

  // Summarization
  summarizationProvider: 'openai' | 'anthropic'
  deepgramKey: string
  anthropicKey: string

  // Output
  outputFolder: string    // vault folder, e.g. "Igggy"
  embedAudio: boolean     // embed ![[recording.m4a]] link in generated note

  // Paid
  licenseKey: string      // Pro BYOK tier — validated against backend (placeholder in v1)
}

export const DEFAULT_SETTINGS: IggyNoteSettings = {
  transcriptionProvider: 'openai',
  summarizationProvider: 'openai',
  openaiKey: '',
  deepgramKey: '',
  anthropicKey: '',
  outputFolder: 'Igggy',
  embedAudio: true,
  licenseKey: '',
}
