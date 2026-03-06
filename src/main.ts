import { Plugin } from 'obsidian'
import { type IgggySettings, DEFAULT_SETTINGS } from './settings'
import { IgggySettingsTab } from './settings-tab'
import { registerCommands, registerMenus, openAudioFilePicker } from './commands'

export default class IgggyPlugin extends Plugin {
  settings!: IgggySettings

  async onload(): Promise<void> {
    await this.loadSettings()
    this.addRibbonIcon('audio-waveform', 'Process audio with Igggy', () => openAudioFilePicker(this))
    registerCommands(this)
    registerMenus(this)
    this.addSettingTab(new IgggySettingsTab(this.app, this))
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
