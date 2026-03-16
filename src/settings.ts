export interface IgggySettings {
  // Connection mode
  mode: 'open' | 'starter' | 'pro'  // Default: 'open'

  // ── Open — user provides their own API keys ────────────────────────────────

  // Transcription
  transcriptionProvider: 'openai' | 'deepgram'
  openaiKey: string       // used for Whisper and optionally GPT-4o
  deepgramKey: string

  // Summarization
  summarizationProvider: 'openai' | 'anthropic'
  anthropicKey: string

  // ── Starter / Pro — authenticated via Igggy web app ────────────────────────

  accessToken: string   // Supabase access_token (JWT)
  refreshToken: string  // Supabase refresh_token
  tokenExpiry: number   // Unix timestamp in ms when access_token expires

  // ── Recording ────────────────────────────────────────────────────────────────

  includeSystemAudio: boolean  // capture system audio alongside mic (triggers OS screen-picker)

  // ── Note summarization ──────────────────────────────────────────────────────

  noteTone: 'casual' | 'professional'                       // default: 'professional'
  noteDensity: 'concise' | 'standard' | 'detailed'          // default: 'standard'

  // ── Output ──────────────────────────────────────────────────────────────────

  outputFolder: string    // vault folder, e.g. "Igggy"
  embedAudio: boolean     // embed ![[recording.m4a]] link in generated note
  showTasks: boolean      // include ## Tasks section in generated notes

  // ── Folder & Sync ────────────────────────────────────────────────────────────

  cloudBackupEnabled: boolean  // whether to push notes to Igggy cloud DB after each write
  folderSyncEnabled: boolean   // whether push-on-write sync is active (enables cloudBackupEnabled calls)
  lastSyncedAt: number | null  // Unix ms timestamp of last on-demand re-index (for display + rate-limit guard)
  lastPulledAt: string | null  // ISO 8601 timestamp of last successful pull sync (used as ?since= cursor)
  pendingSyncs: Array<{ igggyId: string; payload: Record<string, unknown> }> // queued push payloads after double failure
}

export const DEFAULT_SETTINGS: IgggySettings = {
  mode: 'open',
  transcriptionProvider: 'openai',
  summarizationProvider: 'openai',
  openaiKey: '',
  deepgramKey: '',
  anthropicKey: '',
  accessToken: '',
  refreshToken: '',
  tokenExpiry: 0,
  includeSystemAudio: false,
  noteTone: 'professional',
  noteDensity: 'standard',
  outputFolder: 'Igggy',
  embedAudio: true,
  showTasks: false,
  cloudBackupEnabled: false,
  folderSyncEnabled: false,
  lastSyncedAt: null,
  lastPulledAt: null,
  pendingSyncs: [],
}
