import { App, PluginSettingTab, Setting, AbstractInputSuggest, TFolder } from 'obsidian'
import type IgggyPlugin from './main'
import { reindexVault } from './sync/reindex'
import { TASKS_ENABLED } from './feature-flags'

// ── Vault folder suggest ──────────────────────────────────────────────────────

/**
 * Input suggest that shows all vault folders on focus and filters as you type.
 * Standard Obsidian pattern used by Templater, Daily Notes, etc.
 */
class FolderSuggest extends AbstractInputSuggest<TFolder> {
  getSuggestions(query: string): TFolder[] {
    const folders = this.app.vault.getAllLoadedFiles()
      .filter((f): f is TFolder => f instanceof TFolder)
      .filter((f) => f.path !== '/') // exclude vault root
      .sort((a, b) => a.path.localeCompare(b.path))

    if (!query) return folders
    const lower = query.toLowerCase()
    return folders.filter((f) => f.path.toLowerCase().includes(lower))
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path)
  }

  selectSuggestion(folder: TFolder): void {
    this.setValue(folder.path)
    this.close()
  }
}

const APP_URL = 'https://app.igggy.ai'

// ── Format validators ─────────────────────────────────────────────────────────

function validateOpenAIKey(value: string): string | null {
  if (!value.startsWith('sk-') || value.length < 40) {
    return "This doesn't look like a valid OpenAI key — should start with sk- and be 40+ characters."
  }
  return null
}

function validateDeepgramKey(value: string): string | null {
  if (value.length < 32) {
    return "This doesn't look like a valid Deepgram key — should be 32+ characters."
  }
  return null
}

function validateAnthropicKey(value: string): string | null {
  if (!value.startsWith('sk-ant-') || value.length < 40) {
    return "This doesn't look like a valid Anthropic key — should start with sk-ant- and be 40+ characters."
  }
  return null
}

function sanitizeFolder(value: string): string {
  const sanitized = value.trim().replace(/^\/+/, '').replace(/\.\.\//g, '').replace(/\.\.$/, '')
  return sanitized || 'Igggy'
}

/** Decode email from a Supabase JWT access token. Returns null on any error. */
function decodeEmail(token: string): string | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]))
    return typeof payload?.email === 'string' ? payload.email : null
  } catch {
    return null
  }
}

// ── Confirmable field config ──────────────────────────────────────────────────

interface ConfirmableFieldConfig {
  name: string
  desc: string
  settingsKey: keyof IgggyPlugin['settings']
  isPassword: boolean
  placeholder: string
  validate?: (value: string) => string | null
  sanitize?: (value: string) => string
  /** Attach vault folder suggest to the text input (shows all folders on focus, filters on type) */
  folderSuggest?: boolean
}

export class IgggySettingsTab extends PluginSettingTab {
  plugin: IgggyPlugin

