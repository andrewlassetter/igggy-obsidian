import { describe, it, expect } from 'vitest'
import { validateKeys, validateSummarizationKeys } from '../auth'
import type { IgggySettings } from '../settings'

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal plugin mock — validateKeys only reads plugin.settings */
function mockPlugin(overrides: Partial<IgggySettings> = {}) {
  const defaults: IgggySettings = {
    mode: 'open',
    transcriptionProvider: 'deepgram',
    summarizationProvider: 'anthropic',
    openaiKey: '',
    deepgramKey: 'dg_test_key_1234567890abcdef1234567890abcdef',
    anthropicKey: 'sk-ant-test-key-1234567890abcdef1234567890abcdef12345',
    accessToken: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMiLCJlbWFpbCI6InRlc3RAZXhhbXBsZS5jb20iLCJleHAiOjk5OTk5OTk5OTl9.sig',
    refreshToken: 'refresh_token_value',
    tokenExpiry: Date.now() + 3600_000,
    includeSystemAudio: false,
    nativeAudioVersion: '',
    nativeAudioPath: '',
    noteTone: 'professional',
    noteDensity: 'standard',
    outputFolder: 'Igggy',
    embedAudio: true,
    showTasks: false,
    lastSyncedAt: null,
    lastPulledAt: null,
    pendingSyncs: [],
  }
  return { settings: { ...defaults, ...overrides } } as unknown as Parameters<typeof validateKeys>[0]
}

// ── validateKeys ────────────────────────────────────────────────────────────

describe('validateKeys', () => {
  describe('auth check (all modes)', () => {
    it('returns sign-in error when accessToken is empty', () => {
      const result = validateKeys(mockPlugin({ accessToken: '' }))
      expect(result).toContain('Sign in')
    })

    it('returns sign-in error for Starter mode without accessToken', () => {
      const result = validateKeys(mockPlugin({ mode: 'starter', accessToken: '' }))
      expect(result).toContain('Sign in')
    })

    it('returns sign-in error for Pro mode without accessToken', () => {
      const result = validateKeys(mockPlugin({ mode: 'pro', accessToken: '' }))
      expect(result).toContain('Sign in')
    })
  })

  describe('Starter/Pro mode (managed keys)', () => {
    it('passes when accessToken is present', () => {
      const result = validateKeys(mockPlugin({ mode: 'starter' }))
      expect(result).toBeNull()
    })

    it('passes for Pro with accessToken', () => {
      const result = validateKeys(mockPlugin({ mode: 'pro' }))
      expect(result).toBeNull()
    })

    it('does not check provider keys in managed mode', () => {
      const result = validateKeys(mockPlugin({
        mode: 'starter',
        deepgramKey: '',
        anthropicKey: '',
        openaiKey: '',
      }))
      expect(result).toBeNull()
    })
  })

  describe('Open mode (BYOK)', () => {
    it('passes with Deepgram + Anthropic keys', () => {
      const result = validateKeys(mockPlugin())
      expect(result).toBeNull()
    })

    it('fails when Deepgram key missing (transcription = deepgram)', () => {
      const result = validateKeys(mockPlugin({ deepgramKey: '' }))
      expect(result).toContain('Deepgram')
    })

    it('fails when Anthropic key missing (summarization = anthropic)', () => {
      const result = validateKeys(mockPlugin({ anthropicKey: '' }))
      expect(result).toContain('Anthropic')
    })

    it('fails when OpenAI key missing (transcription = openai)', () => {
      const result = validateKeys(mockPlugin({
        transcriptionProvider: 'openai',
        openaiKey: '',
      }))
      expect(result).toContain('OpenAI')
    })

    it('fails when OpenAI key missing (summarization = openai)', () => {
      const result = validateKeys(mockPlugin({
        summarizationProvider: 'openai',
        openaiKey: '',
      }))
      expect(result).toContain('OpenAI')
    })

    it('passes with OpenAI-only setup (both providers = openai)', () => {
      const result = validateKeys(mockPlugin({
        transcriptionProvider: 'openai',
        summarizationProvider: 'openai',
        openaiKey: 'sk-test-key-1234567890abcdef1234567890abcdef12345678',
        deepgramKey: '',
        anthropicKey: '',
      }))
      expect(result).toBeNull()
    })
  })

  describe('mode switching preserves auth', () => {
    it('auth check is independent of mode — same error for all modes', () => {
      const open = validateKeys(mockPlugin({ mode: 'open', accessToken: '' }))
      const starter = validateKeys(mockPlugin({ mode: 'starter', accessToken: '' }))
      const pro = validateKeys(mockPlugin({ mode: 'pro', accessToken: '' }))

      expect(open).toContain('Sign in')
      expect(starter).toContain('Sign in')
      expect(pro).toContain('Sign in')
    })
  })
})

// ── validateSummarizationKeys ───────────────────────────────────────────────

describe('validateSummarizationKeys', () => {
  it('fails for Starter without accessToken', () => {
    const result = validateSummarizationKeys(mockPlugin({
      mode: 'starter',
      accessToken: '',
    }))
    expect(result).toContain('Sign in')
  })

  it('fails for Starter without refreshToken', () => {
    const result = validateSummarizationKeys(mockPlugin({
      mode: 'starter',
      refreshToken: '',
    }))
    expect(result).toContain('Sign in')
  })

  it('passes for Starter with both tokens', () => {
    const result = validateSummarizationKeys(mockPlugin({ mode: 'starter' }))
    expect(result).toBeNull()
  })

  it('fails for Open mode without Anthropic key', () => {
    const result = validateSummarizationKeys(mockPlugin({ anthropicKey: '' }))
    expect(result).toContain('Anthropic')
  })

  it('passes for Open mode with Anthropic key', () => {
    const result = validateSummarizationKeys(mockPlugin())
    expect(result).toBeNull()
  })
})
