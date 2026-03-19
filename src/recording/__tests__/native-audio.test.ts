import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock child_process ──────────────────────────────────────────────────────

const mockProcess = {
  stdout: { on: vi.fn() },
  stderr: { on: vi.fn() },
  once: vi.fn(),
  on: vi.fn(),
  kill: vi.fn(),
  exitCode: null as number | null,
  removeListener: vi.fn(),
}

vi.mock('child_process', () => ({
  spawn: vi.fn(() => mockProcess),
}))

vi.mock('os', () => ({
  release: vi.fn(() => '23.4.0'),
}))

import { NativeAudioCapture } from '../native-audio'

describe('NativeAudioCapture', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockProcess.exitCode = null
  })

  describe('isSupported', () => {
    it('returns supported: true on macOS 14.4 (Darwin 23.4)', () => {
      const result = NativeAudioCapture.isSupported('23.4.0')
      expect(result.supported).toBe(true)
      expect(result.reason).toBeUndefined()
    })

    it('returns supported: false on macOS 13.5 (Darwin 22.6)', () => {
      const result = NativeAudioCapture.isSupported('22.6.0')
      expect(result.supported).toBe(false)
      expect(result.reason).toContain('macOS 14.2 or later')
    })

    it('returns supported: false on macOS 14.0 (Darwin 23.0)', () => {
      const result = NativeAudioCapture.isSupported('23.0.0')
      expect(result.supported).toBe(false)
    })

    it('returns supported: true on macOS 14.2 exactly (Darwin 23.2)', () => {
      const result = NativeAudioCapture.isSupported('23.2.0')
      expect(result.supported).toBe(true)
    })

    it('returns supported: false on macOS 14.1 (Darwin 23.1)', () => {
      const result = NativeAudioCapture.isSupported('23.1.0')
      expect(result.supported).toBe(false)
    })

    it('returns supported: true on macOS 15+ (Darwin 24.x)', () => {
      const result = NativeAudioCapture.isSupported('24.1.0')
      expect(result.supported).toBe(true)
    })
  })

  describe('stop', () => {
    it('kills the process via SIGTERM', () => {
      const capture = new NativeAudioCapture()
      ;(capture as unknown as { process: typeof mockProcess }).process = mockProcess

      capture.stop()

      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM')
    })

    it('is safe to call when no process is running', () => {
      const capture = new NativeAudioCapture()
      expect(() => capture.stop()).not.toThrow()
    })

    it('does not kill process if already exited', () => {
      const capture = new NativeAudioCapture()
      mockProcess.exitCode = 0
      ;(capture as unknown as { process: typeof mockProcess }).process = mockProcess

      capture.stop()

      expect(mockProcess.kill).not.toHaveBeenCalled()
    })
  })

  describe('isAlive', () => {
    it('returns false when no process has been started', () => {
      const capture = new NativeAudioCapture()
      expect(capture.isAlive()).toBe(false)
    })

    it('returns false after stop()', () => {
      const capture = new NativeAudioCapture()
      ;(capture as unknown as { process: typeof mockProcess }).process = mockProcess
      capture.stop()
      expect(capture.isAlive()).toBe(false)
    })
  })

  describe('onProcessCrash', () => {
    it('invokes crash callback when called', () => {
      const capture = new NativeAudioCapture()
      const callback = vi.fn()
      capture.onProcessCrash(callback)

      ;(capture as unknown as { onCrash: (() => void) | null }).onCrash?.()
      expect(callback).toHaveBeenCalledOnce()
    })
  })
})
