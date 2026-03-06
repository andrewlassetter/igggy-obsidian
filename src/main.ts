import { Plugin } from 'obsidian'
import { type IggyNoteSettings, DEFAULT_SETTINGS } from './settings'
import { IggyNoteSettingsTab } from './settings-tab'
import { registerCommands, registerMenus, openAudioFilePicker } from './commands'

export default class IggyNotePlugin extends Plugin {
  settings!: IggyNoteSettings

  async onload(): Promise<void> {
    await this.loadSettings()
    this.addRibbonIcon('audio-waveform', 'Process audio with Igggy', () => openAudioFilePicker(this))
    registerCommands(this)
    registerMenus(this)
    this.addSettingTab(new IggyNoteSettingsTab(this.app, this))
    console.log('[Igggy] Plugin loaded')
  }

  onunload(): void {
    console.log('[Igggy] Plugin unloaded')
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
  }
}
