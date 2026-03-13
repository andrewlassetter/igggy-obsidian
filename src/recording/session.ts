/**
 * RecordingSession
 *
 * Wraps getUserMedia / getDisplayMedia + MediaRecorder + a Web Audio AnalyserNode.
 * Supports three recording modes:
 *   - 'mic'    — microphone only (default)
 *   - 'system' — system / window audio via getDisplayMedia (no mic)
 *   - 'both'   — mic + system audio mixed via AudioContext
 *
 * Usage:
 *   const session = await RecordingSession.create('system')
 *   session.start()
 *   // later:
 *   const blob = await session.stop()
 */

export type RecordingState = 'recording' | 'paused' | 'inactive'

/** The audio source mode for a recording session. */
export type RecordingMode = 'mic' | 'system' | 'both'

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
  private readonly chunks: Blob[] = []

  private startTime = 0
  private pausedMs = 0
  private pauseStart: number | null = null

  private constructor(
    micStream: MediaStream | null,
    systemStream: MediaStream | null,
    audioContext: AudioContext,
    analyser: AnalyserNode,
    mediaRecorder: MediaRecorder
  ) {
    this.micStream = micStream
    this.systemStream = systemStream
    this.audioContext = audioContext
    this.analyser = analyser
    this.mediaRecorder = mediaRecorder

    mediaRecorder.ondataavailable = (e: BlobEvent) => {
      if (e.data.size > 0) this.chunks.push(e.data)
    }
  }

  /**
   * Acquire audio stream(s), build the audio graph, and return a session
   * ready to call start() on.
   *
   * @param mode - 'mic' (default), 'system', or 'both'
   * @throws PickerCancelledError if the user dismisses the screen picker
   * @throws DOMException (NotAllowedError / NotFoundError) for mic permission errors
   * @throws Error if the screen picker returns no audio tracks
   */
  static async create(mode: RecordingMode = 'mic'): Promise<RecordingSession> {
    let micStream: MediaStream | null = null
    let systemStream: MediaStream | null = null

    // ── Acquire streams ───────────────────────────────────────────────────────

    if (mode === 'system' || mode === 'both') {
      let displayStream: MediaStream
      try {
        displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
        })
      } catch (err) {
        // Only treat user-initiated cancellation as PickerCancelledError.
        // Real errors (permission denied, API unavailable) propagate to the view.
        if (
          err instanceof DOMException &&
          (err.name === 'AbortError' ||
           (err.name === 'NotAllowedError' &&
            err.message.toLowerCase().includes('cancel')))
        ) {
          throw new PickerCancelledError()
        }
        // Provide a user-friendly error for system audio capture failures in Obsidian
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

      // Stop video tracks — only the audio is needed
      displayStream.getVideoTracks().forEach(t => t.stop())

      const audioTracks = displayStream.getAudioTracks()
      if (audioTracks.length === 0) {
        // User picked a source but didn't enable "Share audio"
        displayStream.getTracks().forEach(t => t.stop())
        throw new Error(
          'No audio was shared. In the screen picker, make sure "Share audio" is checked.'
        )
      }

      systemStream = displayStream
    }

    if (mode === 'mic' || mode === 'both') {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      } catch (err) {
        // Release system stream if already acquired before re-throwing
        systemStream?.getTracks().forEach(t => t.stop())
        throw err
      }
    }

    // ── Build audio graph ─────────────────────────────────────────────────────

    const audioContext = new AudioContext()
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
      // 'system' only: use display stream audio directly
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

    return new RecordingSession(micStream, systemStream, audioContext, analyser, mediaRecorder)
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

  /** Stop recording, release all streams and AudioContext, return the audio blob. */
  async stop(): Promise<Blob> {
    return new Promise((resolve) => {
      this.mediaRecorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.mediaRecorder.mimeType })
        this.micStream?.getTracks().forEach(t => t.stop())
        this.systemStream?.getTracks().forEach(t => t.stop())
        void this.audioContext.close()
        resolve(blob)
      }
      this.mediaRecorder.stop()
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
