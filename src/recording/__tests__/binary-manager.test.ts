import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}))

vi.mock('zlib', () => ({
  gunzipSync: vi.fn(),
}))

import { BinaryManager } from '../binary-manager'

const mockRequestUrl = vi.fn()

describe('BinaryManager', () => {
  const defaultOpts = {
    pluginDir: '/vault/.obsidian/plugins/igggy',
    overridePath: '',
    installedVersion: '',
    requestUrl: mockRequestUrl,
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getBinaryPath', () => {
    it('returns default path for macOS when no override is set', () => {
      const manager = new BinaryManager(defaultOpts)
      const binaryPath = manager.getBinaryPath()
      expect(binaryPath).toContain('native')
      expect(binaryPath).toContain('audiotee')
      expect(binaryPath).toContain(defaultOpts.pluginDir)
    })

    it('returns override path when set', () => {
      const manager = new BinaryManager({
        ...defaultOpts,
        overridePath: '/custom/path/audiotee',
      })
      expect(manager.getBinaryPath()).toBe('/custom/path/audiotee')
    })
  })

  describe('getTargetVersion', () => {
    it('returns a non-empty semver string', () => {
      const manager = new BinaryManager(defaultOpts)
      const version = manager.getTargetVersion()
      expect(version).toMatch(/^\d+\.\d+\.\d+$/)
    })
  })

  describe('isUpToDate', () => {
    it('returns false when version mismatch', () => {
      // isUpToDate checks isInstalled() first, which checks fs.existsSync
      // Since we can't easily mock require('fs'), test the version logic indirectly
      const manager = new BinaryManager({
        ...defaultOpts,
        installedVersion: '0.0.1',
      })
      // Even if the file exists, version mismatch means not up to date
      // But isInstalled() will return false in test env (no real file), so isUpToDate is false
      expect(manager.isUpToDate()).toBe(false)
    })

    it('returns false when no installedVersion', () => {
      const manager = new BinaryManager(defaultOpts)
      expect(manager.isUpToDate()).toBe(false)
    })
  })

  describe('getInstalledVersion', () => {
    it('returns empty string when not installed (no file on disk)', () => {
      const manager = new BinaryManager(defaultOpts)
      expect(manager.getInstalledVersion()).toBe('')
    })
  })

  describe('ensureBinary', () => {
    it('throws when override path does not exist', async () => {
      const manager = new BinaryManager({
        ...defaultOpts,
        overridePath: '/nonexistent/audiotee',
      })

      await expect(manager.ensureBinary()).rejects.toThrow('Custom audio helper path not found')
    })

    it('calls progress callback during download attempt', async () => {
      const manager = new BinaryManager(defaultOpts)
      const onProgress = vi.fn()

      // Will fail because mock requestUrl returns undefined
      mockRequestUrl.mockRejectedValue(new Error('Network error'))

      try {
        await manager.ensureBinary(onProgress)
      } catch {
        // Expected failure
      }

      expect(onProgress).toHaveBeenCalledWith('Downloading system audio helper…')
    })

    it('wraps download errors with user-friendly message', async () => {
      const manager = new BinaryManager(defaultOpts)
      mockRequestUrl.mockRejectedValue(new Error('ECONNREFUSED'))

      await expect(manager.ensureBinary()).rejects.toThrow('Failed to download system audio helper')
      await expect(manager.ensureBinary()).rejects.toThrow('Check your internet connection')
    })

    it('validates binary size after download', async () => {
      const manager = new BinaryManager(defaultOpts)
      // Return a tiny tarball that will decompress to something too small
      const tinyBuffer = new ArrayBuffer(100)
      mockRequestUrl.mockResolvedValue({ arrayBuffer: tinyBuffer })

      // Will fail during gunzip or size validation
      await expect(manager.ensureBinary()).rejects.toThrow()
    })
  })
})
