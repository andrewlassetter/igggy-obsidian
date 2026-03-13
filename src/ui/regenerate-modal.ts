import { App, Modal, Setting, TFile } from 'obsidian'
import type IgggyPlugin from '../main'

export interface RegenOptions {
  density: 'concise' | 'standard' | 'detailed'
  includeTasks: boolean
  customPrompt: string
  action: 'replace' | 'save-new'
}

export class RegenerateModal extends Modal {
  private density: RegenOptions['density']
  private includeTasks: boolean
  private customPrompt = ''

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
    new Setting(contentEl)
      .setName('Include tasks')
      .setDesc('Show the Tasks section in the regenerated note.')
      .addToggle((toggle) =>
        toggle.setValue(this.includeTasks).onChange((value) => {
          this.includeTasks = value
        })
      )

    // ── Custom instructions ───────────────────────────────────────────────────
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

    // ── Action buttons ────────────────────────────────────────────────────────
    const actions = contentEl.createDiv({ cls: 'igggy-regen-actions' })

    const replaceBtn = actions.createEl('button', {
      text: 'Replace this note',
      cls: 'mod-cta',
    })
    replaceBtn.addEventListener('click', () => {
      this.close()
      this.onSubmit(this.buildOptions('replace'))
    })

    const newBtn = actions.createEl('button', { text: 'Save as new note' })
    newBtn.addEventListener('click', () => {
      this.close()
      this.onSubmit(this.buildOptions('save-new'))
    })
  }

  onClose(): void {
    this.contentEl.empty()
  }

  private buildOptions(action: RegenOptions['action']): RegenOptions {
    return {
      density: this.density,
      includeTasks: this.includeTasks,
      customPrompt: this.customPrompt.trim(),
      action,
    }
  }
}
