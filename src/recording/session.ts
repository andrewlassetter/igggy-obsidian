/**
 * RecordingSession
 *
 * Wraps getUserMedia + native system audio capture + MediaRecorder + a Web Audio AnalyserNode.
 * Supports three recording modes:
 *   - 'mic'    — microphone only (default)
 *   - 'system' — system audio via native binary helper (no mic)
 *   - 'both'   — mic + system audio mixed via AudioContext
 *
 * On desktop (Obsidian), system audio is captured via a native binary helper
 * (AudioTee on macOS) because getDisplayMedia is not available in Obsidian's
 * Electron sandbox. The binary streams raw PCM to stdout, which is converted
 * to a MediaStream by NativeAudioCapture.
 *
 * Usage:
 *   const session = await RecordingSession.create('system', { binaryPath: '/path/to/audiotee' })
 *   session.start()
 *   // later:
 *   const blob = await session.stop()
 */

import { NativeAudioCapture } from './native-audio'

export type RecordingState = 'recording' | 'paused' | 'inactive'

/** The audio source mode for a recording session. */
export type RecordingMode = 'mic' | 'system' | 'both'

/** Options for system audio capture via native binary helper */
export interface SystemAudioOptions {
  /** Path to the native binary (e.g. AudioTee) */
  binaryPath: string
  /** Sample rate in Hz (default: 16000) */
  sampleRate?: number
}

/**
 * Thrown when the user dismisses the getDisplayMedia screen picker.
 * The view transitions silently back to idle — this is not an error state.
 */
export class PickerCancelledError extends Error {
  constructor() {
    super('Screen picker was cancelled')
    this.name = 'PickerCancelledError'
  }
}

export class RecordingSession {
  private readonly mediaRecorder: MediaRecorder
  private readonly micStream: MediaStream | null
  private readonly systemStream: MediaStream | null
  private readonly audioContext: AudioContext
  private readonly analyser: AnalyserNode
  private readonly nativeCapture: NativeAudioCapture | null
  private readonly chunks: Blob[] = []

  private startTime = 0
  private pausedMs = 0
  private pauseStart: number | null = null

  private constructor(
    micStream: MediaStream | null,
    systemStream: MediaStream | null,
    audioContext: AudioContext,
    analyser: AnalyserNode,
    mediaRecorder: MediaRecorder,
    nativeCapture: NativeAudioCapture | null = null
  ) {
    this.micStream = micStream
    this.systemStream = systemStream
    this.audioContext = audioContext
    this.analyser = analyser
    this.mediaRecorder = mediaRecorder
    this.nativeCapture = nativeCapture

    mediaRecorder.ondataavailable = (e: BlobEvent) => {
      if (e.data.size > 0) this.chunks.push(e.data)
    }
  }

