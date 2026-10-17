/** Revision-guarded settings access for legacy namespaces and current profile forms. */
import type { SidechatSettingsScope, SidechatSettingsService } from './context-types.ts'

/** One namespace view: the resolved value plus the revision it was read at. */
export interface SidechatConfigView {
  value?: unknown
  revision?: number
}

/** The revision-guarded read/write face the `/sidechat/api` config routes use. */
export interface SidechatConfigFace {
  get(): SidechatConfigView
  update(patch: Record<string, unknown>, expectedRevision?: number): Promise<SidechatConfigView>
}

/**
 * Why the namespace is unavailable.
 * - `service-missing`: no `ctx.settings` at all (the caller's `inject` callback
 *   does not run in that deployment, so this is the defensive branch).
 * - `no-register`: neither supported settings API is available.
 * - `register-failed`: registration itself refused (duplicate namespace, schema
 *   clash, a provider that throws). Genuinely unexpected: worth a warning.
 */
export type SidechatSettingsSeamReason = 'service-missing' | 'no-register' | 'register-failed'

/** The probe result: an opened scope plus its face, or why there is none. */
export type SidechatSettingsSeam<T> =
  | { ok: true; scope: Pick<SidechatSettingsScope<T>, 'get'>; face: SidechatConfigFace }
  | { ok: false; reason: SidechatSettingsSeamReason; error?: unknown }

/**
 * Build the read/write face over an already-registered namespace.
 *
 * `describe` / `update` are probed separately: a host that registers namespaces
 * may still drop either one, and every call site here must degrade instead of
 * throwing an opaque `… is not a function` from inside a route handler.
 * @param service - the (structurally probed) settings service.
 * @param ns - the namespace this face reads and writes.
 * @returns the revision-guarded face.
 */
function faceOf(service: Partial<SidechatSettingsService>, namespace: string | (() => string | undefined)): SidechatConfigFace {
  const describe = typeof service.describe === 'function' ? service.describe.bind(service) : undefined
  const update = typeof service.update === 'function' ? service.update.bind(service) : undefined
  const empty: SidechatConfigView = { value: undefined, revision: undefined }
  const namespaceOf = (): string => {
    const ns = typeof namespace === 'function' ? namespace() : namespace
    if (!ns) throw new Error('Sidechat has no owning profile entry for settings')
    return ns
  }
  const viewOf = (): SidechatConfigView => {
    if (describe === undefined) return empty
    const listed: unknown = describe({ redactSecrets: true })
    if (!Array.isArray(listed)) return empty
    const ns = namespaceOf()
    const descriptor = listed.find(candidate => (candidate as { ns?: unknown } | null)?.ns === ns)
    return descriptor === undefined
      ? empty
      : {
          value: (descriptor as { value?: unknown }).value,
          revision: (descriptor as { revision?: number }).revision,
        }
  }
  return {
    get: viewOf,
    update: async (patch, expectedRevision) => {
      if (update === undefined) {
        throw new Error('this host exposes no settings.update for a registered namespace')
      }
      await update(namespaceOf(), patch, expectedRevision)
      return viewOf()
    },
  }
}

/**
 * Probe the settings service and, when it can carry a namespace, open ours.
 * @param service - `ctx.settings`, read structurally (never trusted by type).
 * @param ns - the namespace to register (`sidechat`).
 * @param schema - the namespace schema (schemastery).
 * @returns the opened scope + face, or a typed refusal that never throws.
 */
export function openSettingsSeam<T>(service: unknown, ns: string, schema: unknown, entryId?: () => string | undefined): SidechatSettingsSeam<T> {
  if (service === null || service === undefined) return { ok: false, reason: 'service-missing' }
  const probe = service as Partial<SidechatSettingsService>
  if (typeof probe.register !== 'function') {
    if (typeof probe.describe !== 'function' || typeof probe.update !== 'function' || entryId === undefined) {
      return { ok: false, reason: 'no-register' }
    }
    const face = faceOf(probe, entryId)
    return { ok: true, face, scope: { get: () => face.get().value as T } }
  }
  try {
    const scope = probe.register<T>(ns, schema)
    return { ok: true, scope, face: faceOf(probe, ns) }
  } catch (error) {
    return { ok: false, reason: 'register-failed', error }
  }
}
