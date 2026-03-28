import { Notice } from 'obsidian'
import type { SyncPayload } from '@igggy/types'
import type IgggyPlugin from '../main'
import { createClient } from '../auth'

/**
 * Non-blocking push of a completed note to the Igggy cloud DB.
 * Only fires when a valid access token is available.
 * Available to all authenticated users post-API-first.
 */
export async function syncNoteToCloud(
  plugin: IgggyPlugin,
  payload: SyncPayload
): Promise<void> {
  const { settings } = plugin

  if (!settings.accessToken) {
    console.debug('[Igggy] Push sync skipped: no access token')
    return
  }

  const client = createClient(plugin)

  const attempt = async (): Promise<boolean> => {
    try {
      await client.pushSync(payload)
      return true
    } catch {
      return false
    }
  }

  const ok = await attempt()
  if (ok) return

  // Retry after 5s
  await new Promise((r) => setTimeout(r, 5000))
  const retryOk = await attempt()
  if (retryOk) return

  // Queue for later drain
  console.warn('[Igggy] Cloud sync failed after retry \u2014 queuing for later:', payload.igggy_id)
  new Notice('Note saved locally. Cloud sync will retry.', 3000)
  settings.pendingSyncs.push({ igggyId: payload.igggy_id, payload: payload as unknown as Record<string, unknown> })
  await plugin.saveSettings()
}