  /**
   * Acquire audio stream(s), build the audio graph, and return a session
   * ready to call start() on.
   *
   * @param mode - 'mic' (default), 'system', or 'both'
   * @param systemAudioOptions - Required when mode is 'system' or 'both'; provides the native binary path
   * @throws PickerCancelledError if the user dismisses the screen picker (browser fallback only)
   * @throws DOMException (NotAllowedError / NotFoundError) for mic permission errors
   * @throws Error if system audio capture fails (binary not found, permission denied, etc.)
   */
  static async create(
    mode: RecordingMode = 'mic',
    systemAudioOptions?: SystemAudioOptions
  ): Promise<RecordingSession> {
    let micStream: MediaStream | null = null
    let systemStream: MediaStream | null = null
    let nativeCapture: NativeAudioCapture | null = null

    // ── Acquire streams ───────────────────────────────────────────────────────

    if (mode === 'system' || mode === 'both') {
      // Desktop (Obsidian): use native binary helper for system audio
      if (systemAudioOptions) {
        nativeCapture = new NativeAudioCapture()
        try {
          systemStream = await nativeCapture.start({
            binaryPath: systemAudioOptions.binaryPath,
            sampleRate: systemAudioOptions.sampleRate,
          })
        } catch (err) {
          nativeCapture.stop()
          nativeCapture = null
          throw err
        }
      } else {
        // Browser fallback: use getDisplayMedia (for web app compatibility)
        let displayStream: MediaStream
        try {
          displayStream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: true,
          })
        } catch (err) {
          if (
            err instanceof DOMException &&
            (err.name === 'AbortError' ||
             (err.name === 'NotAllowedError' &&
              err.message.toLowerCase().includes('cancel')))
          ) {
            throw new PickerCancelledError()
          }
          if (err instanceof DOMException && err.name === 'NotAllowedError') {
            throw new Error(
              'System audio capture is not available. Obsidian may not support this feature on your system. ' +
              'Try using the Igggy web app (app.igggy.ai) for system audio recording, or use a loopback ' +
              'audio tool like BlackHole (macOS) to route system audio to your microphone input.'
            )
          }
          if (err instanceof TypeError || (err instanceof DOMException && err.name === 'NotSupportedError')) {
            throw new Error(
              'System audio capture is not supported in this version of Obsidian. ' +
              'Use the Igggy web app (app.igggy.ai) for system audio recording, or use a loopback ' +
              'audio tool like BlackHole (macOS) to route system audio to your microphone input.'
            )
          }
          throw err
        }

        displayStream.getVideoTracks().forEach(t => t.stop())
        const audioTracks = displayStream.getAudioTracks()
        if (audioTracks.length === 0) {
          displayStream.getTracks().forEach(t => t.stop())
          throw new Error(
            'No audio was shared. In the screen picker, make sure "Share audio" is checked.'
          )
        }
        systemStream = displayStream
      }
    }

    if (mode === 'mic' || mode === 'both') {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      } catch (err) {
        // Release system stream / native capture if already acquired before re-throwing
        systemStream?.getTracks().forEach(t => t.stop())
        if (nativeCapture) {
          nativeCapture.stop()
          nativeCapture = null
        }
        throw err
      }
    }

    // ── Build audio graph ─────────────────────────────────────────────────────

    const audioContext = new AudioContext()
    if (audioContext.state === 'suspended') await audioContext.resume()
    const analyser = audioContext.createAnalyser()
    analyser.fftSize = 64                // 32 frequency bins — plenty for 28 bars
    analyser.smoothingTimeConstant = 0.75 // responsive but not jittery
    analyser.minDecibels = -85
    analyser.maxDecibels = -10

    let recordingStream: MediaStream

    if (micStream && systemStream) {
      // 'both': mix mic + system audio into a destination node
      const destination = audioContext.createMediaStreamDestination()
      const micSource = audioContext.createMediaStreamSource(micStream)
      const sysSource = audioContext.createMediaStreamSource(systemStream)
      micSource.connect(analyser)
      micSource.connect(destination)
      sysSource.connect(analyser)
      sysSource.connect(destination)
      // NOT connected to audioContext.destination — no playback feedback
      recordingStream = destination.stream
    } else if (systemStream) {
      // 'system' only: use system stream directly
      const sysSource = audioContext.createMediaStreamSource(systemStream)
      sysSource.connect(analyser)
      // NOT connected to audioContext.destination — no playback feedback
      recordingStream = systemStream
    } else {
      // 'mic' only (default): existing behavior
      const source = audioContext.createMediaStreamSource(micStream!)
      source.connect(analyser)
      recordingStream = micStream!
    }

    const mimeType = RecordingSession.pickMimeType()
    const mediaRecorder = mimeType
      ? new MediaRecorder(recordingStream, { mimeType })
      : new MediaRecorder(recordingStream)

    // ── Set up graceful degradation for 'both' mode ─────────────────────────

    if (nativeCapture && mode === 'both') {
      nativeCapture.onProcessCrash(() => {
        console.warn('[Igggy] System audio helper crashed mid-recording — mic-only recording continues')
        // The mic stream and MediaRecorder continue running.
        // System audio simply stops appearing in the mix — no user action needed.
      })
    }

    return new RecordingSession(micStream, systemStream, audioContext, analyser, mediaRecorder, nativeCapture)
  }

  /** Begin recording. Call after createRecordingPlaceholder() has opened the note. */
  start(): void {
    this.startTime = Date.now()
    this.mediaRecorder.start(100) // 100ms timeslices keep chunk sizes small
  }

  pause(): void {
    this.pauseStart = Date.now()
    this.mediaRecorder.pause()
  }

  resume(): void {
    if (this.pauseStart !== null) {
      this.pausedMs += Date.now() - this.pauseStart
      this.pauseStart = null
    }
    this.mediaRecorder.resume()
  }

  /** Stop recording, release all streams, native processes, and AudioContext, return the audio blob. */
  async stop(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        this.micStream?.getTracks().forEach(t => t.stop())
        this.systemStream?.getTracks().forEach(t => t.stop())
        this.nativeCapture?.stop()
        void this.audioContext.close()
      }

      // Safety timeout — if onstop never fires, resolve with whatever chunks we have
      const timeout = setTimeout(() => {
        console.warn('[Igggy] MediaRecorder.onstop did not fire within 5s — resolving with available chunks')
        cleanup()
        resolve(new Blob(this.chunks, { type: this.mediaRecorder.mimeType }))
      }, 5000)

      this.mediaRecorder.onerror = (event) => {
        clearTimeout(timeout)
        cleanup()
        const errorEvent = event as ErrorEvent
        reject(new Error(`Recording error: ${errorEvent.message || 'unknown'}`))
      }

      this.mediaRecorder.onstop = () => {
        clearTimeout(timeout)
        const blob = new Blob(this.chunks, { type: this.mediaRecorder.mimeType })
        cleanup()
        resolve(blob)
      }

      try {
        this.mediaRecorder.stop()
      } catch (err) {
        clearTimeout(timeout)
        cleanup()
        // If stop() throws (e.g. recorder already inactive), resolve with available chunks
        console.warn('[Igggy] MediaRecorder.stop() threw:', err)
        resolve(new Blob(this.chunks, { type: this.mediaRecorder.mimeType }))
      }
    })
  }

  getState(): RecordingState {
    switch (this.mediaRecorder.state) {
      case 'recording': return 'recording'
      case 'paused':    return 'paused'
      default:          return 'inactive'
    }
  }

  // ── Mute / unmute (mic track only — muting system audio is not supported) ───

  /** Mute the microphone without stopping the recording. No-op in 'system' mode. */
  mute(): void {
    this.micStream?.getAudioTracks().forEach(t => { t.enabled = false })
  }

  /** Restore microphone audio after muting. No-op in 'system' mode. */
  unmute(): void {
    this.micStream?.getAudioTracks().forEach(t => { t.enabled = true })
  }

  /** Returns true when the mic track is currently muted. Always false in 'system' mode. */
  isMuted(): boolean {
    const tracks = this.micStream?.getAudioTracks() ?? []
    return tracks.length > 0 && !tracks[0].enabled
  }

  /** Returns true if this session has an active microphone stream ('mic' or 'both' modes). */
  hasMic(): boolean {
    return this.micStream !== null
  }

  /** Elapsed wall-clock seconds, paused time excluded. */
  getElapsedSec(): number {
    const now = Date.now()
    const activePausedMs = this.pauseStart !== null ? now - this.pauseStart : 0
    return Math.max(0, (now - this.startTime - this.pausedMs - activePausedMs) / 1000)
  }

  /** The AnalyserNode — used by the waveform canvas to read live frequency data. */
  getAnalyserNode(): AnalyserNode {
    return this.analyser
  }

  // ── Static helpers ──────────────────────────────────────────────────────────

  /** Returns the best supported MIME type for recording, or empty string for browser default. */
  static pickMimeType(): string {
    const candidates = ['audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
    for (const type of candidates) {
      if (MediaRecorder.isTypeSupported(type)) return type
    }
    return ''
  }

  /** Maps a MIME type string to a file extension for the saved blob. */
  static getExtension(mimeType: string): string {
    if (mimeType.includes('webm')) return 'webm'
    if (mimeType.includes('ogg'))  return 'ogg'
    if (mimeType.includes('mp4'))  return 'mp4'
    return 'audio'
  }
}
