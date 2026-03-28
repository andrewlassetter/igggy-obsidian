/**
 * IgggyClient — thin API client for all v1 endpoints.
 *
 * Replaces direct AI provider calls. All processing happens server-side;
 * the plugin sends audio/text + optional BYOK keys and receives
 * pre-rendered markdown.
 *
 * Uses Obsidian's `requestUrl` for all HTTP calls.
 */
import { requestUrl } from 'obsidian'
import type {
  ProcessRequest, ProcessResponse, BYOKKeys,
  UploadUrlResponse,
  NoteResponse,
  NotesListResponse,
  RegenRequest,
  SyncPayload, PullSyncResponse,
  BillingStatusResponse,
  CheckoutRequest, CheckoutResponse,
  SearchResponse,
} from '@igggy/types'

export class IgggyClient {
  constructor(
    private baseUrl: string,
    private getToken: () => Promise<string | null>
  ) {}

  // ── Processing ──────────────────────────────────────────────────────────

  async process(request: ProcessRequest): Promise<ProcessResponse> {
    return this.post('/api/v1/process', request)
  }

  // ── Upload ──────────────────────────────────────────────────────────────

  async getUploadUrl(filename: string): Promise<UploadUrlResponse> {
    return this.post('/api/v1/upload-url', { filename })
  }

  async uploadAudio(signedUrl: string, buffer: ArrayBuffer, contentType: string): Promise<void> {
    const res = await requestUrl({
      url: signedUrl,
      method: 'PUT',
      body: buffer,
      headers: { 'Content-Type': contentType },
      throw: false,
    })

    if (res.status >= 300) {
      throw new Error(`Upload to storage failed (${res.status})`)
    }
  }

  // ── Notes ───────────────────────────────────────────────────────────────

  async getNote(id: string): Promise<NoteResponse> {
    return this.get(`/api/v1/notes/${id}`)
  }

  async listNotes(cursor?: string, limit?: number): Promise<NotesListResponse> {
    const params = new URLSearchParams()
    if (cursor) params.set('cursor', cursor)
    if (limit) params.set('limit', String(limit))
    const qs = params.toString()
    return this.get(`/api/v1/notes${qs ? `?${qs}` : ''}`)
  }

  async deleteNote(id: string): Promise<void> {
    await this.request('DELETE', `/api/v1/notes/${id}`)
  }

  // ── Regeneration ────────────────────────────────────────────────────────

  async regenerate(noteId: string, options: RegenRequest): Promise<ProcessResponse> {
    return this.post(`/api/v1/notes/${noteId}/regen`, options)
  }

  // ── Sync ────────────────────────────────────────────────────────────────

  async pushSync(payload: SyncPayload): Promise<void> {
    await this.post('/api/v1/notes/sync', payload)
  }

  async pullSync(since?: string): Promise<PullSyncResponse> {
    const qs = since ? `?since=${encodeURIComponent(since)}` : ''
    return this.get(`/api/v1/notes/sync${qs}`)
  }

  // ── Billing ─────────────────────────────────────────────────────────────

  async getBillingStatus(): Promise<BillingStatusResponse> {
    return this.get('/api/v1/billing/status')
  }

  async createCheckout(request: CheckoutRequest): Promise<CheckoutResponse> {
    return this.post('/api/v1/billing/checkout', request)
  }

  // ── Search ──────────────────────────────────────────────────────────────

  async search(query: string): Promise<SearchResponse> {
    const qs = `?q=${encodeURIComponent(query)}`
    return this.get(`/api/v1/search${qs}`)
  }

  // ── HTTP helpers ────────────────────────────────────────────────────────

  private async get<T>(path: string): Promise<T> {
    return this.request('GET', path) as Promise<T>
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request('POST', path, body) as Promise<T>
  }

  /**
   * Safely access res.json — Obsidian's requestUrl throws SyntaxError
   * when the response body is empty or non-JSON (e.g. S3 XML errors,
   * empty 401/204 responses). Returns undefined instead of throwing.
   */
  private safeJson(res: { json: unknown; text: string }): unknown {
    try {
      return res.json
    } catch {
      return undefined
    }
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const token = await this.getToken()

    const headers: Record<string, string> = {}
    if (token) headers['Authorization'] = `Bearer ${token}`
    if (body) headers['Content-Type'] = 'application/json'

    const res = await requestUrl({
      url: `${this.baseUrl}${path}`,
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      throw: false,
    })

    if (res.status === 401) {
      throw new IgggyApiError('Not signed in — sign in from plugin settings.', 'UNAUTHORIZED', 401)
    }

    if (res.status === 402) {
      const data = this.safeJson(res) as { error?: string; freeRecordingsUsed?: number } | undefined
      throw new IgggyApiError(
        data?.error ?? 'Free recordings used up — upgrade your Igggy plan at app.igggy.ai',
        'UPGRADE_REQUIRED',
        402
      )
    }

    if (res.status === 429) {
      const data = this.safeJson(res) as { retryAfterSec?: number } | undefined
      throw new IgggyApiError(
        `Rate limit exceeded — try again in ${data?.retryAfterSec ?? 60} seconds.`,
        'RATE_LIMITED',
        429
      )
    }

    if (res.status < 200 || res.status >= 300) {
      const data = this.safeJson(res) as { error?: string; code?: string } | undefined
      throw new IgggyApiError(
        data?.error ?? `Request failed (${res.status})`,
        data?.code ?? 'UNKNOWN',
        res.status
      )
    }

    // DELETE returns no body
    if (method === 'DELETE') return undefined

    return this.safeJson(res)
  }
}

export class IgggyApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number
  ) {
    super(message)
    this.name = 'IgggyApiError'
  }
}
