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

import { ItemView, Notice, WorkspaceLeaf, setIcon, setTooltip } from 'obsidian'
import type { TFile } from 'obsidian'
import type IgggyPlugin from '../main'
import { RecordingSession, PickerCancelledError, type RecordingMode, type SystemAudioOptions } from '../recording/session'
import { NativeAudioCapture } from '../recording/native-audio'
import {
  validateKeys,
  openSystemAudioFilePicker,
  runProcessingPipeline,
} from '../commands'
import { createRecordingPlaceholder } from '../notes/writer'
import { CUSTOM_INSTRUCTIONS } from '../feature-flags'

// ── Constants ─────────────────────────────────────────────────────────────────

export const RECORDING_VIEW_TYPE = 'igggy-recording'

/** Create a button with an Obsidian icon + text label + optional native tooltip */
function iconButton(parent: HTMLElement, icon: string, text: string, cls: string, tooltip?: string): HTMLButtonElement {
  const btn = parent.createEl('button', { cls })
  setIcon(btn, icon)
  btn.appendText(` ${text}`)
  if (tooltip) setTooltip(btn, tooltip)
  return btn
}

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
  private customPrompt = ''

  // ── Active handles (cancelled in onClose) ──────────────────────────────────
  private timerInterval: ReturnType<typeof setInterval> | null = null
  private rafId = 0

  constructor(leaf: WorkspaceLeaf, plugin: IgggyPlugin) {
    super(leaf)
    this.plugin = plugin
  }

  // ── ItemView interface ─────────────────────────────────────────────────────

  getViewType(): string { return RECORDING_VIEW_TYPE }
  getDisplayText(): string { return 'Igggy recording' }
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

    const btn = iconButton(body, 'mic', 'Start recording', 'igggy-rv-btn-primary', 'Start recording')
    btn.disabled = !!keyError
    btn.addEventListener('click', () => { void this.handleStart() })
    body.createEl('p', { text: 'Record audio from your microphone', cls: 'igggy-rv-btn-desc' })

    // ── System audio toggle ───────────────────────────────────────────────────

    const systemAudioSupport = NativeAudioCapture.isSupported()

    const toggleRow = body.createDiv({ cls: 'igggy-rv-toggle-row' })
    const checkbox = toggleRow.createEl('input', { cls: 'igggy-rv-toggle-checkbox' })
    checkbox.type = 'checkbox'
    checkbox.id = 'igggy-system-audio'
    const toggleLabel = toggleRow.createEl('label', { text: 'Include speaker audio' })
    toggleLabel.htmlFor = 'igggy-system-audio'
    const infoIcon = toggleLabel.createEl('span', { cls: 'igggy-rv-toggle-info' })
    setIcon(infoIcon, 'info')
    setTooltip(infoIcon, 'Records audio playing through your speakers or headphones — meeting calls, videos, music, etc.')

    if (systemAudioSupport.supported) {
      checkbox.checked = this.plugin.settings.includeSystemAudio
    } else {
      checkbox.checked = false
      checkbox.disabled = true
      toggleRow.style.opacity = '0.5'
      setTooltip(toggleRow, systemAudioSupport.reason ?? 'Speaker audio capture is not available on this system.')
    }

    const hintEl = body.createEl('p', {
      text: 'System audio will be captured automatically when recording starts.',
      cls: 'igggy-rv-source-hint',
    })
    hintEl.toggleClass('igggy-hidden', !checkbox.checked)

    checkbox.addEventListener('change', () => {
      this.plugin.settings.includeSystemAudio = checkbox.checked
      void this.plugin.saveSettings()
      hintEl.toggleClass('igggy-hidden', !checkbox.checked)
    })

    // Custom prompt — optional instructions for the AI (set before recording)
    if (CUSTOM_INSTRUCTIONS) {
      const promptContainer = body.createDiv({ cls: 'igggy-rv-custom-prompt' })
      promptContainer.createEl('label', {
        text: 'Custom instructions (optional)',
        cls: 'igggy-rv-custom-prompt-label',
      })
      const promptTextarea = promptContainer.createEl('textarea', {
        placeholder: 'What do you want from this note?',
        cls: 'igggy-rv-custom-prompt-input',
      })
      promptTextarea.rows = 2
      promptTextarea.value = this.customPrompt
      promptTextarea.addEventListener('input', () => {
        this.customPrompt = promptTextarea.value
      })
    }

    body.createDiv({ cls: 'igggy-rv-divider' }).createEl('span', { text: 'or' })

    iconButton(body, 'upload', 'From file…', 'igggy-rv-btn-secondary', 'Process an audio file')
      .addEventListener('click', () => { openSystemAudioFilePicker(this.plugin) })
    body.createEl('p', { text: 'Process an audio file into an AI note', cls: 'igggy-rv-btn-desc' })
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
      cls: 'igggy-rv-warning igggy-hidden',
    })

    const footer = body.createDiv({ cls: 'igggy-rv-waveform-footer' })
    const timerEl = footer.createSpan({ cls: 'igggy-rv-timer', text: '0:00' })
    footer.createSpan({ cls: 'igggy-rv-waveform-label', text: '● recording' })
    this.startTimer(timerEl)

    const controls = body.createDiv({ cls: 'igggy-rv-controls' })

    // Mute toggle — only shown when a mic stream is active ('mic' or 'both' modes)
    if (this.session?.hasMic()) {
      const muteBtn = iconButton(controls, 'mic', 'Mute', 'igggy-rv-btn-secondary', 'Mute microphone')
      muteBtn.addEventListener('click', () => {
        if (this.session?.isMuted()) {
          this.session.unmute()
          muteBtn.empty()
          setIcon(muteBtn, 'mic')
          muteBtn.appendText(' Mute')
          setTooltip(muteBtn, 'Mute microphone')
        } else {
          this.session?.mute()
          muteBtn.empty()
          setIcon(muteBtn, 'mic-off')
          muteBtn.appendText(' Unmute')
          setTooltip(muteBtn, 'Unmute microphone')
        }
      })
    }

    iconButton(controls, 'pause', 'Pause', 'igggy-rv-btn-secondary', 'Pause recording')
      .addEventListener('click', () => this.handlePause())
    iconButton(controls, 'square', 'Finish', 'igggy-rv-btn-primary', 'Finish recording')
      .addEventListener('click', () => { void this.handleStop() })
  }

  // ── Paused ─────────────────────────────────────────────────────────────────

  private renderPaused(body: HTMLElement): void {
    // Flat bars reuse existing .igggy-waveform.paused styles from styles.css
    const waveformEl = body.createDiv({ cls: 'igggy-rv-waveform igggy-waveform paused' })
    const barsDiv = waveformEl.createDiv({ cls: 'igggy-bars' })
    const pausedBarCount = Math.floor((body.clientWidth || BAR_COUNT * 5) / 5)
    for (let i = 0; i < pausedBarCount; i++) barsDiv.createDiv({ cls: 'bar' })

    const footer = body.createDiv({ cls: 'igggy-rv-waveform-footer' })
    const timerEl = footer.createSpan({ cls: 'igggy-rv-timer' })
    timerEl.textContent = this.formatSec(this.session?.getElapsedSec() ?? 0)
    footer.createSpan({ cls: 'igggy-rv-waveform-label', text: '⏸ paused' })
    // Timer updates so the frozen time is accurate at the moment of resume
    this.startTimer(timerEl)

    const controls = body.createDiv({ cls: 'igggy-rv-controls' })
    iconButton(controls, 'play', 'Resume', 'igggy-rv-btn-secondary', 'Resume recording')
      .addEventListener('click', () => this.handleResume())
    iconButton(controls, 'square', 'Finish', 'igggy-rv-btn-primary', 'Finish recording')
      .addEventListener('click', () => { void this.handleStop() })
  }

  // ── Stopped (confirm step — legacy, skipped by auto-process) ─────────────

  private renderStopped(body: HTMLElement): void {
    const summary = body.createDiv({ cls: 'igggy-rv-summary' })
    summary.createEl('p', { text: 'Recording complete', cls: 'igggy-rv-summary-title' })

    const detail = this.capturedAt
      ? `${this.formatDuration(this.finalElapsed)} · ${
          this.capturedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        }`
      : this.formatDuration(this.finalElapsed)
    summary.createEl('p', { text: detail, cls: 'igggy-rv-summary-detail' })

    // Custom prompt textarea — optional instructions for the AI
    if (CUSTOM_INSTRUCTIONS) {
      const promptContainer = body.createDiv({ cls: 'igggy-rv-custom-prompt' })
      const promptTextarea = promptContainer.createEl('textarea', {
        placeholder: 'What do you want from this note? (optional)',
        cls: 'igggy-rv-custom-prompt-input',
      })
      promptTextarea.rows = 2
      promptTextarea.value = this.customPrompt
      promptTextarea.addEventListener('input', () => {
        this.customPrompt = promptTextarea.value
      })
    }

    const controls = body.createDiv({ cls: 'igggy-rv-controls' })
    iconButton(controls, 'trash-2', 'Delete recording', 'igggy-rv-btn-secondary')
      .addEventListener('click', () => this.transition('confirming_delete'))
    iconButton(controls, 'file-plus', 'Create note', 'igggy-rv-btn-primary')
      .addEventListener('click', () => { void this.handleProcess() })
  }

  // ── Confirming delete ──────────────────────────────────────────────────────

  private renderConfirmingDelete(body: HTMLElement): void {
    const summary = body.createDiv({ cls: 'igggy-rv-summary' })
    summary.createEl('p', { text: 'Delete this recording?', cls: 'igggy-rv-summary-title' })
    summary.createEl('p', { text: 'The note draft will also be removed.', cls: 'igggy-rv-summary-detail' })

    const controls = body.createDiv({ cls: 'igggy-rv-controls' })
    iconButton(controls, 'x', 'Cancel', 'igggy-rv-btn-secondary')
      .addEventListener('click', () => this.transition('stopped'))
    iconButton(controls, 'trash-2', 'Delete', 'igggy-rv-btn-primary')
      .addEventListener('click', () => { void this.handleDiscardConfirmed() })
  }

  // ── Processing ─────────────────────────────────────────────────────────────

  private renderProcessing(body: HTMLElement): void {
    // Rolling sine-wave animation reuses .igggy-waveform.processing styles
    const waveformEl = body.createDiv({ cls: 'igggy-rv-waveform igggy-waveform processing' })
    const barsDiv = waveformEl.createDiv({ cls: 'igggy-bars' })
    const procBarCount = Math.floor((body.clientWidth || BAR_COUNT * 5) / 5)
    for (let i = 0; i < procBarCount; i++) {
      const bar = barsDiv.createDiv({ cls: 'bar' })
      const delay = -(i / Math.max(procBarCount - 1, 1)) * 2.8
      bar.style.setProperty('--wave-delay', `${delay.toFixed(3)}s`)
      // Organic height variation — deterministic per bar (18–28px range)
      const t = Math.sin(i * 1.7 + 0.3) * 0.5 + 0.5
      bar.style.setProperty('--wave-peak', `${Math.round(18 + t * 10)}px`)
    }

    body.createEl('p', {
      text: this.processLabel || 'Processing…',
      cls: 'igggy-rv-hint',
    })

    // Cancel button — shows confirmation before discarding
    const cancelBtn = iconButton(body, 'trash-2', 'Cancel recording', 'igggy-rv-btn-secondary', 'Cancel recording')
    cancelBtn.addEventListener('click', () => {
      // Replace cancel button with confirmation choices
      cancelBtn.remove()
      const confirmMsg = body.createEl('p', {
        text: 'Delete the recording and its note?',
        cls: 'igggy-rv-hint',
      })
      const controls = body.createDiv({ cls: 'igggy-rv-controls' })
      iconButton(controls, 'file-check', 'Keep note', 'igggy-rv-btn-secondary')
        .addEventListener('click', () => { void this.handleCancelKeepNote() })
      iconButton(controls, 'trash-2', 'Delete both', 'igggy-rv-btn-primary')
        .addEventListener('click', () => { void this.handleDiscardConfirmed() })
    })
  }

  // ── Error ──────────────────────────────────────────────────────────────────

  private renderError(body: HTMLElement): void {
    body.createEl('p', { text: this.errorMsg, cls: 'igggy-rv-error' })
    iconButton(body, 'rotate-ccw', 'Try again', 'igggy-rv-btn-secondary')
      .addEventListener('click', () => this.transition('idle'))
  }

  // ── Canvas waveform (adapted from ui/waveform.ts) ──────────────────────────

  private startCanvasWaveform(container: HTMLElement): void {
    const analyser = this.session?.getAnalyserNode() ?? null

    // Fallback: show static bars if analyser is unavailable
    if (!analyser) {
      const fallbackBarCount = Math.floor((container.clientWidth || BAR_COUNT * 5) / 5)
      const barsDiv = container.createDiv({ cls: 'igggy-bars' })
      for (let i = 0; i < fallbackBarCount; i++) barsDiv.createDiv({ cls: 'bar' })
      return
    }

    const canvas = container.createEl('canvas', { cls: 'igggy-canvas' })
    const canvasWidth = container.clientWidth || BAR_COUNT * 5
    canvas.width = canvasWidth
    canvas.height = 36
    const barCount = Math.floor(canvasWidth / 5)

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

      for (let i = 0; i < barCount; i++) {
        const binIndex = Math.floor((i / barCount) * freqData.length)
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

    // Build system audio options if needed (native binary path)
    let systemOpts: SystemAudioOptions | undefined
    if (this.recordingMode === 'both') {
      const nativeBinaryPath = this.plugin.settings.nativeAudioPath
        || this.getDefaultBinaryPath()
      systemOpts = { binaryPath: nativeBinaryPath }
    }

    // Acquire audio source(s) based on selected mode
    let session: RecordingSession
    try {
      session = await RecordingSession.create(this.recordingMode, systemOpts)
    } catch (err) {
      // User dismissed the screen picker — return to idle silently (not an error)
      if (err instanceof PickerCancelledError) {
        this.transition('idle')
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('No audio was shared')) {
        this.errorMsg = msg
      } else if (msg.includes('permission') || msg.includes('Permission denied') || msg.includes('NotAllowed')) {
        this.errorMsg = this.recordingMode === 'mic'
          ? 'Microphone access denied — allow access and try again.'
          : msg
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
    this.stopTimer()
    cancelAnimationFrame(this.rafId)
    this.silenceWarningEl = null  // cleared on transition; paused state has no warning
    this.transition('paused')
  }

  private handleResume(): void {
    if (!this.session || !this.placeholderFile) return
    this.session.resume()
    this.transition('recording')
  }

  private async handleStop(): Promise<void> {
    if (!this.session || !this.placeholderFile) return
    this.stopTimer()
    cancelAnimationFrame(this.rafId)
    this.silenceWarningEl = null  // cleared on stop; stopped state has no warning

    this.finalElapsed = this.session.getElapsedSec()
    this.capturedAt = new Date()

    try {
      this.blob = await this.session.stop()
    } catch (err) {
      console.error('[Igggy] Failed to stop recording session:', err)
      this.session = null
      this.plugin.activeRecording = null
      this.errorMsg = 'Recording failed to stop — please try again'
      this.transition('error')
      return
    }

    this.session = null
    this.plugin.activeRecording = null
    // Keep plugin.recordingPlaceholder — handleProcess reads it via this.placeholderFile

    // Auto-process: skip confirm step, start processing immediately
    void this.handleProcess()
  }

  private async handleProcess(): Promise<void> {
    if (!this.blob || !this.placeholderFile) return

    const file = this.placeholderFile

    let buffer: ArrayBuffer
    try {
      buffer = await this.blob.arrayBuffer()
    } catch (err) {
      console.error('[Igggy] Failed to prepare recording for processing:', err)
      this.blob = null
      this.placeholderFile = null
      this.plugin.recordingPlaceholder = null
      this.errorMsg = 'Failed to prepare recording — please try again'
      this.transition('error')
      return
    }

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

    const promptForPipeline = this.customPrompt.trim() || undefined

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
        false,
        promptForPipeline
      )
    } catch (err) {
      this.errorMsg = err instanceof Error ? err.message : 'Processing failed'
      this.transition('error')
      return
    }

    this.customPrompt = ''
    this.transition('idle')
  }

  private async handleDiscardConfirmed(): Promise<void> {
    // Trash the placeholder note (system trash — recoverable)
    const file = this.placeholderFile
    this.blob = null
    this.placeholderFile = null
    this.customPrompt = ''
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

  private handleCancelKeepNote(): void {
    // Cancel processing but keep the placeholder note in the vault
    this.blob = null
    this.placeholderFile = null
    this.customPrompt = ''
    this.plugin.recordingPlaceholder = null
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

  // ── Native audio helpers ───────────────────────────────────────────────────

  /** Returns the default path for the native audio binary in the plugin's data directory */
  private getDefaultBinaryPath(): string {
    const pluginDir = this.plugin.manifest.dir
    if (!pluginDir) return ''
    const vaultPath = (this.plugin.app.vault.adapter as { basePath?: string }).basePath ?? ''
    const platform = process.platform
    const binaryName = platform === 'win32' ? 'audiotee-wasapi.exe' : 'audiotee'
    return `${vaultPath}/${pluginDir}/native/${binaryName}`
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
