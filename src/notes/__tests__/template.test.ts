import { describe, it, expect } from 'vitest'
import { wrapMarkdownForVault, type VaultNoteMetadata } from '../template'
import { generateMarkdownFromContent, type LegacyNoteTemplateData } from '../template-legacy'
import type { NoteContent } from '@igggy/types'

// ── Test fixtures ────────────────────────────────────────────────────────────

function makeMeetingContent(overrides?: Partial<NoteContent>): NoteContent {
  return {
    noteType: 'MEETING',
    title: 'Weekly Standup',
    summary: 'Team discussed sprint progress and blockers.',
    keyTopics: [
      { topic: 'Sprint Progress', bullets: ['Feature A is on track', 'Feature B delayed'] },
      { topic: 'Blockers', bullets: ['API rate limiting'] },
    ],
    content: [],
    decisions: ['Move Feature B deadline to Friday'],
    actionItems: [
      { content: 'Fix rate limiter config', owner: 'Alice', context: 'blocking Feature B' },
      { content: 'Update sprint board', owner: null, context: '' },
    ],
    ...overrides,
  }
}

function makeMemoContent(overrides?: Partial<NoteContent>): NoteContent {
  return {
    noteType: 'MEMO',
    title: 'Architecture Thoughts',
    summary: 'Reflections on moving to event-driven architecture.',
    keyTopics: [{ topic: 'Event Bus', bullets: ['Decouple services'] }],
    content: ['We should consider NATS for the message bus.', 'Redis Streams is another option.'],
    decisions: ['Prototype with NATS first'],
    actionItems: [{ content: 'Set up NATS POC', owner: null, context: '' }],
    ...overrides,
  }
}

function makeLectureContent(overrides?: Partial<NoteContent>): NoteContent {
  return {
    noteType: 'LECTURE',
    title: 'Intro to Distributed Systems',
    summary: 'Covered CAP theorem and eventual consistency.',
    keyTopics: [
      { topic: 'CAP Theorem', bullets: ['Choose 2 of 3: Consistency, Availability, Partition tolerance'] },
    ],
    content: [],
    decisions: ['Eventual consistency', 'Quorum reads'],
    actionItems: [{ content: 'Read Dynamo paper', owner: null, context: '' }],
    ...overrides,
  }
}

function makeLegacyTemplateData(noteContent: NoteContent, overrides?: Partial<LegacyNoteTemplateData>): LegacyNoteTemplateData {
  return {
    noteContent,
    date: '2026-03-14',
    igggyId: 'test-uuid-1234',
    embedAudio: false,
    showTasks: true,
    ...overrides,
  }
}

function makeMeta(overrides?: Partial<VaultNoteMetadata>): VaultNoteMetadata {
  return {
    title: 'Weekly Standup',
    noteType: 'MEETING',
    date: '2026-03-14',
    igggyId: 'test-uuid-1234',
    embedAudio: false,
    ...overrides,
  }
}

// ── wrapMarkdownForVault ─────────────────────────────────────────────────────

describe('wrapMarkdownForVault', () => {
  it('wraps pre-rendered markdown with frontmatter and metadata callout', () => {
    const md = wrapMarkdownForVault('## Summary\n\nTest summary.', makeMeta())
    expect(md).toMatch(/^---\n/)
    expect(md).toContain('igggy_id: test-uuid-1234')
    expect(md).toContain('title: "Weekly Standup"')
    expect(md).toContain('date: 2026-03-14')
    expect(md).toContain('source: igggy')
    expect(md).toContain('tags: [igggy, meeting]')
    expect(md).toContain('## Summary\n\nTest summary.')
    expect(md).toContain('> [!info]- Igggy metadata')
    expect(md).toContain('> type: MEETING')
  })

  it('includes audio embed when embedAudio is true and audioPath provided', () => {
    const md = wrapMarkdownForVault('## Summary\n\nTest.', makeMeta({
      embedAudio: true,
      audioPath: 'Igggy/recording.m4a',
    }))
    expect(md).toContain('![[Igggy/recording.m4a]]')
  })

  it('includes noteId in metadata callout when provided', () => {
    const md = wrapMarkdownForVault('## Summary\n\nTest.', makeMeta({
      noteId: 'server-note-id-123',
    }))
    expect(md).toContain('> note_id: server-note-id-123')
  })

  it('includes durationSec and speakersJson in metadata', () => {
    const md = wrapMarkdownForVault('## Summary\n\nTest.', makeMeta({
      durationSec: 120,
      speakersJson: '{"count":2}',
    }))
    expect(md).toContain('> duration_sec: 120')
    expect(md).toContain("> speakers: '{\"count\":2}'")
  })

  it('normalizes legacy note types in tags', () => {
    const md = wrapMarkdownForVault('Body', makeMeta({ noteType: 'ONE_ON_ONE' as string }))
    expect(md).toContain('tags: [igggy, meeting]')
  })
})

// ── Legacy generateMarkdownFromContent ──────────────────────────────────────

