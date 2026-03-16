import { Notice, Plugin, TFile } from 'obsidian'
import { type IgggySettings, DEFAULT_SETTINGS } from './settings'
import { IgggySettingsTab } from './settings-tab'
import {
  registerCommands,
  registerMenus,
  validateKeys,
  runProcessingPipeline,
} from './commands'
import { RecordingSession } from './recording/session'
import { createRecordingPlaceholder } from './notes/writer'
import { RECORDING_VIEW_TYPE, RecordingView } from './ui/recording-view'
import { pullFromCloud, drainPendingSyncs } from './sync/pull'

const PULL_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

export default class IgggyPlugin extends Plugin {
  settings!: IgggySettings

  // ── Recording state ──────────────────────────────────────────────────────────
  activeRecording: RecordingSession | null = null
  recordingPlaceholder: TFile | null = null
  private statusBarEl: HTMLElement | null = null
  private statusBarInterval: ReturnType<typeof setInterval> | null = null
  private pullSyncInterval: ReturnType<typeof setInterval> | null = null

  async onload(): Promise<void> {
    await this.loadSettings()

    // ── Recording View (sidebar panel) ───────────────────────────────────────────
    this.registerView(
      RECORDING_VIEW_TYPE,
      (leaf) => new RecordingView(leaf, this)
    )

    // ── Ribbon icon ─────────────────────────────────────────────────────────────
    this.addRibbonIcon('audio-waveform', 'Open Igggy recording panel', () =>
      void this.activateRecordingView()
    )

    // ── Status bar (hidden until recording starts) ────────────────────────────────
    this.statusBarEl = this.addStatusBarItem()

    // ── File processing commands ──────────────────────────────────────────────────
    registerCommands(this)
    registerMenus(this)

    // ── Recording commands ────────────────────────────────────────────────────────
    this.addCommand({
      id: 'start-recording',
      name: 'Start recording',
      callback: () => { void this.startRecording() },
    })

    this.addCommand({
      id: 'pause-resume-recording',
      name: 'Pause / resume recording',
      checkCallback: (checking: boolean) => {
        if (!this.activeRecording) return false
        if (!checking) this.pauseResumeRecording()
        return true
      },
    })

    this.addCommand({
      id: 'stop-and-process',
      name: 'Stop recording and process',
      checkCallback: (checking: boolean) => {
        if (!this.activeRecording) return false
        if (!checking) { void this.stopAndProcess() }
        return true
      },
    })

    this.addSettingTab(new IgggySettingsTab(this.app, this))

    // ── Pull sync (Starter/Pro with cloud backup) ──────────────────────────────
    // Initial pull after a short delay to let the vault index settle
    setTimeout(() => {
      void drainPendingSyncs(this).then(() => pullFromCloud(this))
    }, 3000)

    // Periodic pull every 5 minutes
    this.pullSyncInterval = setInterval(() => {
      void drainPendingSyncs(this).then(() => pullFromCloud(this))
    }, PULL_INTERVAL_MS)

    console.debug('[Igggy] Plugin loaded')
  }

  onunload(): void {
    // Release microphone if the plugin is disabled mid-recording
    if (this.activeRecording) {
      void this.activeRecording.stop()
      this.activeRecording = null
    }
    // Stop pull sync interval
    if (this.pullSyncInterval !== null) {
      clearInterval(this.pullSyncInterval)
      this.pullSyncInterval = null
    }
    this.clearStatusBar()
    console.debug('[Igggy] Plugin unloaded')
  }

  // ── Recording View ────────────────────────────────────────────────────────────

