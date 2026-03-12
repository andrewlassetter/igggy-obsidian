/**
 * Shared prompt builder — ported from web app packages/core/src/prompt.ts.
 * Used by both ClaudeProvider and OpenAIGPT4oProvider.
 *
 * SYNC NOTE: Keep AI-facing field names as-is:
 *   - keyTopics  (web app prompt uses "keyHighlights", mapped to "keyTopics" by validateNoteContent)
 *   - actionItems
 * The plugin uses "keyTopics" directly — no mapping step needed.
 */

import type {
  TranscriptMeta,
  TranscriptAnalysis,
  NotePreferences,
  NoteType,
} from './providers/types'

// Re-export TranscriptMeta for backward compat (it used to live here)
export type { TranscriptMeta }

export interface PromptOptions {
  /** Skip auto-detection and force this note type. */
  forcedType?: NoteType
  /** Include actionItems extraction in the prompt. Default: true. */
  includeTasks?: boolean
  /** User-provided instructions to shape the summarization. */
  customPrompt?: string
  /** When present, uses the adaptive two-pass summarization path. */
  analysis?: TranscriptAnalysis
}

// ── Shared helpers ────────────────────────────────────────────────────────────

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

function buildPreferencesSection(preferences: NotePreferences): string {
  const toneMap: Record<NotePreferences['tone'], string> = {
    casual: 'Write in a conversational, accessible tone. Avoid stiff corporate language.',
    professional: 'Write in clear, professional language. Precise and authoritative.',
  }
  const densityMap: Record<NotePreferences['density'], string | null> = {
    concise: 'Prioritize brevity. One bullet per point, tightest possible summary.',
    standard: null,
    detailed: 'Be thorough. Include nuances, context, and supporting details. Err on the side of completeness.',
  }

  const lines = ['PREFERENCES:']
  lines.push(`- Tone: ${toneMap[preferences.tone]}`)
  const densityLine = densityMap[preferences.density]
  if (densityLine) lines.push(`- Detail level: ${densityLine}`)

  return lines.join('\n') + '\n\n'
}

function buildVoiceAndStyle(): string {
  return `VOICE AND STYLE:
- Write with a direct, warm editorial voice. Lead with the most important insight, not setup.
- Be a sharp editor: cut anything that doesn't add meaning. Never pad or hedge.
- Write as if briefing a smart colleague who wasn't in the room.

NEVER:
- Start any bullet with "The speaker said…", "It was mentioned that…", or "Someone noted…"
- Use filler phrases: "It's worth noting", "Additionally", "In conclusion", "As mentioned"
- Pad the summary — if it's covered well in 1 sentence, don't write 2`
}

// ── Pass 1: Analysis prompt ──────────────────────────────────────────────────

export function buildAnalysisPrompt(meta?: TranscriptMeta): string {
  const contextHint = buildContextHint(meta)

  return `You are a transcript analyst. Read the following audio transcript and extract structured signals about its content. Do NOT summarize — only classify and detect.

${contextHint}Return a JSON object with ALL of these fields:

{
  "recordingType": "MEETING" | "MEMO" | "LECTURE",
  "speakerCount": 1,
  "contentSignals": {
    "hasDecisions": false,
    "hasFollowUps": false,
    "hasKeyTerms": false,
    "hasSpeakerDiscussion": false,
    "hasReflectiveProse": false,
    "hasIdeaDevelopment": false
  },
  "voiceInstructions": null,
  "toneRegister": "formal" | "casual",
  "primaryFocus": "One sentence describing what this recording is about"
}

FIELD DEFINITIONS:

recordingType — classify into exactly one:
- "MEETING" — conversation with 2+ people. Group calls, 1:1s, interviews, standups, pair discussions.
- "MEMO" — one person capturing their own thoughts. Quick ideas, brainstorms, reflections, task dumps, journal entries.
- "LECTURE" — passive listening. Classes, talks, presentations, podcasts, sermons. The recorder is a listener, not a participant.

speakerCount — number of distinct speakers you can identify. 1 for solo, 2+ for multi-speaker.

contentSignals — for each, answer: is there enough substance in the transcript to warrant a dedicated section in a note?
- hasDecisions: Were decisions made, things resolved, or agreements reached?
- hasFollowUps: Are there tasks, action items, next steps, or things to do after this recording?
- hasKeyTerms: Were technical terms, concepts, frameworks, or vocabulary introduced or defined?
- hasSpeakerDiscussion: Is there meaningful back-and-forth dialogue between speakers worth attributing?
- hasReflectiveProse: Is there personal reflection, introspection, or narrative thinking?
- hasIdeaDevelopment: Is the speaker working through, developing, or refining an idea they'd want structured and reflected back clearly?

voiceInstructions — Did the speaker address Igggy (the note-taking app) directly with instructions about what to capture or how to structure the note? Examples: "Igggy, just pull out the action items", "Hey Igggy, focus on the budget numbers", "Igggy, I need a summary of the key decisions". Extract the instruction text verbatim. If no instructions were spoken to Igggy, return null.

toneRegister — "formal" for business/professional recordings, "casual" for personal/informal.

primaryFocus — A single sentence describing the main topic or purpose of this recording.

Respond with only the JSON object — no preamble, no explanation, no markdown code fences.`
}

