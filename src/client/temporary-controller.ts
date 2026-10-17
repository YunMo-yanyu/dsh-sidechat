import { sidechatApi } from './api.ts'
import { currentModelOf, mintRequestId } from './session-wire.ts'
import type { Context } from '../context-types.ts'

export interface TemporaryState { phase: 'loading' | 'ready' | 'error' | 'closed'; sessionId?: string; reference?: any; error?: string }
export function createTemporaryController(ctx: Context) {
  const active = new Set<() => void>()
  let disposed = false
  const onPageHide = () => { active.forEach(close => close()) }
  window.addEventListener('pagehide', onPageHide)
  ctx.effect(() => () => { disposed = true; window.removeEventListener('pagehide', onPageHide); onPageHide() }, 'sidechat: temporary page lifetime')
  const entries = new WeakMap<AbortSignal, { getSnapshot(): TemporaryState; subscribe(fn: () => void): () => void }>()
  return {
    forTab(parentSessionId: string, signal: AbortSignal) {
      const existing = entries.get(signal)
      if (existing) return existing
      const key = mintRequestId()
      let state: TemporaryState = { phase: 'loading' }
      let reference: any
      const listeners = new Set<() => void>()
      const publish = (next: TemporaryState) => { state = next; listeners.forEach(fn => fn()) }
      let isClosed = false
      const close = () => {
        if (isClosed) return
        isClosed = true
        active.delete(close)
        publish({ phase: 'closed' })
        reference?.release()
        void sidechatApi.temporaryClose(key).then(() => {
          const sessionId = reference?.sessionId
          if (sessionId) {
            // Native draft storage belongs to this temporary identity only.
            localStorage.removeItem(`dsh.conversation.${sessionId}`)
            localStorage.removeItem(`dsh.sidebarRight.${sessionId}`)
          }
          if (!disposed) void (ctx.sessions as any).refresh()
        }).catch(error => console.error('[sidechat] temporary cleanup failed:', error))
      }
      active.add(close)
      signal.addEventListener('abort', close, { once: true })
      const store = { getSnapshot: () => state, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } } }
      entries.set(signal, store)
      if (signal.aborted) { close(); return store }
      void (async () => {
        try {
          const model = currentModelOf(ctx, parentSessionId)
          const created = await sidechatApi.temporaryOpen({ key, parentSessionId, model })
          if (isClosed) { await sidechatApi.temporaryClose(key); return }
          // Standard web routing installs its own selection reference. Commit the
          // captured main selection before rendering to defeat a changed global default.
          if (model && !isClosed) {
            const selected = await ctx.remote.session.selectModel({ sessionId: created.sessionId, ...model })
            if (!selected.ok) throw new Error(selected.error.message)
          }
          if (isClosed) { await sidechatApi.temporaryClose(key); return }
          await (ctx.sessions as any).refresh()
          if (isClosed) { await sidechatApi.temporaryClose(key); return }
          reference = (ctx.sessions as any).retain(created.sessionId, { source: 'sidechat-temporary' })
          await reference.ready
          if (isClosed) { reference.release(); await sidechatApi.temporaryClose(key); return }
          publish({ phase: 'ready', sessionId: created.sessionId, reference })
        } catch (error) {
          await sidechatApi.temporaryClose(key).catch(console.error)
          if (!isClosed) publish({ phase: 'error', error: error instanceof Error ? error.message : String(error) })
        }
      })()
      return store
    },
  }
}
export type TemporaryController = ReturnType<typeof createTemporaryController>
