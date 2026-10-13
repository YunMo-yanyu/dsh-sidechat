/**
 * Typed fetch wrapper over the /sidechat JSON API (the host half's context
 * method — the three history strategies — plus title and config). Mirrors the
 * wire envelope `{ok: true, value} | {ok: false, error}`.
 */
import type { SidechatHistoryStrategy } from '../config.ts'
import type { SidechatCatalog } from '../context-types.ts'

/** One wire failure. */
export class SidechatApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** Result of one context call (mirror of the host SidechatContextResult). */
export interface ContextResult {
  degraded: boolean
  /** The injected context text (`null` for `inherit` or on failure). */
  text: string | null
  sourceSeq: number
  reason?: string
}

/** Result of one title call (mirror of the host TitleResult). */
export interface TitleResult {
  degraded: boolean
  title: string | null
  reason?: string
}

async function call<T>(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/sidechat/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
      keepalive: method === 'temporary.close',
    })
  } catch (error) {
    throw new SidechatApiError('network', error instanceof Error ? error.message : String(error))
  }
  const parsed: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } } | null
    = await response.json().catch(() => null)
  if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === undefined) {
    throw new SidechatApiError(
      parsed?.error?.code ?? 'http',
      parsed?.error?.message ?? `HTTP ${response.status}`,
    )
  }
  return parsed.value as T
}

/** Resolved sidechat configuration (mirror of the host SidechatConfig). */
export interface SidechatConfigView {
  historyStrategy: SidechatHistoryStrategy
  trimWindowMessages: number
  summarizeProvider: string
  summarizeModel: string
  summarizeReasoningEffort: string
  summarizeBudgetTokens: number
  recentWindowMessages: number
  backgroundWindowMessages: number
  answerProvider: string
  answerModel: string
  answerReasoningEffort: string
  titleBudgetTokens: number
}

/** The config namespace envelope (value + revision for revision-guarded writes). */
export interface SidechatConfigEnvelope {
  value?: SidechatConfigView
  revision?: number
}

/** The sidechat API surface (session scope-free; the route fences itself). */
export const sidechatApi = {
  temporaryOpen: (payload: Record<string, unknown>) => call<{ sessionId: string }>('temporary.open', payload),
  temporaryClose: (key: string) => call<{ closed: boolean }>('temporary.close', { key }),
  context: (payload: Record<string, unknown>, signal?: AbortSignal) =>
    call<ContextResult>('context', payload, signal),
  title: (payload: Record<string, unknown>, signal?: AbortSignal) =>
    call<TitleResult>('title', payload, signal),
  config: (signal?: AbortSignal) =>
    call<SidechatConfigView>('config', {}, signal),
  catalog: (signal?: AbortSignal) =>
    call<SidechatCatalog>('catalog', {}, signal),
  configGet: (signal?: AbortSignal) =>
    call<SidechatConfigEnvelope>('config.get', {}, signal),
  configUpdate: (patch: Record<string, unknown>, expectedRevision?: number) =>
    call<SidechatConfigEnvelope>('config.update', {
      patch,
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    }),
}