// ── Pass 2: Adaptive summarization prompt ────────────────────────────────────

export function buildSummarizationPrompt(
  analysis: TranscriptAnalysis,
  preferences?: NotePreferences,
  options?: PromptOptions,
): string {
  const includeTasks = options?.includeTasks ?? true
  const preferencesSection = preferences ? buildPreferencesSection(preferences) : ''

  // ── Recording type framing ────────────────────────────────────────────────
  const typeFraming = (() => {
    switch (analysis.recordingType) {
      case 'MEETING':
        return `You are summarizing a conversation between ${analysis.speakerCount} ${analysis.speakerCount === 1 ? 'person' : 'people'}. Set noteType to "MEETING".`
      case 'MEMO':
        return 'You are capturing one person\'s thoughts and ideas. Set noteType to "MEMO". Write as if reflecting the speaker\'s own thinking back to them — you are writing as them, not summarizing a third person.'
      case 'LECTURE':
        return 'You are capturing a talk or presentation where the recorder is a passive listener. Set noteType to "LECTURE". Focus on learning and retention — what would help the listener review and internalize this material?'
    }
  })()

  // ── Voice instructions (highest priority) ─────────────────────────────────
  const voiceInstructionsSection = analysis.voiceInstructions
    ? `\nPRIORITY — VOICE INSTRUCTIONS FROM THE SPEAKER:
The speaker gave these instructions about how to handle this note: "${analysis.voiceInstructions}"
Follow these instructions. They take priority over default section rules. If the speaker asked for specific sections or focus areas, honor that even if it means skipping default sections.\n`
    : ''

  // ── Primary focus ─────────────────────────────────────────────────────────
  const focusSection = `This recording is primarily about: ${analysis.primaryFocus}\n`

  // ── Tone modifier ─────────────────────────────────────────────────────────
  const toneInstruction = analysis.toneRegister === 'casual'
    ? '- Tone: conversational, accessible. Avoid stiff corporate language.'
    : '- Tone: clear, professional. Precise and authoritative.'

  // ── Conditional sections in JSON schema ───────────────────────────────────
  const signals = analysis.contentSignals
  const hasAnyTasks = includeTasks && signals.hasFollowUps

  const actionItemsSchema = hasAnyTasks
    ? `,

  "actionItems": [
    {
      "content": "Task starting with a verb",
      "owner": "Name of the person responsible, or null",
      "context": "One sentence: why this matters or what it unblocks"
    }
  ]`
    : ''

  const keyTermsSchema = signals.hasKeyTerms
    ? `\n  "keyTerms": ["term1", "term2"],`
    : ''

  // ── Conditional rules ─────────────────────────────────────────────────────
  const sections: string[] = []

  // Decisions
  if (signals.hasDecisions) {
    sections.push('- decisions: things explicitly decided, AND things completed or resolved during the recording. Stated as facts. If none, use [].')
  } else {
    sections.push('- decisions: return [] — no significant decisions were detected in this recording.')
  }

  // Tasks
  if (hasAnyTasks) {
    sections.push('- actionItems: ONLY work that remains to be done AFTER this recording ends. If something was completed during the recording, it belongs in decisions, NOT actionItems.')
    sections.push('- NO DUPLICATE items between decisions and actionItems. If an item could fit both, put it in decisions.')
    if (analysis.recordingType === 'MEMO') {
      sections.push('- Surface implicit tasks clearly in actionItems — memos often contain tasks that aren\'t stated explicitly.')
    }
    if (analysis.recordingType === 'LECTURE') {
      sections.push('- actionItems: follow-up tasks for the LISTENER only (assigned reading, practice problems, topics to research). If none were mentioned, return [].')
    }
    sections.push('- If no actionItems exist, use [].')
  }

  // Key terms
  if (signals.hasKeyTerms) {
    sections.push('- keyTerms: flat list of technical terms, named frameworks, or key vocabulary introduced. Strings only — no definitions. Return [] if none.')
  }

  // Speaker attribution
  if (signals.hasSpeakerDiscussion) {
    sections.push(`- If the transcript contains [Speaker N]: labels, attribute statements, decisions, and action items to specific speakers. Write naturally: "Speaker 1 raised a concern about…", "Speaker 2 agreed to…"
- If the transcript has NO speaker labels, write in an abstract voice: "The team agreed…" / "A concern was raised…"
- Never fabricate or guess speaker identity beyond what the transcript explicitly labels.`)
  }

  // Reflective prose
  if (signals.hasReflectiveProse) {
    sections.push('- content: capture the reflective, narrative thinking in prose paragraphs. Write as if reflecting the speaker\'s own voice back to them.')
  }

  // Idea development
  if (signals.hasIdeaDevelopment) {
    sections.push('- This recording contains idea development. Structure and clarify the idea being developed. Use keyTopics to capture the idea\'s evolution — how it started, how it developed, and where it landed. Make the thinking clearer than it was spoken.')
  }

  const conditionalRules = sections.length > 0 ? sections.join('\n') : ''

  // ── Custom prompt ─────────────────────────────────────────────────────────
  const customPromptSection = options?.customPrompt?.trim()
    ? `\nUSER INSTRUCTIONS:\n${options.customPrompt.trim()}\n`
    : ''

  // ── Assemble ──────────────────────────────────────────────────────────────
  return `You are a thoughtful note-taking assistant. Analyze this audio transcript and produce a structured note.

${typeFraming}
${focusSection}
${voiceInstructionsSection}Return a JSON object with ALL of these fields:

{
  "noteType": "${analysis.recordingType}",

  "title": "A specific, descriptive title (5–8 words). Useful months from now.",

  "summary": "1–2 concise sentences. High-level overview. Scannable at a glance.",

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
    "A fact: something explicitly decided OR completed/resolved"
  ],
${keyTermsSchema}
  "keyTerms": []${actionItemsSchema}
}

${buildVoiceAndStyle()}
${toneInstruction}

Rules — read carefully:
- summary: 1–2 sentences only. High-level, scannable. Never a list.
- keyTopics: 3–6 topics covering the main threads. 2–4 concise bullets per topic. Topic names must be specific and earned from the content — no generic labels like "Discussion" or "Updates".
- content: 2–4 prose paragraphs. Always populate even if it covers similar ground to keyTopics.
${conditionalRules}

${preferencesSection}${customPromptSection}Respond with only the JSON object — no preamble, no explanation, no markdown code fences.`
}

