/**
 * binary-manager.ts
 *
 * Downloads, stores, and versions the native audio capture binary.
 * On macOS, this is the AudioTee binary from the `audiotee` npm package.
 *
 * Binary source: npm registry tarball (https://registry.npmjs.org/audiotee/-/audiotee-{version}.tgz)
 * Storage: <pluginDir>/native/audiotee (macOS) or audiotee-wasapi.exe (Windows)
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { execFileSync } = require('child_process') as typeof import('child_process')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const crypto = require('crypto') as typeof import('crypto')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs') as typeof import('fs')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('path') as typeof import('path')

/** The version of the audiotee npm package to download */
const AUDIOTEE_VERSION = '0.0.7'

/** npm registry tarball URL template */
const NPM_TARBALL_URL = `https://registry.npmjs.org/audiotee/-/audiotee-${AUDIOTEE_VERSION}.tgz`

/** Expected binary size range for validation (500KB - 1MB) */
const MIN_BINARY_SIZE = 500_000
const MAX_BINARY_SIZE = 1_000_000

/** SHA-256 hash of the expected extracted binary for integrity verification */
const AUDIOTEE_SHA256 = '10b1763bbe57062d58d89704b3a8ee49267763f60919fb0b51e84f2686bcb8e7'

/** Function signature matching Obsidian's requestUrl */
type RequestUrlFn = (request: { url: string; method: string }) => Promise<{ arrayBuffer: ArrayBuffer }>

export interface BinaryManagerOptions {
  /** Absolute path to the plugin directory (e.g. /path/to/vault/.obsidian/plugins/igggy) */
  pluginDir: string
  /** User-configured override path (from settings.nativeAudioPath) */
  overridePath?: string
  /** Currently installed version (from settings.nativeAudioVersion) */
  installedVersion?: string
  /** HTTP request function — pass Obsidian's requestUrl */
  requestUrl: RequestUrlFn
}

/**
 * Manages the native audio capture binary lifecycle:
 * download, install, version check, and cleanup.
 */
export class BinaryManager {
  private readonly pluginDir: string
  private readonly overridePath: string
  private readonly installedVersion: string
  private readonly requestUrl: RequestUrlFn

  constructor(options: BinaryManagerOptions) {
    this.pluginDir = options.pluginDir
    this.overridePath = options.overridePath ?? ''
    this.installedVersion = options.installedVersion ?? ''
    this.requestUrl = options.requestUrl
  }

  /** Returns the expected binary path (override or default) */
  getBinaryPath(): string {
    if (this.overridePath) return this.overridePath

    const platform = process.platform
    const binaryName = platform === 'win32' ? 'audiotee-wasapi.exe' : 'audiotee'
    return path.join(this.pluginDir, 'native', binaryName)
  }

  /** Check if the binary exists at the expected path */
  isInstalled(): boolean {
    try {
      const binaryPath = this.getBinaryPath()
      return fs.existsSync(binaryPath) && fs.statSync(binaryPath).isFile()
    } catch {
      return false
    }
  }

  /** Returns the installed version string, or empty if not installed */
  getInstalledVersion(): string {
    if (!this.isInstalled()) return ''
    return this.installedVersion
  }

  /** Returns the target version we want installed */
  getTargetVersion(): string {
    return AUDIOTEE_VERSION
  }

  /** Check if the installed binary is up to date */
  isUpToDate(): boolean {
    return this.isInstalled() && this.installedVersion === AUDIOTEE_VERSION
  }

  /**
   * Ensure the binary is installed and up to date.
   * Downloads if missing or outdated. Returns the binary path.
   *
   * @param onProgress - Optional callback for download progress updates
   * @returns The absolute path to the binary
   * @throws Error if download fails, extraction fails, or binary is invalid
   */
  async ensureBinary(onProgress?: (status: string) => void): Promise<{ binaryPath: string; version: string }> {
    // If user has a custom path, just verify it exists
    if (this.overridePath) {
      if (!fs.existsSync(this.overridePath)) {
        throw new Error(
          `Custom audio helper path not found: ${this.overridePath}. ` +
          'Check the path in Igggy settings, or clear it to use the auto-managed binary.'
        )
      }
      return { binaryPath: this.overridePath, version: this.installedVersion }
    }

    const binaryPath = this.getBinaryPath()

    // Already installed and up to date — skip download
    if (this.isUpToDate()) {
      return { binaryPath, version: AUDIOTEE_VERSION }
    }

    // Download and install
    onProgress?.('Downloading system audio helper…')
    await this.downloadAndInstall(binaryPath)
    onProgress?.('Ready')

    return { binaryPath, version: AUDIOTEE_VERSION }
  }

