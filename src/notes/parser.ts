/**
 * Pure parsing functions for reading Igggy note metadata from vault markdown.
 * Extracted from commands.ts so they can be unit-tested without Obsidian APIs.
 */
import type { TranscriptAnalysis } from '@igggy/types'

// ── Metadata callout ─────────────────────────────────────────────────────────

/** Extracts the raw metadata callout block text from note markdown. */
export function extractMetadataBlock(content: string): string {
  const match = content.match(/> \[!info\]-?\s*Igggy metadata\s*\n((?:>.*\n?)*)/i)
  return match?.[1] ?? ''
}

// ── Analysis JSON ────────────────────────────────────────────────────────────

/**
 * Parses stored TranscriptAnalysis from a note's metadata callout or legacy frontmatter.
 * Returns undefined if no analysis is found or it fails to parse.
 */
export function parseAnalysis(frontmatter: string, metaBlock: string): TranscriptAnalysis | undefined {
  // Check frontmatter first (old notes), then callout (new notes)
  const match = frontmatter.match(/^igggy_analysis:\s*'([\s\S]*?)'\s*$/m)
    ?? metaBlock.match(/^>\s*analysis:\s*'([\s\S]*?)'\s*$/m)
  if (!match) return undefined
  try {
    const raw = match[1].replace(/''/g, "'")
    return JSON.parse(raw) as TranscriptAnalysis
  } catch {
    return undefined
  }
}

// ── Speakers JSON ────────────────────────────────────────────────────────────

/**
 * Extracts the raw speakers JSON string from the metadata callout.
 * Returns undefined if no speakers data is found.
 */
export function extractSpeakersJson(metaBlock: string): string | undefined {
  const match = metaBlock.match(/^>\s*speakers:\s*'([\s\S]*?)'\s*$/m)
  if (!match) return undefined
  try {
    return match[1].replace(/''/g, "'")
  } catch {
    return undefined
  }
}

// ── Duration ─────────────────────────────────────────────────────────────────

/** Extracts duration_sec from frontmatter or metadata callout. */
export function parseDuration(frontmatter: string, metaBlock: string): number | undefined {
  const str = frontmatter.match(/^duration_sec:\s*(\d+)$/m)?.[1]
    ?? metaBlock.match(/^>\s*duration_sec:\s*(\d+)$/m)?.[1]
  return str ? parseInt(str, 10) : undefined
}

// ── Audio path ───────────────────────────────────────────────────────────────

/** Extracts audio file path from frontmatter or metadata callout. */
export function parseAudioPath(frontmatter: string, metaBlock: string): string | undefined {
  return frontmatter.match(/^audio:\s*"?(.+?)"?\s*$/m)?.[1]?.trim()
    ?? metaBlock.match(/^>\s*audio:\s*"?(.+?)"?\s*$/m)?.[1]?.trim()
}

// ── Transcript extraction ────────────────────────────────────────────────────

/**
 * Extracts the transcript text from note markdown.
 * Supports three formats in priority order:
 * 1. Obsidian callout: `> [!note]- Transcript`
 * 2. HTML details block: `<details><summary>Full transcript</summary>...</details>`
 * 3. Bare heading: `## Transcript` followed by text until next section
 */
export function extractTranscript(content: string): string | undefined {
  // 1. Obsidian callout (current plugin format)
  const calloutMatch = content.match(/> \[!note\]-?\s*Transcript\s*\n((?:>.*\n?)*)/i)
  if (calloutMatch) {
    const text = calloutMatch[1]
      .split('\n')
      .map(line => line.replace(/^>\s?/, ''))
      .join('\n')
      .trim()
    if (text) return text
  }

  // 2. HTML details block (older plugin format)
  const detailsMatch = content.match(
    /## Transcript\s*\n+<details>\s*\n*<summary>Full transcript<\/summary>\s*\n+([\s\S]*?)\n*\s*<\/details>/
  )
  if (detailsMatch) {
    const text = detailsMatch[1].trim()
    if (text) return text
  }

  // 3. Bare ## Transcript heading (web app synced notes, newer plugin format)
  const bareMatch = content.match(/## Transcript\s*\n+([\s\S]*?)(?=\n## |\n> \[!info\]|\n---\s*$|$)/)
  if (bareMatch) {
    const text = bareMatch[1].trim()
    if (text) return text
  }

  return undefined
}

// ── Frontmatter extraction ───────────────────────────────────────────────────

/** Extracts the raw YAML frontmatter string (without delimiters) from note markdown. */
export function extractFrontmatter(content: string): string {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  return match?.[1] ?? ''
}

/** Extracts igggy_id from frontmatter. */
export function parseIgggyId(frontmatter: string): string | undefined {
  return frontmatter.match(/^igggy_id:\s*(.+)$/m)?.[1]?.trim()
}

/** Extracts date from frontmatter. */
export function parseDate(frontmatter: string): string | undefined {
  return frontmatter.match(/^date:\s*(.+)$/m)?.[1]?.trim()
}

// ── Note ID (server DB ID — used for regen via API) ──────────────────────────

/** Extracts server note_id from metadata callout. */
export function parseNoteId(metaBlock: string): string | undefined {
  return metaBlock.match(/^>\s*note_id:\s*(.+)$/m)?.[1]?.trim()
}

// ── Note source ─────────────────────────────────────────────────────────────

/** Extracts note_source from metadata callout (e.g. 'web', 'plugin'). */
export function parseSource(metaBlock: string): string | undefined {
  return metaBlock.match(/^>\s*note_source:\s*(.+)$/m)?.[1]?.trim()
}
