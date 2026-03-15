import { App, Modal, Notice, TFile } from 'obsidian'
import { formatTranscriptParagraphs, parseSpeakerLabel } from '@igggy/core'

/**
 * Modal for editing the transcript of an Igggy note.
 * On save, replaces the ## Transcript section and clears stored analysis
 * (forces full Pass 1 + Pass 2 re-run on next regeneration).
 */
export class EditTranscriptModal extends Modal {
  private textareaEl: HTMLTextAreaElement | null = null

  constructor(
    app: App,
    private file: TFile,
    private currentTranscript: string
  ) {
    super(app)
  }

  onOpen(): void {
    const { contentEl } = this
    contentEl.empty()
    contentEl.addClass('igggy-edit-transcript-modal')

    contentEl.createEl('h2', { text: 'Edit transcript' })
    contentEl.createEl('p', {
      text: 'Edit the transcript text below. After saving, use "Regenerate note" to update the note with the new transcript.',
      cls: 'setting-item-description',
    })

    // Textarea
    this.textareaEl = contentEl.createEl('textarea', {
      cls: 'igggy-edit-transcript-textarea',
    })
    this.textareaEl.value = this.currentTranscript
    this.textareaEl.rows = 20
    this.textareaEl.style.width = '100%'
    this.textareaEl.style.fontFamily = 'var(--font-monospace)'
    this.textareaEl.style.fontSize = 'var(--font-smaller)'
    this.textareaEl.style.resize = 'vertical'

    // Action buttons
    const actions = contentEl.createDiv({ cls: 'igggy-edit-transcript-actions' })

    const saveBtn = actions.createEl('button', { text: 'Save', cls: 'mod-cta' })
    saveBtn.addEventListener('click', () => {
      void this.handleSave()
    })

    const cancelBtn = actions.createEl('button', { text: 'Cancel' })
    cancelBtn.addEventListener('click', () => {
      this.close()
    })
  }

  onClose(): void {
    this.contentEl.empty()
  }

  private async handleSave(): Promise<void> {
    const newTranscript = this.textareaEl?.value?.trim()
    if (!newTranscript) {
      new Notice('Igggy: Transcript cannot be empty.', 3000)
      return
    }

    const content = await this.app.vault.read(this.file)

    // Format the new transcript with speaker label styling
    const formattedLines = formatTranscriptParagraphs(newTranscript)
      .map((para) => {
        const { speaker, body } = parseSpeakerLabel(para)
        return speaker ? `**${speaker}:** ${body}` : para
      })
      .join('\n\n')

    // Replace the ## Transcript section content
    // Match from "## Transcript\n\n" to the next heading, metadata callout, or end
    const transcriptRegex = /(## Transcript\s*\n+)([\s\S]*?)(?=\n## |\n> \[!info\]|$)/
    let updatedContent: string

    if (transcriptRegex.test(content)) {
      updatedContent = content.replace(
        transcriptRegex,
        `$1${formattedLines}\n`
      )
    } else {
      new Notice('Igggy: Could not find transcript section in note.', 5000)
      this.close()
      return
    }

    // Clear stored analysis to force full re-analysis on next regen
    updatedContent = updatedContent.replace(
      /^>\s*analysis:\s*'[\s\S]*?'\s*\n?/m,
      ''
    )

    await this.app.vault.modify(this.file, updatedContent)

    new Notice('Transcript updated. Use "Regenerate note" to apply changes.', 4000)
    this.close()
  }
}