  /**
   * Download the binary from npm registry and install it.
   */
  private async downloadAndInstall(binaryPath: string): Promise<void> {
    const platform = process.platform

    if (platform !== 'darwin') {
      // Phase 4 will add Windows and Linux support
      throw new Error(
        `System audio auto-download is not yet available on ${platform}. ` +
        'Manually place the binary and set the path in Igggy settings.'
      )
    }

    // ── Download the npm tarball ────────────────────────────────────────────

    let tarballData: ArrayBuffer
    try {
      const response = await this.requestUrl({
        url: NPM_TARBALL_URL,
        method: 'GET',
      })
      tarballData = response.arrayBuffer
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(
        `Failed to download system audio helper: ${msg}. ` +
        'Check your internet connection and try again.'
      )
    }

    // ── Extract the binary from the tarball ─────────────────────────────────

    const binaryData = this.extractBinaryFromTarball(new Uint8Array(tarballData))

    // ── Validate the extracted binary ───────────────────────────────────────

    if (binaryData.byteLength < MIN_BINARY_SIZE || binaryData.byteLength > MAX_BINARY_SIZE) {
      throw new Error(
        `Downloaded binary has unexpected size (${binaryData.byteLength} bytes). ` +
        'The download may be corrupted. Try again.'
      )
    }

    // ── Verify SHA-256 integrity ────────────────────────────────────────────

    const hash = crypto.createHash('sha256').update(binaryData).digest('hex')
    if (hash !== AUDIOTEE_SHA256) {
      throw new Error(
        `Binary integrity check failed (expected ${AUDIOTEE_SHA256.slice(0, 12)}…, got ${hash.slice(0, 12)}…). ` +
        'The download may be corrupted or tampered with. Try again.'
      )
    }

    // ── Write to disk ──────────────────────────────────────────────────────

    const nativeDir = path.dirname(binaryPath)
    if (!fs.existsSync(nativeDir)) {
      fs.mkdirSync(nativeDir, { recursive: true })
    }

    fs.writeFileSync(binaryPath, binaryData)

    // ── macOS post-install: remove quarantine + make executable ─────────────

    if (platform === 'darwin') {
      try {
        execFileSync('chmod', ['+x', binaryPath])
      } catch (err) {
        console.warn('[Igggy] chmod +x failed:', err)
      }

      try {
        execFileSync('xattr', ['-d', 'com.apple.quarantine', binaryPath])
      } catch {
        // Quarantine attribute may not exist — not an error
      }
    }

    // ── Verify the binary is executable ─────────────────────────────────────

    try {
      execFileSync(binaryPath, ['--help'], { timeout: 5000, stdio: 'pipe' })
    } catch (err) {
      // --help exits with non-zero on some tools, check if the binary at least ran
      const error = err as { status?: number; stderr?: Buffer }
      if (error.status === null) {
        // Process was killed (timeout or signal) — binary might not be executable
        fs.unlinkSync(binaryPath)
        throw new Error(
          'System audio helper binary failed to execute after download. ' +
          'This may be a macOS Gatekeeper issue. Try downloading manually.'
        )
      }
      // Non-zero exit from --help is fine — the binary ran
    }
  }

  /**
   * Extract the audiotee binary from an npm tarball.
   *
   * Tarball structure: package/bin/audiotee
   * Tar format: 512-byte headers followed by file data padded to 512 bytes.
   */
  private extractBinaryFromTarball(gzipped: Uint8Array): Uint8Array {
    // Decompress gzip
    const decompressed = this.gunzip(gzipped)

    // Parse tar to find package/bin/audiotee
    const targetPath = 'package/bin/audiotee'
    let offset = 0

    while (offset < decompressed.length - 512) {
      // Read tar header (512 bytes)
      const header = decompressed.slice(offset, offset + 512)

      // Check for end-of-archive (two zero blocks)
      if (header.every(b => b === 0)) break

      // Extract filename (first 100 bytes, null-terminated)
      const nameEnd = header.indexOf(0)
      const name = new TextDecoder().decode(header.slice(0, nameEnd > 0 ? nameEnd : 100)).trim()

      // Extract file size (octal, bytes 124-135)
      const sizeStr = new TextDecoder().decode(header.slice(124, 136)).trim()
      const size = parseInt(sizeStr, 8) || 0

      // Move past header
      offset += 512

      if (name === targetPath || name === './' + targetPath) {
        // Found it — extract file data
        return decompressed.slice(offset, offset + size)
      }

      // Skip file data (padded to 512-byte boundary)
      offset += Math.ceil(size / 512) * 512
    }

    throw new Error(
      `Binary not found in downloaded package (looking for ${targetPath}). ` +
      'The package format may have changed. Please report this issue.'
    )
  }

  /**
   * Decompress gzip data using DecompressionStream (available in modern Electron/Chromium).
   * Falls back to manual gzip header stripping + raw inflate if needed.
   */
  private gunzip(data: Uint8Array): Uint8Array {
    // Use Node.js zlib which is available in Obsidian's Electron environment
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const zlib = require('zlib') as typeof import('zlib')
    const result = zlib.gunzipSync(Buffer.from(data))
    return new Uint8Array(result.buffer, result.byteOffset, result.byteLength)
  }
}
