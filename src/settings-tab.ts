import { App, PluginSettingTab, Setting } from 'obsidian'
import type IgggyPlugin from './main'

const APP_URL = 'https://app.igggy.ai'

export class IgggySettingsTab extends PluginSettingTab {
  plugin: IgggyPlugin

  constructor(app: App, plugin: IgggyPlugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  display(): void {
    const { containerEl } = this
    containerEl.empty()

    // ── Connection mode ────────────────────────────────────────────
    new Setting(containerEl).setName('Connection mode').setHeading()

    new Setting(containerEl)
      .setName('Mode')
      .setDesc('BYOK: use your own API keys. Hosted: use Igggy\'s keys (requires account).')
      .addDropdown((dd) =>
        dd
          .addOption('byok', 'BYOK — bring your own keys')
          .addOption('hosted', 'Hosted — use Igggy\'s keys')
          .setValue(this.plugin.settings.mode)
          .onChange(async (value) => {
            this.plugin.settings.mode = value as 'byok' | 'hosted'
            await this.plugin.saveSettings()
            this.display() // re-render to show/hide sections
          })
      )

    if (this.plugin.settings.mode === 'hosted') {
      this.renderHostedSection(containerEl)
    } else {
      this.renderBYOKSection(containerEl)
    }

    // ── Output (always visible) ────────────────────────────────────
    new Setting(containerEl).setName('Output').setHeading()

    new Setting(containerEl)
      .setName('Output folder')
      .setDesc("Vault folder where notes are saved. Created automatically if it doesn't exist. Use a synced vault path (Obsidian Sync, iCloud, Dropbox) to access notes across devices.")
      .addText((text) =>
        text
          .setPlaceholder('Igggy')
          .setValue(this.plugin.settings.outputFolder)
          .onChange(async (value) => {
            this.plugin.settings.outputFolder = value.trim() || 'Igggy'
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl)
      .setName('Embed audio link in note')
      .setDesc('Igggy does not store your recordings — audio is permanently deleted after transcription. Enable this to embed a link to the original file at the top of each note.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.embedAudio).onChange(async (value) => {
          this.plugin.settings.embedAudio = value
          await this.plugin.saveSettings()
        })
      )
  }

  private renderHostedSection(containerEl: HTMLElement): void {
    const { settings } = this.plugin
    const isConnected = !!settings.hostedAccessToken && !!settings.hostedRefreshToken

    // Show connection status
    new Setting(containerEl)
      .setName(isConnected ? 'Connected' : 'Not connected')
      .setDesc(
        isConnected
          ? 'Paste fresh tokens any time to re-authenticate.'
          : 'Open the Igggy web app and copy your session tokens.'
      )
      .addButton((btn) =>
        btn
          .setButtonText('Open Igggy →')
          .onClick(() => {
            window.open(`${APP_URL}/auth/plugin-callback`, '_blank')
          })
      )

    // Access token field
    new Setting(containerEl)
      .setName('Access token')
      .setDesc('Paste the access token from the Igggy plugin-callback page.')
      .addText((text) =>
        text
          .setPlaceholder('eyJ…')
          .setValue(settings.hostedAccessToken ? '••••••••' : '')
          .onChange(async (value) => {
            if (!value || value === '••••••••') return
            this.plugin.settings.hostedAccessToken = value.trim()
            // Decode expiry from JWT payload (exp is in seconds)
            try {
              const payload = JSON.parse(atob(value.split('.')[1]))
              this.plugin.settings.hostedTokenExpiry = (payload.exp as number) * 1000
            } catch {
              this.plugin.settings.hostedTokenExpiry = 0
            }
            await this.plugin.saveSettings()
            this.display()
          })
      )

    // Refresh token field
    new Setting(containerEl)
      .setName('Refresh token')
      .setDesc('Paste the refresh token from the Igggy plugin-callback page.')
      .addText((text) =>
        text
          .setPlaceholder('Paste refresh token')
          .setValue(settings.hostedRefreshToken ? '••••••••' : '')
          .onChange(async (value) => {
            if (!value || value === '••••••••') return
            this.plugin.settings.hostedRefreshToken = value.trim()
            await this.plugin.saveSettings()
          })
      )

    // Disconnect button (only shown when connected)
    if (isConnected) {
      new Setting(containerEl)
        .setName('Disconnect')
        .setDesc('Remove stored tokens and return to BYOK mode.')
        .addButton((btn) =>
          btn
            .setButtonText('Disconnect')
            .setWarning()
            .onClick(async () => {
              this.plugin.settings.hostedAccessToken = ''
              this.plugin.settings.hostedRefreshToken = ''
              this.plugin.settings.hostedTokenExpiry = 0
              this.plugin.settings.mode = 'byok'
              await this.plugin.saveSettings()
              this.display()
            })
        )
    }
  }

  private renderBYOKSection(containerEl: HTMLElement): void {
    // ── Transcription ──────────────────────────────────────────────
    new Setting(containerEl).setName('Transcription').setHeading()

    new Setting(containerEl)
      .setName('Provider')
      .setDesc('OpenAI Whisper works with just an OpenAI key. Deepgram adds speaker diarization.')
      .addDropdown((dd) =>
        dd
          .addOption('openai', 'OpenAI Whisper')
          .addOption('deepgram', 'Deepgram Nova-3')
          .setValue(this.plugin.settings.transcriptionProvider)
          .onChange(async (value) => {
            this.plugin.settings.transcriptionProvider = value as 'openai' | 'deepgram'
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl)
      .setName('OpenAI API key')
      .setDesc('Used for Whisper transcription and/or GPT-4o summarization.')
      .addText((text) => {
        text.inputEl.type = 'password'
        text
          .setPlaceholder('Paste your key')
          .setValue(this.plugin.settings.openaiKey)
          .onChange(async (value) => {
            this.plugin.settings.openaiKey = value.trim()
            await this.plugin.saveSettings()
          })
      })

    new Setting(containerEl)
      .setName('Deepgram API key')
      .setDesc('Required when using Deepgram as the transcription provider.')
      .addText((text) => {
        text.inputEl.type = 'password'
        text
          .setPlaceholder('Paste your key')
          .setValue(this.plugin.settings.deepgramKey)
          .onChange(async (value) => {
            this.plugin.settings.deepgramKey = value.trim()
            await this.plugin.saveSettings()
          })
      })

    // ── Summarization ──────────────────────────────────────────────
    new Setting(containerEl).setName('Summarization').setHeading()

    new Setting(containerEl)
      .setName('Provider')
      .setDesc('GPT-4o Mini works with your OpenAI key. Claude Sonnet delivers higher quality notes.')
      .addDropdown((dd) =>
        dd
          .addOption('openai', 'GPT-4o Mini')
          .addOption('anthropic', 'Claude Sonnet')
          .setValue(this.plugin.settings.summarizationProvider)
          .onChange(async (value) => {
            this.plugin.settings.summarizationProvider = value as 'openai' | 'anthropic'
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl)
      .setName('Anthropic API key')
      .setDesc('Required when using Claude as the summarization provider.')
      .addText((text) => {
        text.inputEl.type = 'password'
        text
          .setPlaceholder('Paste your key')
          .setValue(this.plugin.settings.anthropicKey)
          .onChange(async (value) => {
            this.plugin.settings.anthropicKey = value.trim()
            await this.plugin.saveSettings()
          })
      })
  }
}
