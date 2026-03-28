import type { ProcessResponse, SyncPayload } from '@igggy/types'
import { normalizeNoteType } from '@igggy/types'

export function buildSyncPayload(
  result: ProcessResponse,
  date: string,
  opts?: { durationSec?: number }
): SyncPayload {
  return {
    igggy_id: result.igggyId,
    title: result.content.title,
    type: normalizeNoteType(result.content.noteType),
    date: `${date}T00:00:00Z`,
    duration_sec: opts?.durationSec ?? result.durationSec,
    source: 'plugin',
    transcript: result.transcript,
    summary: result.content.summary,
    key_topics: result.content.keyTopics.length > 0 ? result.content.keyTopics : null,
    content: result.content.content.length > 0 ? result.content.content : null,
    decisions: result.content.decisions.length > 0 ? result.content.decisions : null,
    tasks: result.content.actionItems.map((t) => ({
      content: t.content,
      owner: t.owner ?? undefined,
      context: t.context ?? undefined,
    })),
  }
}
