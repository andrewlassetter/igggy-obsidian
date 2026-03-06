/**
 * Shared prompt builder — ported from web app src/lib/claude.ts.
 * Used by both ClaudeProvider and OpenAIGPT4oProvider.
 */

export interface TranscriptMeta {
  durationSec?: number  // strong signal: memos < 8 min, meetings 20–90 min
  capturedAt?: Date     // day/time pattern helps distinguish meeting vs memo
}

export function buildContextHint(meta?: TranscriptMeta): string {
  if (!meta) return ''

  const parts: string[] = []

  if (meta.durationSec) {
    const mins = Math.round(meta.durationSec / 60)
    parts.push(`${mins}-minute recording`)
  }

  if (meta.capturedAt) {
    const d = meta.capturedAt
    const hour = d.getHours()
    const day = d.getDay()  // 0 = Sun, 6 = Sat
    const isWeekend = day === 0 || day === 6
    const timeOfDay = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'
    parts.push(`${isWeekend ? 'weekend' : 'weekday'} ${timeOfDay}`)
  }

  if (parts.length === 0) return ''
  return `Context: ${parts.join(', ')}.\n`
}

export function buildPrompt(meta?: TranscriptMeta): string {
  const contextHint = buildContextHint(meta)

  return `You are a thoughtful note-taking assistant. Analyze this audio transcript and produce a structured note.

${contextHint}Identify the recording type:
- "MEETING" — group discussion or call with 3 or more people
- "ONE_ON_ONE" — conversation between exactly two people (1:1 meeting, interview, pair call)
- "MEMO" — one person capturing their own thoughts, ideas, to-dos, or reflections

Return a JSON object with ALL of these fields:

{
  "noteType": "MEETING" | "ONE_ON_ONE" | "MEMO",

  "title": "A specific, descriptive title (5–8 words). Useful months from now — not 'Team meeting' but 'Q3 launch timeline and owner assignments'.",

  "summary": "2–3 concise sentences. High-level overview of what happened and the main outcome. Scannable at a glance.",

  "keyTopics": [
    {
      "topic": "Primary topic or theme from the recording",
      "bullets": ["Concise point", "Another point — keep these tight"]
    }
  ],

  "content": [
    "First prose paragraph capturing key ideas or context...",
    "Second paragraph — a distinct theme or thread..."
  ],

  "decisions": [
    "A fact: something explicitly decided OR completed/resolved during this recording"
  ],

  "actionItems": [
    {
      "content": "Task starting with a verb",
      "owner": "Name of the person responsible, or null",
      "context": "One sentence: why this matters or what it unblocks"
    }
  ]
}

Rules — read carefully:
- summary: 2–3 sentences only. High-level, scannable. Never a list.
- keyTopics: 3–6 topics covering the main threads. 2–4 concise bullets per topic. For memos, these are the main themes or ideas discussed.
- content: 2–4 prose paragraphs. For meetings, a narrative recap. For memos, the key ideas expanded. Always populate even if it covers similar ground to keyHighlights.
- decisions: things explicitly decided, AND things completed or resolved during the recording (e.g. "deleted the project", "agreed to skip the release"). Stated as facts.
- actionItems: ONLY work that remains to be done AFTER this recording ends. If something was completed, decided, or resolved during the recording itself — it belongs in decisions, NOT actionItems.
- NO DUPLICATE items between decisions and actionItems. If an item could fit both, put it in decisions.
- If no actionItems exist, use []. If no decisions were made, use [].
- Respond with only the JSON object — no preamble, no explanation, no markdown code fences`
}