  async activateRecordingView(): Promise<void> {
    const { workspace } = this.app
    let leaf = workspace.getLeavesOfType(RECORDING_VIEW_TYPE)[0]
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(false)
      await leaf.setViewState({ type: RECORDING_VIEW_TYPE, active: true })
    }
    void workspace.revealLeaf(leaf)
  }

  async loadSettings(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw: any = await this.loadData()

    // Migrate legacy plan names (pre-1.1)
    if (raw) {
      if (raw.mode === 'byok') raw.mode = 'open'
      if (raw.mode === 'hosted') raw.mode = 'starter'
      if ('hostedAccessToken' in raw) {
        raw.accessToken = raw.hostedAccessToken
        raw.refreshToken = raw.hostedRefreshToken
        raw.tokenExpiry = raw.hostedTokenExpiry
        delete raw.hostedAccessToken
        delete raw.hostedRefreshToken
        delete raw.hostedTokenExpiry
      }
    }

    this.settings = Object.assign({}, DEFAULT_SETTINGS, raw)
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
  }

  // ── Recording actions ─────────────────────────────────────────────────────────

  private async startRecording(): Promise<void> {
    if (this.activeRecording) {
      new Notice('A recording is already in progress.', 4000)
      return
    }

    const keyError = validateKeys(this)
    if (keyError) {
      new Notice(keyError, 6000)
      return
    }

    // Request microphone access — may throw NotAllowedError or NotFoundError
    let session: RecordingSession
    try {
      session = await RecordingSession.create()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('NotAllowedError') || message.includes('Permission denied')) {
        new Notice('Microphone access denied — allow microphone access and try again.', 6000)
      } else if (message.includes('NotFoundError') || message.includes('not found')) {
        new Notice('No microphone found — connect a microphone and try again.', 6000)
      } else {
        new Notice(`Igggy: Could not start recording \u2014 ${message}`, 6000)
      }
      return
    }

    // Create placeholder note and open it before recording starts
    let placeholderFile: TFile
    try {
      placeholderFile = await createRecordingPlaceholder(this.app, this.settings.outputFolder)
      await this.app.workspace.getLeaf(false).openFile(placeholderFile)
    } catch (err) {
      console.error('[Igggy] Failed to create recording placeholder:', err)
      new Notice('Failed to create note file — check your output folder setting.', 6000)
      await session.stop()
      return
    }

    this.activeRecording = session
    this.recordingPlaceholder = placeholderFile
    session.start()

    // Start status bar timer
    this.statusBarEl?.setText('\uD83C\uDF99\uFE0F 0:00')
    this.statusBarInterval = setInterval(() => {
      const elapsed = this.activeRecording?.getElapsedSec() ?? 0
      this.statusBarEl?.setText(`\uD83C\uDF99\uFE0F ${formatElapsed(elapsed)}`)
    }, 500)
  }

  private pauseResumeRecording(): void {
    if (!this.activeRecording || !this.recordingPlaceholder) return

    const state = this.activeRecording.getState()

    if (state === 'recording') {
      this.activeRecording.pause()
      // Show frozen time with pause icon; stop updating while paused
      const elapsed = this.activeRecording.getElapsedSec()
      this.statusBarEl?.setText(`\u23F8 ${formatElapsed(elapsed)}`)
      this.clearStatusBarInterval()
    } else if (state === 'paused') {
      this.activeRecording.resume()
      // Resume live timer
      this.statusBarEl?.setText(`\uD83C\uDF99\uFE0F ${formatElapsed(this.activeRecording.getElapsedSec())}`)
      this.statusBarInterval = setInterval(() => {
        const elapsed = this.activeRecording?.getElapsedSec() ?? 0
        this.statusBarEl?.setText(`\uD83C\uDF99\uFE0F ${formatElapsed(elapsed)}`)
      }, 500)
    }
  }

  private async stopAndProcess(): Promise<void> {
    if (!this.activeRecording || !this.recordingPlaceholder) return

    const session = this.activeRecording
    const file = this.recordingPlaceholder

    // Clear state immediately so checkCallbacks disable the commands
    this.activeRecording = null
    this.recordingPlaceholder = null
    this.clearStatusBar()

    // Stop recording and release the microphone
    const blob = await session.stop()

    const buffer = await blob.arrayBuffer()
    const ext = RecordingSession.getExtension(blob.type)
    const filename = `igggy-recording-${Date.now()}.${ext}`
    const date = new Date().toISOString().slice(0, 10)
    const capturedAt = new Date()

    await runProcessingPipeline(
      this,
      file,
      buffer,
      filename,
      date,
      capturedAt,
      '\uD83C\uDF99\uFE0F Recording ready \u2713',
      undefined,
      false
    )
  }

  // ── Status bar helpers ────────────────────────────────────────────────────────

  /** Update the status bar with a processing stage message. Pass empty string to clear. */
  setStatusText(text: string): void {
    this.statusBarEl?.setText(text)
  }

  private clearStatusBarInterval(): void {
    if (this.statusBarInterval !== null) {
      clearInterval(this.statusBarInterval)
      this.statusBarInterval = null
    }
  }

  private clearStatusBar(): void {
    this.clearStatusBarInterval()
    this.statusBarEl?.setText('')
  }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

function formatElapsed(totalSec: number): string {
  const sec = Math.floor(totalSec)
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}