describe('generateMarkdownFromContent — frontmatter', () => {
  it('produces correct YAML frontmatter fields', () => {
    const md = generateMarkdownFromContent(makeLegacyTemplateData(makeMeetingContent()))
    expect(md).toMatch(/^---\n/)
    expect(md).toContain('igggy_id: test-uuid-1234')
    expect(md).toContain('title: "Weekly Standup"')
    expect(md).toContain('date: 2026-03-14')
    expect(md).toContain('source: igggy')
    expect(md).toContain('tags: [igggy, meeting]')
  })

  it('normalizes legacy ONE_ON_ONE type to meeting in tags', () => {
    const content = makeMeetingContent({ noteType: 'MEETING' })
    ;(content as { noteType: string }).noteType = 'ONE_ON_ONE'
    const md = generateMarkdownFromContent(makeLegacyTemplateData(content))
    expect(md).toContain('tags: [igggy, meeting]')
  })

  it('normalizes legacy JOURNAL type to memo in tags', () => {
    const content = makeMemoContent({ noteType: 'MEMO' })
    ;(content as { noteType: string }).noteType = 'JOURNAL'
    const md = generateMarkdownFromContent(makeLegacyTemplateData(content))
    expect(md).toContain('tags: [igggy, memo]')
  })
})

describe('generateMarkdownFromContent — metadata callout', () => {
  it('includes type in metadata callout', () => {
    const md = generateMarkdownFromContent(makeLegacyTemplateData(makeMeetingContent()))
    expect(md).toContain('> [!info]- Igggy metadata')
    expect(md).toContain('> type: MEETING')
  })

  it('includes duration_sec when provided', () => {
    const md = generateMarkdownFromContent(makeLegacyTemplateData(makeMeetingContent(), { durationSec: 120 }))
    expect(md).toContain('> duration_sec: 120')
  })

  it('stores analysis JSON with single-quote escaping', () => {
    const analysis = JSON.stringify({ recordingType: "MEETING", primaryFocus: "it's a test" })
    const md = generateMarkdownFromContent(makeLegacyTemplateData(makeMeetingContent(), { analysisJson: analysis }))
    expect(md).toContain("> analysis: '")
    expect(md).toContain("it''s a test")
  })

  it('stores speakers JSON with single-quote escaping', () => {
    const speakers = JSON.stringify({ count: 2, speakers: [{ id: 0, label: "Speaker 1", name: "O'Brien" }] })
    const md = generateMarkdownFromContent(makeLegacyTemplateData(makeMeetingContent(), { speakersJson: speakers }))
    expect(md).toContain("> speakers: '")
    expect(md).toContain("O''Brien")
  })
})

describe('generateMarkdownFromContent — MEETING layout', () => {
  it('produces sections in correct order', () => {
    const md = generateMarkdownFromContent(makeLegacyTemplateData(makeMeetingContent()))
    const summaryIdx = md.indexOf('## Summary')
    const highlightsIdx = md.indexOf('## Key Highlights')
    const decisionsIdx = md.indexOf('## Decisions')
    const tasksIdx = md.indexOf('## Tasks')
    const metadataIdx = md.indexOf('> [!info]- Igggy metadata')

    expect(summaryIdx).toBeGreaterThan(-1)
    expect(highlightsIdx).toBeGreaterThan(summaryIdx)
    expect(decisionsIdx).toBeGreaterThan(highlightsIdx)
    expect(tasksIdx).toBeGreaterThan(decisionsIdx)
    expect(metadataIdx).toBeGreaterThan(tasksIdx)
  })

  it('renders tasks as checkbox list with owner and context', () => {
    const md = generateMarkdownFromContent(makeLegacyTemplateData(makeMeetingContent()))
    expect(md).toContain('- [ ] Fix rate limiter config (Owner: Alice) — blocking Feature B')
    expect(md).toContain('- [ ] Update sprint board')
  })
})

describe('generateMarkdownFromContent — MEMO layout', () => {
  it('includes content prose paragraphs after decisions', () => {
    const md = generateMarkdownFromContent(makeLegacyTemplateData(makeMemoContent()))
    const decisionsIdx = md.indexOf('## Decisions')
    const proseIdx = md.indexOf('We should consider NATS')
    const tasksIdx = md.indexOf('## Tasks')

    expect(proseIdx).toBeGreaterThan(decisionsIdx)
    expect(tasksIdx).toBeGreaterThan(proseIdx)
  })
})

describe('generateMarkdownFromContent — LECTURE layout', () => {
  it('uses "Main Points" header instead of "Key Highlights"', () => {
    const md = generateMarkdownFromContent(makeLegacyTemplateData(makeLectureContent()))
    expect(md).toContain('## Main Points')
    expect(md).not.toContain('## Key Highlights')
  })

  it('renders decisions as "Key Terms"', () => {
    const md = generateMarkdownFromContent(makeLegacyTemplateData(makeLectureContent()))
    expect(md).toContain('## Key Terms')
    expect(md).not.toContain('## Decisions')
  })
})

describe('generateMarkdownFromContent — showTasks', () => {
  it('omits Tasks section when showTasks is false', () => {
    const md = generateMarkdownFromContent(makeLegacyTemplateData(makeMeetingContent(), { showTasks: false }))
    expect(md).not.toContain('## Tasks')
  })
})
