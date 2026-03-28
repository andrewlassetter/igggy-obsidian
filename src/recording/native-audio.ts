/**
 * native-audio.ts
 *
 * Captures system audio on desktop platforms by spawning a native binary helper
 * (AudioTee on macOS, audiotee-wasapi on Windows, pw-record/parec on Linux)
 * as a child process. The binary writes raw PCM to stdout; this module converts
 * that into a standard MediaStream for use by RecordingSession.
 *
 * Requires macOS 14.2+ (Core Audio Tap API), Windows 10+, or Linux with PipeWire/PulseAudio.
 */

import type { ChildProcess } from 'child_process'

// Node modules — available in Obsidian desktop (isDesktopOnly: true)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require('child_process') as typeof import('child_process')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeOs = require('os') as typeof import('os')

/** Default sample rate for speech transcription (Whisper/Deepgram native rate) */
const DEFAULT_SAMPLE_RATE = 16000

/** Channels — mono is sufficient for transcription */
const CHANNELS = 1

/** Bytes per sample for 16-bit signed integer PCM */
const BYTES_PER_SAMPLE = 2

/** Buffer size for the ScriptProcessorNode (must be power of 2) */
const BUFFER_SIZE = 4096

export interface NativeAudioOptions {
  /** Path to the native binary */
  binaryPath: string
  /** Sample rate in Hz (default: 16000) */
  sampleRate?: number
}

/**
 * Captures system audio via a native binary helper and produces a MediaStream.
 *
 * The binary streams raw 16-bit signed integer PCM on stdout at the configured
 * sample rate. A ScriptProcessorNode feeds those samples into a
 * MediaStreamDestination, producing a standard MediaStream that integrates
 * with RecordingSession's existing audio graph.
 */
export class NativeAudioCapture {
  private process: ChildProcess | null = null
  private audioContext: AudioContext | null = null
  private scriptNode: ScriptProcessorNode | null = null
  private pcmBuffer: Int16Array = new Int16Array(0)
  private bufferWritePos = 0
  private bufferReadPos = 0
  private stderrOutput = ''
  private crashed = false
  private onCrash: (() => void) | null = null

  /**
   * Check whether native audio capture is supported on this platform.
   * Does NOT check binary availability — use BinaryManager for that.
   *
   * @param osRelease - Override for os.release() (used in tests)
   */
  static isSupported(osRelease?: string): { supported: boolean; reason?: string } {
    if (typeof process === 'undefined') {
      return { supported: false, reason: 'Not a desktop environment' }
    }

    const platform = process.platform

    if (platform === 'darwin') {
      // macOS — check for 14.2+ via Darwin kernel version
      // Darwin 23.2.0 = macOS 14.2 (kernel major 23, minor >= 2)
      const release = osRelease ?? nodeOs.release()
      const [major, minor] = release.split('.').map(Number)
      if (major < 23 || (major === 23 && minor < 2)) {
        return {
          supported: false,
          reason: 'System audio requires macOS 14.2 or later. Use the Igggy web app (app.igggy.ai) for this feature.',
        }
      }
      return { supported: true }
    }

    if (platform === 'win32') {
      return { supported: true }
    }

    if (platform === 'linux') {
      return { supported: true }
    }

    return { supported: false, reason: `Unsupported platform: ${platform}` }
  }

