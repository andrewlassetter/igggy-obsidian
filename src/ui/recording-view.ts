/**
 * recording-view.ts
 *
 * A persistent sidebar ItemView that replicates the web app's /new recording
 * experience. Ribbon click opens / focuses this panel; all recording state
 * lives here rather than in main.ts so the UI stays tightly coupled to state.
 *
 * plugin.activeRecording and plugin.recordingPlaceholder are kept in sync so
 * the existing command-palette commands (pause-resume-recording,
 * stop-and-process) continue to work while the panel is open.
 *
 * State machine:
 *   idle → requesting → recording → paused
 *        → stopped (confirm: duration + Delete / Create note)
 *        → processing (pipeline running)
 *        → error (mic denied / pipeline failed)
 *        → idle (on completion or discard)
 */

import { ItemView, Notice, WorkspaceLeaf } from 'obsidian'
import type { TFile } from 'obsidian'
import type IgggyPlugin from '../main'
import { RecordingSession, PickerCancelledError, type RecordingMode } from '../recording/session'
import {
  validateKeys,
  openAudioFilePicker,
  runProcessingPipeline,
} from '../commands'
import {
  createRecordingPlaceholder,
  setRecordingState,
  transitionToProcessing,
} from '../notes/writer'

// ── Constants ─────────────────────────────────────────────────────────────────

export const RECORDING_VIEW_TYPE = 'igggy-recording'

const BAR_COUNT = 28
const SILENCE_THRESHOLD = 5      // max bin value (0–255) below which we consider it silence
const SILENCE_DELAY_MS = 10_000  // wait 10 s after recording starts before checking

// ── Types ─────────────────────────────────────────────────────────────────────

type ViewState =
  | 'idle'
  | 'requesting'
  | 'recording'
  | 'paused'
  | 'stopped'
  | 'confirming_delete'
  | 'processing'
  | 'error'

// ── RecordingView ─────────────────────────────────────────────────────────────

export class RecordingView extends ItemView {
  private readonly plugin: IgggyPlugin

  // ── State ──────────────────────────────────────────────────────────────────
  private state: ViewState = 'idle'
  private recordingMode: RecordingMode = 'mic'  // set from settings at recording start
  private session: RecordingSession | null = null
  private silenceWarningEl: HTMLElement | null = null
  private blob: Blob | null = null
  private placeholderFile: TFile | null = null
  private finalElapsed = 0
  private capturedAt: Date | null = null
  private errorMsg = ''
  private processLabel = ''

  // ── Active handles (cancelled in onClose) ──────────────────────────────────
  private timerInterval: ReturnType<typeof setInterval> | null = null
  private rafId = 0

  constructor(leaf: WorkspaceLeaf, plugin: IgggyPlugin) {
    super(leaf)
    this.plugin = plugin
  }

  // ── ItemView interface ─────────────────────────────────────────────────────

  getViewType(): string { return RECORDING_VIEW_TYPE }
  getDisplayText(): string { return 'Igggy Recording' }
  getIcon(): string { return 'mic' }

  onOpen(): Promise<void> {
    this.render()
    return Promise.resolve()
  }

