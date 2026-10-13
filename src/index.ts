/**
 * dsh-sidechat host half: the /sidechat JSON API (the context method — the
 * three history strategies — plus title and config) and the `sidechat`
 * settings namespace (fast-model channel / budget / window / strategy). The
 * context method reads the main session's current model surface through
 * `ctx.sessionQuery.readSurface` and, per strategy:
 * - `inherit`: nothing to assemble — the client forks the parent instead.
 * - `compressed`: compress the EARLIER window with a fast no-thinking model
 *   through `ctx.llm.stream` and keep the RECENT band verbatim.
 * - `trim`: keep the last `trimWindowMessages` segments verbatim, no model.
 * Any failure degrades to `{ degraded: true }` — the client then skips the
 * context block and still answers.
 *
 * Both the context and the title method accept an optional `locale` field
 * ('zh' | 'en'): the host has no locale signal of its own, so the client sends
 * the active DSH language and the host picks the matching prompt bundle. An
 * absent field means 'zh' — a pre-i18n client keeps today's exact behavior.
 *
 * The route passes the same browser-trust fence as the /api gateway
 * (Host-header loopback or the connection row's `trustedHosts`).
 */
import { createTemporarySessions, type TemporaryHost } from './temporary.ts'
import type { IncomingMessage } from 'node:http'
import type { Context } from './context-types.ts'
import {
  SIDECHAT_DEFAULTS,
  SIDECHAT_SETTINGS_NS,
  SidechatPrefsSchema,
  type SidechatConfig,
  type SidechatHistoryStrategy,
} from './config.ts'
import {
  assembleText,
  BACKGROUND_SEGMENT_MAX,
  backgroundSystem,
  buildTrimContext,
  composeSummary,
  extractSegments,
  formatBackground,
  formatSegments,
  RECENT_SEGMENT_MAX,
  splitRecent,
} from './summarize.ts'
import { openSettingsSeam, type SidechatConfigFace } from './settings-face.ts'
import { isTrustedApiRequest } from './trust-fence.ts'
import { readJsonBody, requireString, SidechatError, writeError, writeJson, writeOk } from './wire.ts'
import {
  boundTitleInput,
  normalizeTitle,
  TITLE_MAX_BYTES,
  titleSystem,
} from './title.ts'
import { promptLocaleOf } from './prompt-locale.ts'
import type {
  SidechatCatalog,
  SidechatLlmMessage,
  SidechatLlmModel,
  SidechatSettingsScope,
} from './context-types.ts'

export { SIDECHAT_DEFAULTS, SIDECHAT_SETTINGS_NS } from './config.ts'
export type { SidechatConfig, SidechatHistoryStrategy, SidechatReasoningEffort } from './config.ts'
export type { Context } from './context-types.ts'
export { PROMPTS, promptLocaleOf, promptsOf, QUESTION_LABELS } from './prompt-locale.ts'
export type { PromptBundle, PromptLocale } from './prompt-locale.ts'
export {
  assembleText,
  BACKGROUND_SYSTEM,
  backgroundSystem,
  buildTrimContext,
  composeSummary,
  extractSegments,
  formatBackground,
  formatSegments,
  splitRecent,
  textOfEvent,
} from './summarize.ts'
export { TITLE_SYSTEM, boundTitleInput, buildTitleInput, normalizeTitle, titleSystem, truncateTitleUtf8 } from './title.ts'

/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-sidechat'

/** Services required before mounting: the webserver routes, the session query engine, the llm runtime, and the loader's connection row (trust fence). */
export const inject = ['webServer', 'sessionQuery', 'llm', 'loader']

/** How long a summarize call may run before degrading. */
const SUMMARIZE_TIMEOUT_MS = 8000

/** How long a title call may run before degrading. */
const TITLE_TIMEOUT_MS = 8000

/** Result of one context call (the client branches on `degraded`). */
export interface SidechatContextResult {
  degraded: boolean
  /** The injected context text (`null` for `inherit` or on failure). */
  text: string | null
  sourceSeq: number
  reason?: string
}

/** Result of one title call (the client branches on `degraded`). */
export interface TitleResult {
  degraded: boolean
  title: string | null
  reason?: string
}

/** One cached summary entry. */
interface CacheEntry {
  sourceSeq: number
  summary: string
}

/** One API method dispatch table entry. */
type ApiMethod = (payload: unknown) => Promise<unknown> | unknown

