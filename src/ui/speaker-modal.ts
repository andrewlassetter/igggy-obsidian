import { App, Modal, Notice, Setting, TFile } from 'obsidian'
import type { SpeakersData } from '@igggy/types'

/**
 * Modal for naming speakers in an Igggy note.
 * Shows one text input per detected speaker. On save, writes updated
 * speaker JSON back to the metadata callout in the note file.
 */
export class SpeakerModal extends Modal {
  private nameInputs: Record<number, string> = {}

  constructor(
    app: App,
    private file: TFile,
    private speakersData: SpeakersData
  ) {
    super(app)
    // Pre-fill with existing names
    for (const s of speakersData.speakers) {
      this.nameInputs[s.id] = s.name ?? ''
    }
  }

  onOpen(): void {
    const { contentEl } = this
    contentEl.empty()
    contentEl.addClass('igggy-speaker-modal')

    contentEl.createEl('h2', { text: 'Name speakers' })
    contentEl.createEl('p', {
      text: 'Assign names to speakers detected in this recording. Names will be used when regenerating the note.',
      cls: 'setting-item-description',
    })

    for (const speaker of this.speakersData.speakers) {
      new Setting(contentEl)
        .setName(speaker.label)
        .addText((text) => {
          text
            .setPlaceholder(`Name for ${speaker.label}`)
            .setValue(this.nameInputs[speaker.id] ?? '')
            .onChange((value) => {
              this.nameInputs[speaker.id] = value.trim()
            })
          text.inputEl.addClass('igggy-speaker-input')
        })
    }

    // Action buttons
    const actions = contentEl.createDiv({ cls: 'igggy-speaker-actions' })

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
    // Build updated SpeakersData
    const updatedSpeakers = this.speakersData.speakers.map((s) => {
      const name = this.nameInputs[s.id]
      if (name) return { id: s.id, label: s.label, name }
      return { id: s.id, label: s.label }
    })
    const updatedData = { count: this.speakersData.count, speakers: updatedSpeakers }
    const updatedJson = JSON.stringify(updatedData)

    // Read file and update the speakers line in the metadata callout
    const content = await this.app.vault.read(this.file)
    const speakersLineRegex = /^(>\s*speakers:\s*').+?('\s*)$/m
    let updatedContent: string

    if (speakersLineRegex.test(content)) {
      // Replace existing speakers line
      updatedContent = content.replace(
        speakersLineRegex,
        `> speakers: '${updatedJson.replace(/'/g, "''")}'`
      )
    } else {
      // Insert speakers line before analysis line (or at end of callout)
      const analysisLineRegex = /^(>\s*analysis:\s*'.+?')\s*$/m
      if (analysisLineRegex.test(content)) {
        updatedContent = content.replace(
          analysisLineRegex,
          `> speakers: '${updatedJson.replace(/'/g, "''")}'\n$1`
        )
      } else {
        // Append to end of metadata callout
        const calloutEnd = content.match(/^(> \[!info\]-?\s*Igggy metadata\s*\n(?:>.*\n?)*)/m)
        if (calloutEnd) {
          const callout = calloutEnd[1].trimEnd()
          updatedContent = content.replace(
            calloutEnd[1],
            `${callout}\n> speakers: '${updatedJson.replace(/'/g, "''")}'\n`
          )
        } else {
          new Notice('Igggy: Could not find metadata callout in note.', 5000)
          this.close()
          return
        }
      }
    }

    await this.app.vault.modify(this.file, updatedContent)

    const namedCount = updatedSpeakers.filter((s) => 'name' in s).length
    new Notice(
      namedCount > 0
        ? `${namedCount} speaker${namedCount > 1 ? 's' : ''} named. Regenerate to apply.`
        : 'Speaker names cleared.',
      3000
    )

    this.close()
  }
}
