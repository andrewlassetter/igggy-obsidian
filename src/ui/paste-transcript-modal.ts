import { App, Modal, Notice } from 'obsidian'

/**
 * Modal for pasting transcript text to generate a note without audio.
 * Calls the provided onSubmit callback with the pasted text.
 */
export class PasteTranscriptModal extends Modal {
  private textareaEl: HTMLTextAreaElement | null = null

  constructor(
    app: App,
    private onSubmit: (transcript: string) => void
  ) {
    super(app)
  }

  onOpen(): void {
    const { contentEl } = this
    contentEl.empty()
    contentEl.addClass('igggy-paste-transcript-modal')

    contentEl.createEl('h2', { text: 'Paste transcript' })
    contentEl.createEl('p', {
      text: 'Paste or type a transcript below. Igggy will analyze it and generate structured notes.',
      cls: 'setting-item-description',
    })

    // Textarea
    this.textareaEl = contentEl.createEl('textarea', {
      cls: 'igggy-paste-transcript-textarea',
    })
    this.textareaEl.placeholder = 'Paste your transcript here…'
    this.textareaEl.rows = 20
    this.textareaEl.style.width = '100%'
    this.textareaEl.style.fontFamily = 'var(--font-monospace)'
    this.textareaEl.style.fontSize = 'var(--font-smaller)'
    this.textareaEl.style.resize = 'vertical'

    // Action buttons
    const actions = contentEl.createDiv({ cls: 'igggy-paste-transcript-actions' })

    const processBtn = actions.createEl('button', { text: 'Process', cls: 'mod-cta' })
    processBtn.addEventListener('click', () => {
      const text = this.textareaEl?.value?.trim()
      if (!text) {
        new Notice('Igggy: Please paste some text first.', 3000)
        return
      }
      this.close()
      this.onSubmit(text)
    })

    const cancelBtn = actions.createEl('button', { text: 'Cancel' })
    cancelBtn.addEventListener('click', () => {
      this.close()
    })
  }

  onClose(): void {
    this.contentEl.empty()
  }
}
