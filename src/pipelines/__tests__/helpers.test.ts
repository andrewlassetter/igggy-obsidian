import { describe, it, expect } from 'vitest'
import { friendlyError } from '../helpers'

// ── 401 step-aware differentiation ──────────────────────────────────────────

describe('friendlyError — 401 auth vs key differentiation', () => {
  it('401 during "uploading audio" → not signed in', () => {
    const result = friendlyError('Request failed (401)', 'uploading audio')
    expect(result).toContain('not signed in')
    expect(result).not.toContain('invalid API key')
  })

  it('401 during "processing note" → invalid API key', () => {
    const result = friendlyError('Request failed (401)', 'processing note')
    expect(result).toContain('invalid API key')
    expect(result).not.toContain('not signed in')
  })

  it('401 during other steps → authentication failed', () => {
    const result = friendlyError('Unauthorized', 'writing note')
    expect(result).toContain('authentication failed')
    expect(result).toContain('signing out and back in')
  })

  it('"Not signed in" message triggers auth path', () => {
    const result = friendlyError('Not signed in — sign in from plugin settings.', 'uploading audio')
    expect(result).toContain('not signed in')
  })

  it('"unauthorized" (lowercase) triggers auth path', () => {
    const result = friendlyError('unauthorized access', 'uploading audio')
    expect(result).toContain('not signed in')
  })

  it('"invalid_api_key" triggers auth path', () => {
    const result = friendlyError('invalid_api_key', 'processing note')
    expect(result).toContain('invalid API key')
  })
})

// ── Other error mappings ────────────────────────────────────────────────────

describe('friendlyError — other error types', () => {
  it('429 → rate limit message', () => {
    const result = friendlyError('Request failed (429)', 'processing note')
    expect(result).toContain('rate limit')
  })

  it('"rate limit" text → rate limit message', () => {
    const result = friendlyError('rate limit exceeded', 'uploading audio')
    expect(result).toContain('rate limit')
  })

  it('"quota" text → rate limit message', () => {
    const result = friendlyError('quota exceeded', 'processing note')
    expect(result).toContain('rate limit')
  })

  it('413 → file too large', () => {
    const result = friendlyError('Request failed (413)', 'uploading audio')
    expect(result).toContain('too large')
  })

  it('network error → network message', () => {
    const result = friendlyError('fetch failed', 'uploading audio')
    expect(result).toContain('network')
  })

  it('ECONNREFUSED → network message', () => {
    const result = friendlyError('ECONNREFUSED', 'processing note')
    expect(result).toContain('network')
  })

  it('network error during "reading file" → iCloud message', () => {
    const result = friendlyError('fetch failed', 'reading file')
    expect(result).toContain('iCloud')
  })

  it('decode error → format not supported', () => {
    const result = friendlyError('could not decode audio', 'pre-processing audio')
    expect(result).toContain('not be supported')
  })

  it('unknown error → passes through unchanged', () => {
    const result = friendlyError('something completely unexpected', 'uploading audio')
    expect(result).toBe('something completely unexpected')
  })
})
