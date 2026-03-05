import { App, PluginSettingTab, Setting } from 'obsidian'
import type IggyNotePlugin from './main'

export class IggyNoteSettingsTab extends PluginSettingTab {
  plugin: IggyNotePlugin

  constructor(app: App, plugin: IggyNotePlugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  display(): void {
    const { containerEl } = this
    containerEl.empty()

    containerEl.createEl('h2', { text: 'Iggy Note' })

    // ── Transcription ──────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'Transcription' })

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
      .addText((text) =>
        text
          .setPlaceholder('sk-...')
          .setValue(this.plugin.settings.openaiKey)
          .onChange(async (value) => {
            this.plugin.settings.openaiKey = value.trim()
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl)
      .setName('Deepgram API key')
      .setDesc('Required when using Deepgram as the transcription provider.')
      .addText((text) =>
        text
          .setPlaceholder('your-deepgram-key')
          .setValue(this.plugin.settings.deepgramKey)
          .onChange(async (value) => {
            this.plugin.settings.deepgramKey = value.trim()
            await this.plugin.saveSettings()
          })
      )

    // ── Summarization ──────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'Summarization' })

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
      .addText((text) =>
        text
          .setPlaceholder('sk-ant-...')
          .setValue(this.plugin.settings.anthropicKey)
          .onChange(async (value) => {
            this.plugin.settings.anthropicKey = value.trim()
            await this.plugin.saveSettings()
          })
      )

    // ── Output ──────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'Output' })

    new Setting(containerEl)
      .setName('Output folder')
      .setDesc("Vault folder where notes are created. Will be created automatically if it doesn't exist.")
      .addText((text) =>
        text
          .setPlaceholder('Iggy Notes')
          .setValue(this.plugin.settings.outputFolder)
          .onChange(async (value) => {
            this.plugin.settings.outputFolder = value.trim() || 'Iggy Notes'
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl)
      .setName('Embed audio link in note')
      .setDesc('Adds ![[recording.m4a]] at the top of each generated note.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.embedAudio).onChange(async (value) => {
          this.plugin.settings.embedAudio = value
          await this.plugin.saveSettings()
        })
      )

    // ── Pro ─────────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'Pro BYOK' })

    new Setting(containerEl)
      .setName('License key')
      .setDesc('Unlocks unlimited recordings, unified task list, and Deepgram diarization.')
      .addText((text) =>
        text
          .setPlaceholder('IGGY-XXXX-XXXX-XXXX')
          .setValue(this.plugin.settings.licenseKey)
          .onChange(async (value) => {
            this.plugin.settings.licenseKey = value.trim()
            await this.plugin.saveSettings()
          })
      )
  }
}