  constructor(app: App, plugin: IgggyPlugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  /**
   * Renders a setting field with explicit edit → save → confirm flow.
   *
   * Three states:
   * - Empty: editable input + Save button (first-time setup)
   * - Display: shows current value (masked for passwords) + Edit button
   * - Editing: input + Save + Cancel buttons
   */
  private addConfirmableField(containerEl: HTMLElement, config: ConfirmableFieldConfig): void {
    const currentValue = this.plugin.settings[config.settingsKey] as string
    const hasValue = !!currentValue

    const setting = new Setting(containerEl)
      .setName(config.name)
      .setDesc(config.desc)

    if (!hasValue) {
      // ── Empty state: show input + Save directly ─────────────────────
      let inputValue = ''

      setting.addText((text) => {
        if (config.isPassword) text.inputEl.type = 'password'
        text.setPlaceholder(config.placeholder)
        text.onChange((value) => { inputValue = value })
        if (config.folderSuggest) new FolderSuggest(this.app, text.inputEl)
      })

      setting.addButton((btn) =>
        btn.setButtonText('Save').setCta().onClick(async () => {
          const trimmed = inputValue.trim()
          if (!trimmed) return
          const finalValue = config.sanitize ? config.sanitize(trimmed) : trimmed;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(this.plugin.settings as any)[config.settingsKey] = finalValue
          await this.plugin.saveSettings()

          // Show validation warning if applicable
          const warning = config.validate?.(finalValue)
          if (warning) {
            const warningEl = setting.descEl.createEl('div', {
              text: warning,
              cls: 'mod-warning',
            })
            warningEl.style.color = 'var(--text-warning)'
            warningEl.style.marginTop = '4px'
            warningEl.style.fontSize = '11px'
          }

          // Flash confirmation and rebuild
          this.showSavedConfirmation(setting, () => this.display())
        })
      )
    } else {
      // ── Display state: show value + Edit button ─────────────────────
      const displayValue = config.isPassword ? '••••••••' : currentValue

      setting.addText((text) => {
        text.setValue(displayValue)
        text.setDisabled(true)
        text.inputEl.style.opacity = '0.7'
      })

      setting.addButton((btn) =>
        btn.setButtonText('Edit').onClick(() => {
          // ── Edit state: replace with editable input + Save/Cancel ────
          setting.clear()
          setting.setName(config.name).setDesc(config.desc)

          let inputValue = ''
          setting.addText((text) => {
            if (config.isPassword) {
              text.inputEl.type = 'password'
              text.setPlaceholder('Paste new key')
            } else {
              text.setValue(currentValue)
              text.setPlaceholder(config.placeholder)
            }
            text.onChange((value) => { inputValue = value })
            // For non-password fields, initialize with current value
            if (!config.isPassword) inputValue = currentValue
            if (config.folderSuggest) new FolderSuggest(this.app, text.inputEl)
          })

          setting.addButton((saveBtn) =>
            saveBtn.setButtonText('Save').setCta().onClick(async () => {
              const trimmed = inputValue.trim()
              if (!trimmed) return
              const finalValue = config.sanitize ? config.sanitize(trimmed) : trimmed;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(this.plugin.settings as any)[config.settingsKey] = finalValue
              await this.plugin.saveSettings()

              const warning = config.validate?.(finalValue)
              if (warning) {
                const warningEl = setting.descEl.createEl('div', {
                  text: warning,
                  cls: 'mod-warning',
                })
                warningEl.style.color = 'var(--text-warning)'
                warningEl.style.marginTop = '4px'
                warningEl.style.fontSize = '11px'
              }

              this.showSavedConfirmation(setting, () => this.display())
            })
          )

          setting.addExtraButton((cancelBtn) =>
            cancelBtn
              .setIcon('cross')
              .setTooltip('Cancel')
              .onClick(() => this.display())
          )
        })
      )
    }
  }

  /** Flash "Saved ✓" on a setting, then call the callback */
  private showSavedConfirmation(setting: Setting, then: () => void): void {
    const el = setting.nameEl
    const original = el.textContent
    el.textContent = 'Saved ✓'
    el.style.color = 'var(--text-success)'
    setTimeout(() => {
      el.textContent = original
      el.style.color = ''
      then()
    }, 1500)
  }

  display(): void {
    const { containerEl } = this
    containerEl.empty()

    // ── Account (unified for all modes) ─────────────────────────────
    this.renderAccountSection(containerEl)

    // ── Connection mode ────────────────────────────────────────────
    new Setting(containerEl).setName('Connection mode').setHeading()

    new Setting(containerEl)
      .setName('Mode')
      .setDesc('Igggy Open: Use your own API keys. Starter/Pro: Managed keys.')
      .addDropdown((dd) => {
        dd
          .addOption('open', 'Igggy Open — bring your own keys')
          .addOption('starter', 'Igggy Starter')
          .addOption('pro', 'Igggy Pro')
          .setValue(this.plugin.settings.mode)
          .onChange(async (value) => {
            this.plugin.settings.mode = value as 'open' | 'starter' | 'pro'
            await this.plugin.saveSettings()
            this.display()
          })
      })

    // Render mode-specific sections
    if (['starter', 'pro'].includes(this.plugin.settings.mode)) {
      this.renderPaidSection(containerEl)
    } else {
      this.renderOpenSection(containerEl)
    }

    // ── Note summarization (always visible) ─────────────────────────
    new Setting(containerEl).setName('Note summarization').setHeading()

    new Setting(containerEl)
      .setName('Tone')
      .setDesc('Writing style for generated notes.')
      .addDropdown((dd) =>
        dd
          .addOption('professional', 'Professional')
          .addOption('casual', 'Casual')
          .setValue(this.plugin.settings.noteTone)
          .onChange(async (value) => {
            this.plugin.settings.noteTone = value as 'casual' | 'professional'
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl)
      .setName('Detail level')
      .setDesc('How thorough generated notes should be by default.')
      .addDropdown((dd) =>
        dd
          .addOption('concise', 'Concise — one bullet per point')
          .addOption('standard', 'Standard — balanced clarity and brevity')
          .addOption('detailed', 'Detailed — thorough with nuances and context')
          .setValue(this.plugin.settings.noteDensity)
          .onChange(async (value) => {
            this.plugin.settings.noteDensity = value as 'concise' | 'standard' | 'detailed'
            await this.plugin.saveSettings()
          })
      )

    // ── Output (always visible) ────────────────────────────────────
    new Setting(containerEl).setName('Output').setHeading()

    this.addConfirmableField(containerEl, {
      name: 'Output folder',
      desc: "Vault folder where notes are saved. Created automatically if it doesn't exist.",
      settingsKey: 'outputFolder',
      isPassword: false,
      placeholder: 'Igggy',
      sanitize: sanitizeFolder,
      folderSuggest: true,
    })

    new Setting(containerEl)
      .setName('Embed audio link in note')
      .setDesc('Igggy does not store your recordings — audio is permanently deleted after transcription. Enable this to embed a link to the original file at the top of each note.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.embedAudio).onChange(async (value) => {
          this.plugin.settings.embedAudio = value
          await this.plugin.saveSettings()
        })
      )

    if (TASKS_ENABLED) {
      new Setting(containerEl)
        .setName('Show tasks section in notes')
        .setDesc('Include the Tasks section in generated notes. Tasks are still extracted by the AI when disabled — they just won\'t appear in the note.')
        .addToggle((toggle) =>
          toggle.setValue(this.plugin.settings.showTasks).onChange(async (value) => {
            this.plugin.settings.showTasks = value
            await this.plugin.saveSettings()
          })
        )
    }

    // ── Sync ─────────────────────────────────────────────────────
    new Setting(containerEl).setName('Sync').setHeading()

    const hasAuth = !!this.plugin.settings.accessToken
    new Setting(containerEl)
      .setName('Sync status')
      .setDesc(
        hasAuth
          ? 'Sync is active \u2014 notes sync automatically every 5 minutes. New notes from the web app will appear in your vault.'
          : 'Sign in to enable cross-device sync. Notes created on the web app will sync to your vault automatically.'
      )

    const isPaidTier = ['starter', 'pro'].includes(this.plugin.settings.mode) && hasAuth

    const lastSyncText = this.plugin.settings.lastSyncedAt
      ? `Last synced ${new Date(this.plugin.settings.lastSyncedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
      : 'Never synced'

    new Setting(containerEl)
      .setName('Sync Now')
      .setDesc(
        isPaidTier
          ? `${lastSyncText} · Scans your vault and pushes all Igggy notes to the cloud DB. Starter/Pro only, limit once per hour.`
          : `${lastSyncText} · On-demand sync is available on Igggy Starter and Pro.`
      )
      .addButton((btn) => {
        btn.setButtonText('Sync Now')
        if (!isPaidTier) {
          btn.setDisabled(true)
          btn.buttonEl.title = 'On-demand sync is available on Igggy Starter and Pro'
          btn.buttonEl.style.opacity = '0.4'
          btn.buttonEl.style.cursor = 'not-allowed'
        } else {
          btn.onClick(() => {
            void reindexVault(this.plugin).then(() => this.display())
          })
        }
        return btn
      })
  }

  private renderAccountSection(containerEl: HTMLElement): void {
    const { settings } = this.plugin
    const isSignedIn = !!settings.accessToken

    new Setting(containerEl).setName('Account').setHeading()

    if (isSignedIn) {
      // ── Signed in state ───────────────────────────────────────────
      const email = decodeEmail(settings.accessToken)
      new Setting(containerEl)
        .setName(email ? `Connected — ${email}` : 'Connected')
        .setDesc('Your Igggy account is linked. Notes are stored and synced automatically.')
        .addButton((btn) =>
          btn.setButtonText('Sign out').onClick(async () => {
            this.plugin.settings.accessToken = ''
            this.plugin.settings.refreshToken = ''
            this.plugin.settings.tokenExpiry = 0
            await this.plugin.saveSettings()
            this.display()
          })
        )

      // Style the name green
      const nameEl = containerEl.querySelector('.setting-item:last-child .setting-item-name')
      if (nameEl instanceof HTMLElement) nameEl.style.color = 'var(--text-success)'
    } else {
      // ── Not signed in state ───────────────────────────────────────
      new Setting(containerEl)
        .setName('Sign in to start using Igggy')
        .setDesc('Your free account stores notes and enables cross-device sync.')
        .addButton((btn) =>
          btn.setButtonText('Sign in to Igggy').setCta().onClick(() => {
            window.open(`${APP_URL}/auth/plugin-callback`, '_blank')
          })
        )

      containerEl.createEl('p', {
        text: 'After signing in, copy the two tokens from the callback page and paste them below.',
        cls: 'setting-item-description',
      })

      // Access token — sanitize also decodes JWT expiry as a side effect
      this.addConfirmableField(containerEl, {
        name: 'Access token',
        desc: 'Paste the access token from the callback page.',
        settingsKey: 'accessToken',
        isPassword: true,
        placeholder: 'eyJ…',
        sanitize: (value) => {
          const trimmed = value.trim()
          // Decode expiry from JWT payload (exp is in seconds)
          try {
            const payload = JSON.parse(atob(trimmed.split('.')[1]))
            this.plugin.settings.tokenExpiry = typeof payload?.exp === 'number'
              ? payload.exp * 1000
              : 0
          } catch {
            this.plugin.settings.tokenExpiry = 0
          }
          return trimmed
        },
      })

      this.addConfirmableField(containerEl, {
        name: 'Refresh token',
        desc: 'Paste the refresh token from the callback page.',
        settingsKey: 'refreshToken',
        isPassword: true,
        placeholder: 'Paste refresh token',
      })
    }
  }

  private renderPaidSection(containerEl: HTMLElement): void {
    // Token fields are now in the Account section — Starter/Pro only needs
    // a note that managed keys are active (no API key fields needed)
    containerEl.createEl('p', {
      text: 'Managed keys are active — Igggy handles transcription and summarization for you.',
      cls: 'setting-item-description',
    })
  }

  private renderOpenSection(containerEl: HTMLElement): void {
    const { settings } = this.plugin
    const needsDeepgram = settings.transcriptionProvider === 'deepgram'
    const needsOpenAI = settings.transcriptionProvider === 'openai' || settings.summarizationProvider === 'openai'
    const needsAnthropic = settings.summarizationProvider === 'anthropic'

    // Setup path helper text
    containerEl.createEl('p', {
      text: needsDeepgram || needsAnthropic
        ? 'Using Deepgram + Anthropic for best quality (speaker detection + Claude Sonnet). Or switch both providers to OpenAI for a simpler single-key setup.'
        : 'Using OpenAI for both transcription and summarization — only one API key needed. For better quality with multi-speaker recordings, switch to Deepgram + Anthropic.',
      cls: 'setting-item-description',
    })

    // BYOK transparency note
    containerEl.createEl('p', {
      text: 'Your API keys are sent securely per-request and immediately discarded \u2014 never stored on our servers, never logged.',
      cls: 'setting-item-description',
    })

    // ── Transcription ──────────────────────────────────────────────
    new Setting(containerEl).setName('Transcription').setHeading()

    new Setting(containerEl)
      .setName('Provider')
      .setDesc('OpenAI Whisper works with just an OpenAI key. Deepgram adds speaker detection — after processing, you can name speakers in the note.')
      .addDropdown((dd) =>
        dd
          .addOption('openai', 'OpenAI Whisper')
          .addOption('deepgram', 'Deepgram Nova-3')
          .setValue(settings.transcriptionProvider)
          .onChange(async (value) => {
            this.plugin.settings.transcriptionProvider = value as 'openai' | 'deepgram'
            await this.plugin.saveSettings()
            this.display()
          })
      )

    // ── Summarization ──────────────────────────────────────────────
    new Setting(containerEl).setName('Summarization').setHeading()

    new Setting(containerEl)
      .setName('Provider')
      .setDesc('GPT-4o Mini works with your OpenAI key. Claude Sonnet delivers higher quality notes.')
      .addDropdown((dd) =>
        dd
          .addOption('openai', 'GPT-4o Mini')
          .addOption('anthropic', 'Claude Sonnet')
          .setValue(settings.summarizationProvider)
          .onChange(async (value) => {
            this.plugin.settings.summarizationProvider = value as 'openai' | 'anthropic'
            await this.plugin.saveSettings()
            this.display()
          })
      )

    // ── API keys (only show what's needed) ──────────────────────────
    new Setting(containerEl).setName('API keys').setHeading()

    if (needsOpenAI) {
      this.addConfirmableField(containerEl, {
        name: 'OpenAI API key',
        desc: needsDeepgram || needsAnthropic
          ? 'Used for GPT-4o summarization.'
          : 'Used for both Whisper transcription and GPT-4o summarization.',
        settingsKey: 'openaiKey',
        isPassword: true,
        placeholder: 'Paste your key',
        validate: validateOpenAIKey,
      })
    }

    if (needsDeepgram) {
      this.addConfirmableField(containerEl, {
        name: 'Deepgram API key',
        desc: 'Used for Nova-3 transcription with speaker detection.',
        settingsKey: 'deepgramKey',
        isPassword: true,
        placeholder: 'Paste your key',
        validate: validateDeepgramKey,
      })
    }

    if (needsAnthropic) {
      this.addConfirmableField(containerEl, {
        name: 'Anthropic API key',
        desc: 'Used for Claude Sonnet summarization.',
        settingsKey: 'anthropicKey',
        isPassword: true,
        placeholder: 'Paste your key',
        validate: validateAnthropicKey,
      })
    }
  }
}
