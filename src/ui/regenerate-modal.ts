import { App, Modal, Setting, TFile } from 'obsidian'
import type { NoteType } from '@igggy/types'
import type IgggyPlugin from '../main'
import { TASKS_ENABLED, CUSTOM_INSTRUCTIONS } from '../feature-flags'

export interface RegenOptions {
  density: 'concise' | 'standard' | 'detailed'
  includeTasks: boolean
  customPrompt: string
  forcedType?: NoteType
}

export class RegenerateModal extends Modal {
  private density: RegenOptions['density']
  private includeTasks: boolean
  private customPrompt = ''
  private forcedType: NoteType | undefined = undefined

  constructor(
    app: App,
    private plugin: IgggyPlugin,
    private file: TFile,
    private onSubmit: (options: RegenOptions) => void
  ) {
    super(app)
    this.density = plugin.settings.noteDensity
    this.includeTasks = plugin.settings.showTasks
  }

  onOpen(): void {
    const { contentEl } = this
    contentEl.empty()
    contentEl.addClass('igggy-regen-modal')

    contentEl.createEl('h2', { text: 'Regenerate note' })

    // ── Note type override ─────────────────────────────────────────────────────
    new Setting(contentEl)
      .setName('Note type')
      .setDesc('Override AI type detection, or leave on Auto.')
      .addDropdown((dropdown) => {
        dropdown.addOption('', 'Auto (let AI decide)')
        dropdown.addOption('MEETING', 'Meeting')
        dropdown.addOption('MEMO', 'Memo')
        dropdown.addOption('LECTURE', 'Lecture')
        dropdown.setValue('')
        dropdown.onChange((value) => {
          this.forcedType = value ? (value as NoteType) : undefined
        })
      })

    // ── Detail level (segmented control) ──────────────────────────────────────
    const densitySetting = new Setting(contentEl)
      .setName('Detail level')
      .setDesc('How thorough the regenerated note should be.')

    const segmented = densitySetting.controlEl.createDiv({ cls: 'igggy-regen-segmented' })
    const densities: Array<{ value: RegenOptions['density']; label: string }> = [
      { value: 'concise', label: 'Concise' },
      { value: 'standard', label: 'Standard' },
      { value: 'detailed', label: 'Detailed' },
    ]

    const buttons: HTMLButtonElement[] = []
    for (const d of densities) {
      const btn = segmented.createEl('button', { text: d.label })
      if (d.value === this.density) btn.addClass('igggy-active')
      btn.addEventListener('click', () => {
        this.density = d.value
        buttons.forEach((b) => b.removeClass('igggy-active'))
        btn.addClass('igggy-active')
      })
      buttons.push(btn)
    }

    // ── Include tasks toggle ──────────────────────────────────────────────────
    if (TASKS_ENABLED) {
      new Setting(contentEl)
        .setName('Include tasks')
        .setDesc('Show the Tasks section in the regenerated note.')
        .addToggle((toggle) =>
          toggle.setValue(this.includeTasks).onChange((value) => {
            this.includeTasks = value
          })
        )
    }

    // ── Custom instructions ───────────────────────────────────────────────────
    if (CUSTOM_INSTRUCTIONS) {
      new Setting(contentEl)
        .setName('Custom instructions')
        .setDesc('Optional guidance for the AI.')
        .addTextArea((text) => {
          text.inputEl.rows = 3
          text.inputEl.addClass('igggy-regen-textarea')
          text
            .setPlaceholder('Focus on budget numbers, skip small talk\u2026')
            .onChange((value) => {
              this.customPrompt = value
            })
        })
    }

    // ── Action button ─────────────────────────────────────────────────────────
    const actions = contentEl.createDiv({ cls: 'igggy-regen-actions' })

    const regenBtn = actions.createEl('button', {
      text: 'Regenerate',
      cls: 'mod-cta',
    })
    regenBtn.addEventListener('click', () => {
      this.close()
      this.onSubmit(this.buildOptions())
    })
  }

  onClose(): void {
    this.contentEl.empty()
  }

  private buildOptions(): RegenOptions {
    return {
      density: this.density,
      includeTasks: this.includeTasks,
      customPrompt: this.customPrompt.trim(),
      forcedType: this.forcedType,
    }
  }
}