  /**
   * Start capturing system audio.
   *
   * Spawns the native binary, creates an AudioContext + ScriptProcessorNode
   * to convert PCM stdout into a MediaStream.
   *
   * @returns A MediaStream containing the system audio — same type as getDisplayMedia() would return
   * @throws Error if binary not found, permission denied, or process fails to start
   */
  async start(options: NativeAudioOptions): Promise<MediaStream> {
    const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE
    const binaryPath = options.binaryPath

    // ── Spawn the native binary ─────────────────────────────────────────────

    const args = this.buildArgs(sampleRate)

    let proc: ChildProcess
    try {
      proc = spawn(binaryPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException
      if (error.code === 'ENOENT') {
        throw new Error(
          `System audio helper not found at ${binaryPath}. ` +
          'The helper binary may need to be downloaded — try toggling system audio off and on.'
        )
      }
      if (error.code === 'EACCES') {
        throw new Error(
          `System audio helper is not executable: ${binaryPath}. ` +
          'Try running: chmod +x "' + binaryPath + '"'
        )
      }
      throw new Error(`Failed to start system audio helper: ${error.message}`)
    }

    this.process = proc

    // ── Collect stderr for error diagnostics ────────────────────────────────

    proc.stderr?.on('data', (chunk: Buffer) => {
      this.stderrOutput += chunk.toString()
    })

    // ── Wait briefly for the process to either start or fail immediately ────

    await new Promise<void>((resolve, reject) => {
      const earlyExitHandler = (code: number | null) => {
        const stderr = this.stderrOutput.trim()
        if (stderr.toLowerCase().includes('permission') || stderr.toLowerCase().includes('tcc')) {
          reject(new Error(
            'System audio permission was denied. ' +
            'Open System Settings > Privacy & Security > System Audio Recording and enable Obsidian, then try again.'
          ))
        } else {
          reject(new Error(
            `System audio helper exited immediately (code ${code}). ${stderr ? 'Details: ' + stderr : ''}`
          ))
        }
        this.process = null
      }

      proc.once('error', (err) => {
        reject(new Error(`System audio helper failed to start: ${err.message}`))
        this.process = null
      })

      proc.once('exit', earlyExitHandler)

      // If still running after 500ms, it's alive — proceed
      setTimeout(() => {
        proc.removeListener('exit', earlyExitHandler)
        resolve()
      }, 500)
    })

    // ── Set up crash handler for mid-recording failures ─────────────────────

    proc.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.warn(`[Igggy] System audio helper exited with code ${code}`)
        this.crashed = true
        this.onCrash?.()
      }
    })

    // ── Build audio graph: PCM stdout → ScriptProcessorNode → MediaStream ──

    const audioContext = new AudioContext({ sampleRate })
    if (audioContext.state === 'suspended') await audioContext.resume()
    this.audioContext = audioContext

    // Ring buffer for PCM data — holds 1 second of audio
    const ringBufferSize = sampleRate * CHANNELS
    this.pcmBuffer = new Int16Array(ringBufferSize)
    this.bufferWritePos = 0

    // Accumulate PCM data from stdout into the ring buffer
    this.bufferReadPos = 0
    proc.stdout?.on('data', (chunk: Buffer) => {
      const samples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / BYTES_PER_SAMPLE)
      for (let i = 0; i < samples.length; i++) {
        this.pcmBuffer[this.bufferWritePos % ringBufferSize] = samples[i]
        this.bufferWritePos++
      }
    })

    // ScriptProcessorNode reads from the ring buffer and outputs float samples
    const scriptNode = audioContext.createScriptProcessor(BUFFER_SIZE, 0, CHANNELS)
    this.scriptNode = scriptNode

    scriptNode.onaudioprocess = (event: AudioProcessingEvent) => {
      const output = event.outputBuffer.getChannelData(0)
      const ringSize = this.pcmBuffer.length
      // Cap available to ring buffer size — prevents reading stale wrapped-around data
      // if the main thread freezes and readPos falls behind by more than one full buffer
      const available = Math.min(this.bufferWritePos - this.bufferReadPos, ringSize)

      for (let i = 0; i < output.length; i++) {
        if (i < available) {
          // Convert Int16 → Float32 (range -1.0 to 1.0)
          output[i] = this.pcmBuffer[(this.bufferReadPos + i) % ringSize] / 32768
        } else {
          output[i] = 0 // silence if buffer underrun
        }
      }
      this.bufferReadPos += Math.min(output.length, available)
    }

    // Connect: ScriptProcessor → MediaStreamDestination
    const destination = audioContext.createMediaStreamDestination()
    scriptNode.connect(destination)
    // ScriptProcessorNode requires a connection to destination to keep processing
    scriptNode.connect(audioContext.destination)

    return destination.stream
  }

  /** Register a callback for when the native process crashes mid-recording */
  onProcessCrash(callback: () => void): void {
    this.onCrash = callback
  }

  /** Returns true if the native process is still running */
  isAlive(): boolean {
    return this.process !== null && !this.crashed && this.process.exitCode === null
  }

  /** Stop the native process and clean up audio nodes */
  stop(): void {
    if (this.process && this.process.exitCode === null) {
      const proc = this.process
      proc.kill('SIGTERM')
      // Escalate to SIGKILL if SIGTERM is ignored after 2 seconds
      setTimeout(() => {
        try { if (proc.exitCode === null) proc.kill('SIGKILL') } catch { /* already exited */ }
      }, 2000)
    }
    this.process = null

    if (this.scriptNode) {
      this.scriptNode.disconnect()
      this.scriptNode = null
    }

    if (this.audioContext) {
      void this.audioContext.close()
      this.audioContext = null
    }

    this.pcmBuffer = new Int16Array(0)
    this.bufferWritePos = 0
    this.bufferReadPos = 0
    this.stderrOutput = ''
    this.crashed = false
  }

  /**
   * Build CLI arguments for the native binary based on platform.
   *
   * macOS (audiotee v0.0.7): Supported flags are --sample-rate, --chunk-duration,
   * --include-processes, --exclude-processes, --mute. Mono output is implicit
   * when --sample-rate is specified — there is NO --channels flag.
   *
   * Validated against: `audiotee --help` (v0.0.7)
   */
  private buildArgs(sampleRate: number): string[] {
    const platform = process.platform

    if (platform === 'darwin') {
      // audiotee: --sample-rate <hz> (mono output implicit)
      return ['--sample-rate', String(sampleRate)]
    }

    if (platform === 'win32') {
      // audiotee-wasapi: TBD — Phase 4. Validate actual CLI before wiring.
      return ['--sample-rate', String(sampleRate)]
    }

    // Linux: pw-record or parec — args vary (Phase 4)
    return ['--rate', String(sampleRate), '--channels', String(CHANNELS), '--format', 's16le', '-']
  }
}
