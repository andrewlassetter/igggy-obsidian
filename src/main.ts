import { Plugin } from 'obsidian'
import { type IggyNoteSettings, DEFAULT_SETTINGS } from './settings'
import { IggyNoteSettingsTab } from './settings-tab'
import { registerCommands } from './commands'

export default class IggyNotePlugin extends Plugin {
  settings!: IggyNoteSettings

  async onload(): Promise<void> {
    await this.loadSettings()
    registerCommands(this)
    this.addSettingTab(new IggyNoteSettingsTab(this.app, this))
    console.log('[Iggy Note] Plugin loaded')
  }

  onunload(): void {
    console.log('[Iggy Note] Plugin unloaded')
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
  }
}
