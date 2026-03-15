/**
 * waveform.ts
 *
 * Renders a simple text status inside an `igggy-status` code block.
 *
 * The live canvas waveform is rendered only in the sidebar recording view
 * (recording-view.ts). This in-note block shows a lightweight text indicator
 * so the user knows a recording is active without duplicating the waveform.
 */

import type { MarkdownPostProcessorContext } from 'obsidian'
import type IgggyPlugin from '../main'

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatSec(totalSec: number): string {
  const sec = Math.floor(totalSec)
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Renders a text status block into the given element.
 * Called by the 'igggy-status' code block processor in main.ts.
 */
export function renderWaveform(
  state: 'recording' | 'paused' | 'processing',
  el: HTMLElement,
  ctx: MarkdownPostProcessorContext,
  plugin: IgggyPlugin
): void {
  el.empty()
  const container = el.createDiv({ cls: 'igggy-waveform-status' })

  const labelText =
    state === 'recording' ? '\u25CF Recording'
    : state === 'paused'  ? '\u23F8 Paused'
    :                       '\u27F3 Processing\u2026'

  const label = container.createSpan({ cls: 'igggy-waveform-label', text: labelText })

  // Show timer for recording/paused states
  if (state !== 'processing') {
    const timerEl = container.createSpan({ cls: 'igggy-timer' })
    timerEl.textContent = ` · ${formatSec(plugin.activeRecording?.getElapsedSec() ?? 0)}`

    const id = window.setInterval(() => {
      timerEl.textContent = ` · ${formatSec(plugin.activeRecording?.getElapsedSec() ?? 0)}`
    }, 250)

    // Clean up interval when block is unmounted
    const { MarkdownRenderChild } = require('obsidian')
    const child = new MarkdownRenderChild(container)
    child.onunload = () => clearInterval(id)
    ctx.addChild(child)
  }
}
