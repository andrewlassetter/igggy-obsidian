import { requestUrl } from 'obsidian'
import type IgggyPlugin from './main'
import { IgggyClient } from './api/igggy-client'
import type { BYOKKeys } from '@igggy/types'

export const AUDIO_EXTENSIONS = new Set(['m4a', 'mp3', 'wav', 'webm', 'ogg', 'flac', 'aac', 'mp4'])
export const APP_URL = 'https://app.igggy.ai'

// ── Supabase auth constants (public — safe to embed) ──────────────────────────

const SUPABASE_URL = 'https://fgxhtrwvpzawbnnlphji.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZneGh0cnd2cHphd2JubmxwaGppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0OTA0NTgsImV4cCI6MjA4ODA2NjQ1OH0.cH2Qp9UQmMeoBBA4EsndybNDBFaZSzsPzY4mJfQqaTI'

// ── API Client factory ────────────────────────────────────────────────────────

export function createClient(plugin: IgggyPlugin): IgggyClient {
  return new IgggyClient(APP_URL, () => getAuthToken(plugin))
}

// ── Key validation ────────────────────────────────────────────────────────────

/**
 * Checks that all API keys required by the current provider selections are present.
 * In Open mode, keys are sent to the server BYOK-over-API (never used locally).
 * In Starter/Pro mode, validates auth tokens instead.
 */
export function validateKeys(plugin: IgggyPlugin): string | null {
  const { settings } = plugin

  if (['starter', 'pro'].includes(settings.mode)) {
    if (!settings.accessToken || !settings.refreshToken) {
      return 'Igggy: Sign in to your Igggy account. Open plugin settings \u2192 Connection mode.'
    }
    return null
  }

  // Open mode — keys are required (sent to server per-request)
  if (settings.transcriptionProvider === 'openai' && !settings.openaiKey) {
    return 'Igggy: OpenAI API key required. Open plugin settings to add it.'
  }
  if (settings.transcriptionProvider === 'deepgram' && !settings.deepgramKey) {
    return 'Igggy: Deepgram API key required. Open plugin settings to add it.'
  }
  if (settings.summarizationProvider === 'anthropic' && !settings.anthropicKey) {
    return 'Igggy: Anthropic API key required. Open plugin settings to add it.'
  }
  if (settings.summarizationProvider === 'openai' && !settings.openaiKey) {
    return 'Igggy: OpenAI API key required. Open plugin settings to add it.'
  }
  return null
}

/**
 * Narrower validation for regeneration — only checks summarization provider key.
 */
export function validateSummarizationKeys(plugin: IgggyPlugin): string | null {
  const { settings } = plugin

  if (['starter', 'pro'].includes(settings.mode)) {
    if (!settings.accessToken || !settings.refreshToken) {
      return 'Igggy: Sign in to your Igggy account. Open plugin settings \u2192 Connection mode.'
    }
    return null
  }

  if (settings.summarizationProvider === 'anthropic' && !settings.anthropicKey) {
    return 'Igggy: Anthropic API key required. Open plugin settings to add it.'
  }
  if (settings.summarizationProvider === 'openai' && !settings.openaiKey) {
    return 'Igggy: OpenAI API key required. Open plugin settings to add it.'
  }
  return null
}

/** Build BYOK keys object from settings (Open mode only). */
export function buildBYOKKeys(plugin: IgggyPlugin): BYOKKeys | undefined {
  const { settings } = plugin
  if (['starter', 'pro'].includes(settings.mode)) return undefined

  return {
    transcriptionProvider: settings.transcriptionProvider,
    transcriptionKey: settings.transcriptionProvider === 'deepgram'
      ? settings.deepgramKey
      : settings.openaiKey,
    aiProvider: settings.summarizationProvider,
    aiKey: settings.summarizationProvider === 'anthropic'
      ? settings.anthropicKey
      : settings.openaiKey,
  }
}

// ── Auth: token refresh ───────────────────────────────────────────────────────

export async function getAuthToken(plugin: IgggyPlugin): Promise<string> {
  const { settings } = plugin

  const nearExpiry = Date.now() > settings.tokenExpiry - 60_000

  if (nearExpiry && settings.refreshToken) {
    try {
      const res = await requestUrl({
        url: `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ refresh_token: settings.refreshToken }),
      })

      const body = res.json as { access_token?: string; refresh_token?: string; expires_at?: number }

      if (typeof body.access_token === 'string' && body.access_token) {
        plugin.settings.accessToken = body.access_token
        if (body.refresh_token) plugin.settings.refreshToken = body.refresh_token
        if (body.expires_at) plugin.settings.tokenExpiry = body.expires_at * 1000
        await plugin.saveSettings()
        return body.access_token
      }
    } catch (err) {
      console.error('[Igggy] Token refresh failed:', err)
    }
  }

  return settings.accessToken
}
