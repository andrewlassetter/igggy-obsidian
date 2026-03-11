export interface IgggySettings {
  // Connection mode
  mode: 'byok' | 'hosted'  // Default: 'byok'

  // ── BYOK — user provides their own API keys ─────────────────────────────────

  // Transcription
  transcriptionProvider: 'openai' | 'deepgram'
  openaiKey: string       // used for Whisper and optionally GPT-4o
  deepgramKey: string

  // Summarization
  summarizationProvider: 'openai' | 'anthropic'
  anthropicKey: string

  // ── Hosted — authenticated via Igggy web app ────────────────────────────────

  hostedAccessToken: string   // Supabase access_token (JWT)
  hostedRefreshToken: string  // Supabase refresh_token
  hostedTokenExpiry: number   // Unix timestamp in ms when access_token expires

  // ── Recording ────────────────────────────────────────────────────────────────

  includeSystemAudio: boolean  // capture system audio alongside mic (triggers OS screen-picker)

  // ── Output ──────────────────────────────────────────────────────────────────

  outputFolder: string    // vault folder, e.g. "Igggy"
  embedAudio: boolean     // embed ![[recording.m4a]] link in generated note
  showTasks: boolean      // include ## Tasks section in generated notes
}

export const DEFAULT_SETTINGS: IgggySettings = {
  mode: 'byok',
  transcriptionProvider: 'openai',
  summarizationProvider: 'openai',
  openaiKey: '',
  deepgramKey: '',
  anthropicKey: '',
  hostedAccessToken: '',
  hostedRefreshToken: '',
  hostedTokenExpiry: 0,
  includeSystemAudio: false,
  outputFolder: 'Igggy',
  embedAudio: true,
  showTasks: true,
}