/** Generate a unique message id for a hand-built llm message. */
function randomId(): string {
  const cryptoLike = globalThis.crypto as { randomUUID?: () => string } | undefined
  if (cryptoLike?.randomUUID) return cryptoLike.randomUUID()
  return `sq-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Build a user-role message carrying the surface text. */
function userMessage(text: string): SidechatLlmMessage {
  return {
    id: randomId(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-sidechat' },
  }
}

/**
 * The non-loopback authorities this deployment serves, for the /api trust fence.
 *
 * Matched on the row's `id`, not on `name`: the web-app bundle mounts that row as
 * `id: connection` with `name: '@deepseek-ai/dsh-client-connection'`
 * (`packages/bundle/web-app/cordis.patch.yml`), so the `name === 'connection'` test
 * this used to do never matched anything and the fence silently degraded to
 * loopback-only for every LAN or custom-Host browser.
 *
 * The PRIMARY source is `webRuntime.trustedHosts`, because the row's own config is
 * NOT a list: the shipped patch declares `trustedHosts: !!js ctx.webRuntime.
 * trustedHosts`, and `entry.options.config` keeps that expression UNEVALUATED
 * (evaluation happens in the loader's `internal/config` hook, against the fiber's
 * config). Reading it as if it were an array is worse than not reading it at all —
 * a non-array reaches `isTrustedAuthority`'s `.some()` and throws, and the fence
 * runs outside the route's try/catch, so the request would HANG rather than answer.
 * Hence the array check on every source, including the row fallback kept for a
 * deployment whose patch layer replaced the expression with a literal list.
 * @param ctx - the host plugin context.
 * @returns the trusted authorities; `[]` means loopback-only.
 */
function trustedHostsOf(ctx: Context): string[] {
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

  const fromRuntime = strings(ctx.get('webRuntime')?.trustedHosts)
  if (fromRuntime.length > 0) return fromRuntime

  for (const entry of ctx.loader.entries()) {
    if (entry.options.id !== 'connection') continue
    return strings(entry.options.config?.trustedHosts)
  }
  return []
}

/** Build the API method table bound to the plugin context and its cache. */
function buildApi(
  ctx: Context,
  getConfig: () => SidechatConfig,
  cache: Map<string, CacheEntry>,
  getConfigFace: () => SidechatConfigFace | undefined,
): Record<string, ApiMethod> {
  return {
    config: (): SidechatConfig => getConfig(),
    catalog: async (): Promise<SidechatCatalog> => {
      const providers = ctx.llm.listProviders().map(async (provider) => {
        let models: readonly SidechatLlmModel[] = []
        try {
          models = await ctx.llm.listModels(provider.id)
        } catch {
          // A route that cannot enumerate its models still shows up (empty
          // model list) so the user can name the provider before its models load.
        }
        return { provider: provider.id, displayName: provider.name, models }
      })
      return { providers: await Promise.all(providers) }
    },
    'config.get': (): { value?: unknown; revision?: number } => {
      const face = getConfigFace()
      return face?.get() ?? { value: getConfig(), revision: undefined }
    },
    'config.update': async (payload): Promise<{ value?: unknown; revision?: number }> => {
      const face = getConfigFace()
      if (face === undefined) {
        throw new SidechatError(
          'settings-rejected',
          'this host exposes no sidechat settings namespace (the settings service is absent, or it offers no namespace registration)',
          503,
        )
      }
      const record = payload as { patch?: unknown; expectedRevision?: unknown } | null
      const patch = record?.patch
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new SidechatError('bad-request', 'patch must be a plain object')
      }
      const expectedRevision = typeof record?.expectedRevision === 'number' ? record.expectedRevision : undefined
      try {
        return await face.update(patch as Record<string, unknown>, expectedRevision)
      } catch (error) {
        if ((error as { code?: unknown }).code === 'SETTINGS_CONFLICT') {
          throw new SidechatError('settings-conflict', error instanceof Error ? error.message : String(error), 409)
        }
        throw new SidechatError('settings-rejected', error instanceof Error ? error.message : String(error), 400)
      }
    },
    context: async (payload): Promise<SidechatContextResult> => {
      const mainSessionId = requireString(payload, 'mainSessionId')
      const record = payload as {
        strategy?: unknown
        provider?: unknown
        model?: unknown
        budgetTokens?: unknown
        locale?: unknown
      }
      // The language of the PROMPTS and their structural markers. Absent (a
      // client that predates i18n) resolves to 'zh' — byte-identical to the
      // pre-i18n behavior; the answer's own language is decided by the intro
      // the client injects, from the user's question.
      const locale = promptLocaleOf(record.locale)
      const config = getConfig()
      const strategy: SidechatHistoryStrategy =
        record.strategy === 'inherit' || record.strategy === 'trim' ? record.strategy : 'compressed'

      // `inherit` needs no context text — the client forks the parent and the
      // full history travels with the seed; there is nothing to assemble here.
      if (strategy === 'inherit') {
        return { degraded: false, text: null, sourceSeq: -1 }
      }

      const provider = typeof record.provider === 'string' && record.provider !== ''
        ? record.provider
        : config.summarizeProvider
      const model = typeof record.model === 'string' && record.model !== ''
        ? record.model
        : config.summarizeModel
      const budgetTokens = typeof record.budgetTokens === 'number' && Number.isInteger(record.budgetTokens) && record.budgetTokens > 0
        ? record.budgetTokens
        : config.summarizeBudgetTokens

      // Read the main session's current model surface (excludes tool/reasoning noise).
      const surface = await ctx.sessionQuery.readSurface(mainSessionId)
      const sourceSeq = surface.capturedThroughSeq ?? -1

      // `trim`: the last N segments verbatim — deterministic and free, no model.
      if (strategy === 'trim') {
        const text = buildTrimContext(extractSegments(surface.events), config.trimWindowMessages, undefined, locale)
        if (text === '') return { degraded: true, text: null, sourceSeq, reason: 'empty-surface' }
        return { degraded: false, text, sourceSeq }
      }

      // `compressed`: asymmetric window — the RECENT messages pass through
      // near-verbatim (they anchor the follow-up to the latest state); only the
      // EARLIER background goes to the fast model for compression.
      // The locale is part of the key: without it a zh→en switch would keep
      // serving the cached Chinese summary until the parent produces a new
      // message. (This Map has no eviction policy; the axis at most doubles it,
      // and each entry is a single summary string.)
      const cacheKey = `${strategy}:${locale}:${mainSessionId}`
      const cached = cache.get(cacheKey)
      if (cached !== undefined && cached.sourceSeq === sourceSeq) {
        return { degraded: false, text: cached.summary, sourceSeq }
      }

      const { earlier, recent } = splitRecent(extractSegments(surface.events), config.recentWindowMessages)
      const recentText = formatSegments(recent, RECENT_SEGMENT_MAX, locale)
      // Hand the background to the model NEWEST-FIRST so the current progress
      // (the tail of `earlier`, just before the verbatim recent band) sits at
      // the strongest attention position instead of the opening topic.
      const earlierText = formatBackground(earlier, config.backgroundWindowMessages, BACKGROUND_SEGMENT_MAX, locale)

      // Compress the background only when there is earlier content AND a provider.
      // Any failure here leaves the background empty — the verbatim recent window
      // still carries the current state, so the ask is never blocked.
      let background = ''
      if (earlierText.trim() !== '' && provider !== '') {
        try {
          const chunks = ctx.llm.stream({
            provider,
            model,
            messages: [userMessage(earlierText)],
            system: backgroundSystem(locale),
            maxTokens: budgetTokens,
            reasoningEffort: config.summarizeReasoningEffort,
            signal: AbortSignal.timeout(SUMMARIZE_TIMEOUT_MS),
          })
          const assembled = await assembleText(chunks)
          if (!assembled.failed) background = assembled.text.trim()
        } catch {
          // background stays empty; the recent window still carries the answer
        }
      }

      const text = composeSummary(background, recentText, locale)
      if (text.trim() === '') {
        return { degraded: true, text: null, sourceSeq, reason: 'empty-surface' }
      }
      cache.set(cacheKey, { sourceSeq, summary: text })
      return { degraded: false, text, sourceSeq }
    },
    title: async (payload): Promise<TitleResult> => {
      const text = requireString(payload, 'text')
      const record = payload as { provider?: unknown; model?: unknown; budgetTokens?: unknown; locale?: unknown }
      const locale = promptLocaleOf(record.locale)
      const config = getConfig()
      // The title reuses the summarize route (fixed flash / thinking off); the
      // client resolves the inherited provider, and the model defaults here.
      const provider = typeof record.provider === 'string' && record.provider !== ''
        ? record.provider
        : config.summarizeProvider
      const model = typeof record.model === 'string' && record.model !== ''
        ? record.model
        : config.summarizeModel
      const budgetTokens = typeof record.budgetTokens === 'number' && Number.isInteger(record.budgetTokens) && record.budgetTokens > 0
        ? record.budgetTokens
        : config.titleBudgetTokens

      // No provider → degrade; the client keeps the placeholder title.
      if (provider === '') return { degraded: true, title: null, reason: 'no-provider' }
      try {
        const chunks = ctx.llm.stream({
          provider,
          model,
          messages: [userMessage(boundTitleInput(text))],
          system: titleSystem(locale),
          maxTokens: budgetTokens,
          reasoningEffort: config.summarizeReasoningEffort,
          signal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
        })
        const assembled = await assembleText(chunks)
        if (assembled.failed || assembled.text.trim() === '') {
          return { degraded: true, title: null, reason: assembled.failed ? 'stream' : 'empty' }
        }
        const title = normalizeTitle(assembled.text, TITLE_MAX_BYTES)
        if (title === '') return { degraded: true, title: null, reason: 'empty-title' }
        return { degraded: false, title }
      } catch {
        return { degraded: true, title: null, reason: 'error' }
      }
    },
  }
}

/**
 * Plugin body: mount the fenced route and the optional settings namespace.
 * @param ctx - host plugin context (webServer, sessionQuery, llm, loader).
 */
export function apply(ctx: Context, entryConfig?: Partial<SidechatConfig>): void {
  // A refusal, never a hang: the fence runs outside the route's try/catch, so
  // anything thrown in here would leave the response unwritten and the request
  // pending forever. Deny instead — the safe direction for a trust check.
  const fence = (req: IncomingMessage): boolean => {
    try {
      return isTrustedApiRequest(req, trustedHostsOf(ctx))
    } catch (error) {
      console.warn('[dsh-sidechat] the /api trust fence failed; refusing the request:', error)
      return false
    }
  }

  // ── User-editable configuration ───────────────────────────────────────────
  // The `sidechat` namespace is OPTIONAL and the host may not offer one at all:
  // `dsh-settings` ≥ 0.1.7 dropped namespace registration (its `SettingsForms`
  // derives editable fields from the plugin's own `Config` schema, addressed by
  // profile entry id — see `settings-face.ts`). So the seam is probed by
  // STRUCTURE, never by version, and every refusal degrades: the summarize route
  // still answers on SIDECHAT_DEFAULTS. A refusal must never disable the plugin.
  // The config face adds a revision-guarded update path so the webview config
  // panel persists edits without silently overwriting a concurrent change
  // (mirror of the settings seam's own guard).
  let configScope: SidechatSettingsScope<SidechatConfig> | undefined
  let configFace: SidechatConfigFace | undefined
  ctx.inject(['settings'], (sctx) => {
    const seam = openSettingsSeam<SidechatConfig>(
      sctx.settings as unknown,
      SIDECHAT_SETTINGS_NS,
      SidechatPrefsSchema,
    )
    if (!seam.ok) {
      // `service-missing` cannot happen here (cordis only runs this callback
      // once `settings` is provided) — it stays silent. `no-register` is the
      // EXPECTED shape on a 0.1.7+ host, so it is one informational line, not a
      // failure. Only a genuinely unexpected refusal gets a warning.
      if (seam.reason === 'no-register') {
        console.info(
          '[dsh-sidechat] this host offers no settings namespace registration (dsh-settings ≥ 0.1.7 derives editable fields from the plugin Config instead); the sidechat namespace is skipped and defaults are used',
        )
      } else if (seam.reason === 'register-failed') {
        console.warn('[dsh-sidechat] settings registration failed; using defaults:', seam.error)
      }
      return
    }
    configScope = seam.scope
    configFace = seam.face
  })
  const getConfig = (): SidechatConfig => {
    try {
      return { ...SIDECHAT_DEFAULTS, ...entryConfig, ...configScope?.get() }
    } catch {
      return SIDECHAT_DEFAULTS
    }
  }

  // ── JSON API ──────────────────────────────────────────────────────────────
  const cache = new Map<string, CacheEntry>()
  const api = buildApi(ctx, getConfig, cache, () => configFace)
  let temporary: ReturnType<typeof createTemporarySessions> | undefined
  ctx.inject(['agents', 'sessionPersistence', 'workspaceRegistry'], (scope) => {
    const manager = createTemporarySessions(scope as unknown as TemporaryHost)
    temporary = manager
    scope.effect(() => () => manager.dispose(), 'sidechat: release temporary agents')
  })
  api['temporary.open'] = payload => {
    if (!temporary) throw new SidechatError('unavailable', 'temporary chat service is unavailable', 503)
    return temporary.open(payload)
  }
  api['temporary.close'] = payload => {
    if (!temporary) throw new SidechatError('unavailable', 'temporary chat service is unavailable', 503)
    return temporary.close(payload)
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/sidechat/api',
    handler: async (req, res) => {
      if (!fence(req)) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith('/sidechat/api/') ? pathname.slice('/sidechat/api/'.length) : undefined
      if (method === undefined || method.includes('/')) {
        writeError(res, new SidechatError('not-found', 'unknown sidechat API method', 404))
        return
      }
      try {
        const payload = await readJsonBody(req)
        const handler = api[method]
        if (handler === undefined) {
          throw new SidechatError('not-found', `unknown sidechat API method "${method}"`, 404)
        }
        writeOk(res, await handler(payload))
      } catch (error) {
        writeError(res, error)
      }
    },
  }), 'dsh-sidechat: /sidechat/api routes')
}