  async onClose(): Promise<void> {
    this.stopTimer()
    cancelAnimationFrame(this.rafId)
    // Release microphone if the panel is closed mid-recording
    if (this.session) {
      await this.session.stop()
      this.session = null
      this.plugin.activeRecording = null
      this.plugin.recordingPlaceholder = null
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  private render(): void {
    const root = this.containerEl.children[1] as HTMLElement
    root.empty()
    root.addClass('igggy-recording-view')

    const header = root.createDiv({ cls: 'igggy-rv-header' })
    header.createEl('span', { text: 'Igggy', cls: 'igggy-rv-title' })

    const body = root.createDiv({ cls: 'igggy-rv-body' })
    this.renderBody(body)
  }

  private renderBody(body: HTMLElement): void {
    body.empty()
    switch (this.state) {
      case 'idle':
        this.renderIdle(body)
        break
      case 'requesting':
        body.createEl('p', {
          text: this.recordingMode === 'mic' ? 'Requesting microphone…' : 'Opening screen picker…',
          cls: 'igggy-rv-hint',
        })
        break
      case 'recording':
        this.renderActiveRecording(body)
        break
      case 'paused':
        this.renderPaused(body)
        break
      case 'stopped':
        this.renderStopped(body)
        break
      case 'confirming_delete':
        this.renderConfirmingDelete(body)
        break
      case 'processing':
        this.renderProcessing(body)
        break
      case 'error':
        this.renderError(body)
        break
    }
  }

  // ── Idle ───────────────────────────────────────────────────────────────────

  private renderIdle(body: HTMLElement): void {
    const keyError = validateKeys(this.plugin)
    if (keyError) {
      body.createEl('p', {
        text: 'API keys required — Open settings to add them.',
        cls: 'igggy-rv-warning',
      })
    }

    const btn = body.createEl('button', {
      text: '⏺ start recording',
      cls: 'igggy-rv-btn-primary',
    })
    btn.disabled = !!keyError
    btn.addEventListener('click', () => { void this.handleStart() })

    // ── System audio toggle ───────────────────────────────────────────────────

    const toggleRow = body.createDiv({ cls: 'igggy-rv-toggle-row' })
    const checkbox = toggleRow.createEl('input', { cls: 'igggy-rv-toggle-checkbox' })
    checkbox.type = 'checkbox'
    checkbox.checked = this.plugin.settings.includeSystemAudio
    const toggleLabel = toggleRow.createEl('label', { text: 'Include system audio' })
    toggleLabel.htmlFor = 'igggy-system-audio'
    checkbox.id = 'igggy-system-audio'

    const hintEl = body.createEl('p', {
      text: 'You\'ll be prompted to choose a window — Check "Share audio".',
      cls: 'igggy-rv-source-hint',
    })
    hintEl.toggleClass('igggy-hidden', !checkbox.checked)

    checkbox.addEventListener('change', () => {
      this.plugin.settings.includeSystemAudio = checkbox.checked
      void this.plugin.saveSettings()
      hintEl.toggleClass('igggy-hidden', !checkbox.checked)
    })

    body.createEl('button', { text: '↑ from file…', cls: 'igggy-rv-btn-secondary' })
      .addEventListener('click', () => { void openAudioFilePicker(this.plugin) })
  }

  // ── Recording ──────────────────────────────────────────────────────────────

  private renderActiveRecording(body: HTMLElement): void {
    const waveformEl = body.createDiv({ cls: 'igggy-rv-waveform' })
    this.startCanvasWaveform(waveformEl)

    // Silence warning — hidden initially, shown by startCanvasWaveform after 10 s of silence
    const silenceMsg = this.recordingMode === 'both'
      ? 'No audio detected — check your microphone and make sure "Share audio" was enabled'
      : 'No audio detected — check your microphone'
    this.silenceWarningEl = body.createEl('p', {
      text: silenceMsg,
      cls: 'igggy-rv-warning',
    })
    this.silenceWarningEl.toggleClass('igggy-hidden', true)

    const footer = body.createDiv({ cls: 'igggy-rv-waveform-footer' })
    const timerEl = footer.createSpan({ cls: 'igggy-rv-timer', text: '0:00' })
    footer.createSpan({ cls: 'igggy-rv-waveform-label', text: '● recording' })
    this.startTimer(timerEl)

    const controls = body.createDiv({ cls: 'igggy-rv-controls' })

    // Mute toggle — only shown when a mic stream is active ('mic' or 'both' modes)
    if (this.session?.hasMic()) {
      const muteBtn = controls.createEl('button', { text: '🎙️ mute', cls: 'igggy-rv-btn-secondary' })
      muteBtn.addEventListener('click', () => {
        if (this.session?.isMuted()) {
          this.session.unmute()
          muteBtn.textContent = '🎙️ mute'
        } else {
          this.session?.mute()
          muteBtn.textContent = '🔇 unmute'
        }
      })
    }

    controls.createEl('button', { text: '⏸ pause', cls: 'igggy-rv-btn-secondary' })
      .addEventListener('click', () => this.handlePause())
    controls.createEl('button', { text: '■ stop', cls: 'igggy-rv-btn-primary' })
      .addEventListener('click', () => { void this.handleStop() })
  }

  // ── Paused ─────────────────────────────────────────────────────────────────

  private renderPaused(body: HTMLElement): void {
    // Flat bars reuse existing .igggy-waveform.paused styles from styles.css
    const waveformEl = body.createDiv({ cls: 'igggy-rv-waveform igggy-waveform paused' })
    const barsDiv = waveformEl.createDiv({ cls: 'igggy-bars' })
    for (let i = 0; i < BAR_COUNT; i++) barsDiv.createDiv({ cls: 'bar' })

    const footer = body.createDiv({ cls: 'igggy-rv-waveform-footer' })
    const timerEl = footer.createSpan({ cls: 'igggy-rv-timer' })
    timerEl.textContent = this.formatSec(this.session?.getElapsedSec() ?? 0)
    footer.createSpan({ cls: 'igggy-rv-waveform-label', text: '⏸ paused' })
    // Timer updates so the frozen time is accurate at the moment of resume
    this.startTimer(timerEl)

    const controls = body.createDiv({ cls: 'igggy-rv-controls' })
    controls.createEl('button', { text: '▶ resume', cls: 'igggy-rv-btn-secondary' })
      .addEventListener('click', () => this.handleResume())
    controls.createEl('button', { text: '■ stop', cls: 'igggy-rv-btn-primary' })
      .addEventListener('click', () => { void this.handleStop() })
  }

  // ── Stopped (confirm step) ─────────────────────────────────────────────────

  private renderStopped(body: HTMLElement): void {
    const summary = body.createDiv({ cls: 'igggy-rv-summary' })
    summary.createEl('p', { text: 'Recording complete', cls: 'igggy-rv-summary-title' })

    const detail = this.capturedAt
      ? `${this.formatDuration(this.finalElapsed)} · ${
          this.capturedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        }`
      : this.formatDuration(this.finalElapsed)
    summary.createEl('p', { text: detail, cls: 'igggy-rv-summary-detail' })

    const controls = body.createDiv({ cls: 'igggy-rv-controls' })
    controls.createEl('button', { text: 'Delete recording', cls: 'igggy-rv-btn-secondary' })
      .addEventListener('click', () => this.transition('confirming_delete'))
    controls.createEl('button', { text: 'Create note', cls: 'igggy-rv-btn-primary' })
      .addEventListener('click', () => { void this.handleProcess() })
  }

  // ── Confirming delete ──────────────────────────────────────────────────────

  private renderConfirmingDelete(body: HTMLElement): void {
    const summary = body.createDiv({ cls: 'igggy-rv-summary' })
    summary.createEl('p', { text: 'Delete this recording?', cls: 'igggy-rv-summary-title' })
    summary.createEl('p', { text: 'The note draft will also be removed.', cls: 'igggy-rv-summary-detail' })

    const controls = body.createDiv({ cls: 'igggy-rv-controls' })
    controls.createEl('button', { text: 'Cancel', cls: 'igggy-rv-btn-secondary' })
      .addEventListener('click', () => this.transition('stopped'))
    controls.createEl('button', { text: 'Delete', cls: 'igggy-rv-btn-primary' })
      .addEventListener('click', () => { void this.handleDiscardConfirmed() })
  }

  // ── Processing ─────────────────────────────────────────────────────────────

  private renderProcessing(body: HTMLElement): void {
    // Rolling sine-wave animation reuses .igggy-waveform.processing styles
    const waveformEl = body.createDiv({ cls: 'igggy-rv-waveform igggy-waveform processing' })
    const barsDiv = waveformEl.createDiv({ cls: 'igggy-bars' })
    for (let i = 0; i < BAR_COUNT; i++) {
      const bar = barsDiv.createDiv({ cls: 'bar' })
      const delay = -(i / (BAR_COUNT - 1)) * 1.4
      bar.style.setProperty('--wave-delay', `${delay.toFixed(3)}s`)
    }

    body.createEl('p', {
      text: this.processLabel || 'Processing…',
      cls: 'igggy-rv-hint',
    })
  }

  // ── Error ──────────────────────────────────────────────────────────────────

  private renderError(body: HTMLElement): void {
    body.createEl('p', { text: this.errorMsg, cls: 'igggy-rv-error' })
    body.createEl('button', { text: 'Try again', cls: 'igggy-rv-btn-secondary' })
      .addEventListener('click', () => this.transition('idle'))
  }

  // ── Canvas waveform (adapted from ui/waveform.ts) ──────────────────────────

  private startCanvasWaveform(container: HTMLElement): void {
    const analyser = this.session?.getAnalyserNode() ?? null

    // Fallback: show static bars if analyser is unavailable
    if (!analyser) {
      const barsDiv = container.createDiv({ cls: 'igggy-bars' })
      for (let i = 0; i < BAR_COUNT; i++) barsDiv.createDiv({ cls: 'bar' })
      return
    }

    const canvas = container.createEl('canvas', { cls: 'igggy-canvas' })
    canvas.width = BAR_COUNT * 5   // 5px per bar slot (3px bar + 2px gap)
    canvas.height = 36

    const ctx = canvas.getContext('2d')!
    const freqData = new Uint8Array(analyser.frequencyBinCount)
    const accentColor =
      getComputedStyle(document.body).getPropertyValue('--interactive-accent').trim() ||
      '#7c6df0'
    const hasRoundRect =
      typeof (ctx as unknown as { roundRect?: unknown }).roundRect === 'function'

    const recordingStartMs = Date.now()

    const draw = (): void => {
      this.rafId = requestAnimationFrame(draw)
      analyser.getByteFrequencyData(freqData)
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      for (let i = 0; i < BAR_COUNT; i++) {
        const binIndex = Math.floor((i / BAR_COUNT) * freqData.length)
        const normalized = freqData[binIndex] / 255
        const height = Math.max(3, Math.sqrt(normalized) * 32)
        const x = i * 5
        const y = (canvas.height - height) / 2

        ctx.fillStyle = accentColor
        ctx.beginPath()
        if (hasRoundRect) {
          ;(ctx as unknown as {
            roundRect(x: number, y: number, w: number, h: number, r: number): void
          }).roundRect(x, y, 3, height, 2)
        } else {
          ctx.rect(x, y, 3, height)
        }
        ctx.fill()
      }

      // Silence detection — only active after the initial delay AND when mic is not muted
      if (this.silenceWarningEl && Date.now() - recordingStartMs > SILENCE_DELAY_MS) {
        if (this.session?.isMuted()) {
          // User intentionally muted mic — don't warn about silence
          this.silenceWarningEl.toggleClass('igggy-hidden', true)
        } else {
          let maxVal = 0
          for (let i = 0; i < freqData.length; i++) {
            if (freqData[i] > maxVal) maxVal = freqData[i]
          }
          this.silenceWarningEl.toggleClass('igggy-hidden', maxVal >= SILENCE_THRESHOLD)
        }
      }
    }

    draw()
  }

  // ── Timer ──────────────────────────────────────────────────────────────────

  private startTimer(timerEl: HTMLElement): void {
    this.stopTimer()
    this.timerInterval = setInterval(() => {
      timerEl.textContent = this.formatSec(this.session?.getElapsedSec() ?? 0)
    }, 250)
  }

  private stopTimer(): void {
    if (this.timerInterval !== null) {
      clearInterval(this.timerInterval)
      this.timerInterval = null
    }
  }

  // ── Action handlers ────────────────────────────────────────────────────────

  private async handleStart(): Promise<void> {
    const keyError = validateKeys(this.plugin)
    if (keyError) {
      new Notice(keyError, 6000)
      return
    }

    this.transition('requesting')

    // Derive mode from persisted setting (mic-only or mic + system audio)
    this.recordingMode = this.plugin.settings.includeSystemAudio ? 'both' : 'mic'

    // Acquire audio source(s) based on selected mode
    let session: RecordingSession
    try {
      session = await RecordingSession.create(this.recordingMode)
    } catch (err) {
      // User dismissed the screen picker — return to idle silently (not an error)
      if (err instanceof PickerCancelledError) {
        this.transition('idle')
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('No audio was shared')) {
        this.errorMsg = msg
      } else if (msg.includes('NotAllowed') || msg.includes('Permission denied')) {
        this.errorMsg = this.recordingMode === 'both'
          ? 'Screen recording access denied — allow access in System Settings then restart Obsidian.'
          : 'Microphone access denied — allow access and try again.'
      } else if (msg.includes('NotFound') || msg.includes('not found')) {
        this.errorMsg = 'No microphone found — connect one and try again.'
      } else {
        this.errorMsg = `Could not start recording — ${msg}`
      }
      this.transition('error')
      return
    }

    // Create placeholder note and open it before recording starts
    let placeholderFile: TFile
    try {
      placeholderFile = await createRecordingPlaceholder(
        this.plugin.app,
        this.plugin.settings.outputFolder
      )
      await this.plugin.app.workspace.getLeaf(false).openFile(placeholderFile)
    } catch (err) {
      console.error('[Igggy] Failed to create recording placeholder:', err)
      new Notice('Failed to create note file — check your output folder setting.', 6000)
      await session.stop()
      this.transition('idle')
      return
    }

    this.session = session
    this.placeholderFile = placeholderFile

    // Sync plugin state so existing command-palette commands remain functional
    this.plugin.activeRecording = session
    this.plugin.recordingPlaceholder = placeholderFile

    session.start()
    this.transition('recording')
  }

  private handlePause(): void {
    if (!this.session || !this.placeholderFile) return
    this.session.pause()
    void setRecordingState(this.plugin.app, this.placeholderFile, 'paused')
    this.stopTimer()
    cancelAnimationFrame(this.rafId)
    this.silenceWarningEl = null  // cleared on transition; paused state has no warning
    this.transition('paused')
  }

  private handleResume(): void {
    if (!this.session || !this.placeholderFile) return
    this.session.resume()
    void setRecordingState(this.plugin.app, this.placeholderFile, 'recording')
    this.transition('recording')
  }

  private async handleStop(): Promise<void> {
    if (!this.session || !this.placeholderFile) return
    this.stopTimer()
    cancelAnimationFrame(this.rafId)
    this.silenceWarningEl = null  // cleared on stop; stopped state has no warning

    this.finalElapsed = this.session.getElapsedSec()
    this.capturedAt = new Date()

    this.blob = await this.session.stop()
    this.session = null
    this.plugin.activeRecording = null
    // Keep plugin.recordingPlaceholder — handleProcess reads it via this.placeholderFile

    this.transition('stopped')
  }

  private async handleProcess(): Promise<void> {
    if (!this.blob || !this.placeholderFile) return

    const file = this.placeholderFile
    await transitionToProcessing(this.plugin.app, file)

    const buffer = await this.blob.arrayBuffer()
    const ext = RecordingSession.getExtension(this.blob.type)
    const filename = `igggy-recording-${Date.now()}.${ext}`
    const date = new Date().toISOString().slice(0, 10)
    const capturedAt = this.capturedAt ?? new Date()

    // Clear before transitioning so stale refs can't be reused
    this.blob = null
    this.placeholderFile = null
    this.plugin.recordingPlaceholder = null
    this.processLabel = 'Processing…'
    this.transition('processing')

    try {
      await runProcessingPipeline(
        this.plugin,
        file,
        buffer,
        filename,
        date,
        capturedAt,
        '🎙️ Recording ready ✓',
        undefined,
        false
      )
    } catch (err) {
      this.errorMsg = err instanceof Error ? err.message : 'Processing failed'
      this.transition('error')
      return
    }

    this.transition('idle')
  }

  private async handleDiscardConfirmed(): Promise<void> {
    // Trash the placeholder note (system trash — recoverable)
    const file = this.placeholderFile
    this.blob = null
    this.placeholderFile = null
    this.plugin.recordingPlaceholder = null
    if (file) {
      try {
        await this.plugin.app.fileManager.trashFile(file)
      } catch {
        // File may have already been removed — ignore
      }
    }
    this.transition('idle')
  }

  // ── State transition ───────────────────────────────────────────────────────

  private transition(next: ViewState): void {
    this.state = next
    const root = this.containerEl.children[1] as HTMLElement
    // Update only the body to avoid losing the header on rapid transitions
    const body = root.querySelector<HTMLElement>('.igggy-rv-body')
    if (body) {
      this.renderBody(body)
    } else {
      this.render()
    }
  }

  // ── Format helpers ─────────────────────────────────────────────────────────

  private formatSec(totalSec: number): string {
    const sec = Math.floor(totalSec)
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
  }

  private formatDuration(sec: number): string {
    const s = Math.floor(sec)
    const m = Math.floor(s / 60)
    const r = s % 60
    if (m === 0) return `${r} sec`
    return r === 0 ? `${m} min` : `${m} min ${r} sec`
  }
}