// ── Legacy single-pass prompt (fallback when no analysis is available) ───────

function buildLegacyPrompt(
  meta?: TranscriptMeta,
  preferences?: NotePreferences,
  options?: PromptOptions,
): string {
  const contextHint = buildContextHint(meta)
  const preferencesSection = preferences ? buildPreferencesSection(preferences) : ''
  const includeTasks = options?.includeTasks ?? true
  const forcedType = options?.forcedType

  const typeSection = forcedType
    ? `The user has identified this recording as a ${forcedType}. Set noteType to "${forcedType}" and follow the ${forcedType}-specific rules below.`
    : `Identify the recording type:
- "MEETING" — conversation with 2+ people. Group calls, 1:1s, interviews, standups, pair discussions.
- "MEMO" — one person capturing their own thoughts. Quick ideas, brainstorms, reflections, task dumps, journal entries.
- "LECTURE" — passive listening. Classes, talks, presentations, podcasts, sermons. The recorder is a listener, not a participant.`

  const actionItemsSchema = includeTasks
    ? `,

  "actionItems": [
    {
      "content": "Task starting with a verb",
      "owner": "Name of the person responsible, or null",
      "context": "One sentence: why this matters or what it unblocks"
    }
  ]`
    : ''

  const taskRules = includeTasks
    ? `- actionItems: ONLY work that remains to be done AFTER this recording ends. If something was completed, decided, or resolved during the recording itself — it belongs in decisions, NOT actionItems.
- NO DUPLICATE items between decisions and actionItems. If an item could fit both, put it in decisions.
- If no actionItems exist, use []. `
    : ''

  const memoTaskRule = includeTasks
    ? `\n- Surface implicit tasks clearly in actionItems — memos often contain tasks that aren't stated explicitly`
    : ''

  const lectureTaskRule = includeTasks
    ? `\n- actionItems: follow-up tasks for the LISTENER only (assigned reading, practice problems, topics to research). If none were mentioned, return [].`
    : ''

  const customPromptSection = options?.customPrompt?.trim()
    ? `\nUSER INSTRUCTIONS:\n${options.customPrompt.trim()}\n\n`
    : ''

  return `You are a thoughtful note-taking assistant. Analyze this audio transcript and produce a structured note.

${contextHint}${typeSection}

Return a JSON object with ALL of these fields:

{
  "noteType": "MEETING" | "MEMO" | "LECTURE",

  "title": "A specific, descriptive title (5–8 words). Useful months from now — not 'Team meeting' but 'Q3 launch timeline and owner assignments'.",

  "summary": "1–2 concise sentences. High-level overview of what happened and the main outcome. Scannable at a glance.",

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

  "keyTerms": ["term1", "term2"]${actionItemsSchema}
}

${buildVoiceAndStyle()}

Rules — read carefully:
- summary: 1–2 sentences only. High-level, scannable. Never a list.
- keyTopics: 3–6 topics covering the main threads. 2–4 concise bullets per topic. Topic names must be specific and earned from the content — no generic labels like "Discussion" or "Updates".
- content: 2–4 prose paragraphs. For meetings, a narrative recap. For memos, the key ideas expanded. Always populate even if it covers similar ground to keyTopics.
- decisions: things explicitly decided, AND things completed or resolved during the recording (e.g. "deleted the project", "agreed to skip the release"). Stated as facts.
- keyTerms: ONLY used for LECTURE type. A flat list of technical terms, concepts, or named frameworks introduced in this lecture (strings only — no definitions). If none, return []. For all other note types, return [] or omit.
${taskRules}If no decisions were made, use [].

For MEETING recordings:
- If the transcript contains [Speaker N]: labels (Deepgram detected multiple speakers), you may — and should — attribute statements, decisions, and action items to specific speakers. Write naturally: "Speaker 1 raised a concern about…", "Speaker 2 agreed to…", "Speaker 1 and Speaker 2 aligned on…"
- If the transcript has NO speaker labels (single speaker or unlabeled recording), write in an abstract voice: "The team agreed…" / "A concern was raised…" / "It was decided…"
- Never fabricate, infer, or guess speaker identity beyond what the transcript explicitly labels. Do not replace speaker labels with assumed names, roles, or pronouns.

For MEMO recordings:
- summary: 1–2 sentences capturing the core idea — not a table of contents
- Write as if reflecting the speaker's own thinking back to them — you are writing as them, not summarizing a third person.
- Use content[] for tight prose (exploratory thinking) OR keyTopics (action-oriented ideas) — not both${memoTaskRule}

For LECTURE recordings:
- The recorder is a passive listener. Do NOT attribute content to the listener — only what the lecturer said matters.
- summary: 2–4 sentences capturing the lecture's central thesis or learning objective in plain language.
- keyTopics: the main concepts, arguments, or topics the lecturer covered, IN THE ORDER they were presented. Each highlight should be a complete, informative sentence as a bullet — not a fragment or a generic title. Aim for 5–8 highlights across 2–5 topic groups.
- keyTerms: flat list of technical terms, named frameworks, or key vocabulary introduced. Strings only — no definitions. Include even well-known terms if they were explicitly defined or central to the lecture. Return [] if none.
- decisions: return [] — lectures have no decisions.${lectureTaskRule}
- Do NOT attribute statements to speakers by name. Write from the content's perspective.

${preferencesSection}${customPromptSection}Respond with only the JSON object — no preamble, no explanation, no markdown code fences.`
}

// ── Public router ─────────────────────────────────────────────────────────────
// When analysis is provided (two-pass path), routes to the adaptive summarization prompt.
// Otherwise falls back to the legacy single-pass prompt (simplified to 3 types).

export function buildPrompt(
  meta?: TranscriptMeta,
  preferences?: NotePreferences,
  options?: PromptOptions,
): string {
  if (options?.analysis) {
    return buildSummarizationPrompt(options.analysis, preferences, options)
  }
  return buildLegacyPrompt(meta, preferences, options)
}
