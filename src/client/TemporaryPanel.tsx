import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { SidechatTabComponentProps } from '../context-types.ts'
import type { SidechatStore } from './store.ts'
import type { TemporaryController } from './temporary-controller.ts'
import { useLocaleRevision } from './use-locale.ts'
import { promptLocale } from './locales.ts'
import css from './temporary-panel.module.css'

export function TemporaryPanel(props: SidechatTabComponentProps & { store: SidechatStore; temporary: TemporaryController }) {
  const { ctx, scope, tab, store, temporary, sidebar, SessionProvider, renderSlot } = props
  useLocaleRevision()
  const zh = promptLocale() === 'zh'
  const signal = tab.signal
  const entry = useMemo(() => signal ? temporary.forTab(scope.sessionId, signal) : undefined, [temporary, scope.sessionId, signal])
  const state = useSyncExternalStore(entry?.subscribe ?? (() => () => {}), entry?.getSnapshot ?? (() => undefined))
  const pending = useSyncExternalStore(store.subscribe, store.getSnapshot).pendingBySession[scope.sessionId]
  const quote = useMemo(() => sidebar?.takeQuote() ?? pending ?? null, [sidebar?.revision, pending])
  useEffect(() => {
    if (state?.phase !== 'ready' || !quote) return
    const actx = ctx.sessions.scope(state.sessionId!)
    const conversation = ctx.get('conversation')
    if (!actx || !conversation) return
    const input = conversation.input.for(actx)
    const quoted = quote.text.split('\n').map(line => `> ${line}`).join('\n')
    const draft = input.state.getSnapshot().draft
    input.setDraft(`${draft === '' ? '' : draft + '\n\n'}${quoted}\n\n`)
    input.focus()
    store.setPendingQuote(scope.sessionId, null)
  }, [state, quote])
  if (!signal || !SessionProvider || !renderSlot) return <div role="alert">{zh ? '当前 Harness 缺少临时会话所需的嵌入接口。' : 'This Harness is missing the embedded conversation interface.'}</div>
  return <div className={css.panel} data-sidechat-temporary="">
    <div className={css.notice}>{zh ? '只读解答 · 可读取和搜索文件 · 关闭标签后清除' : 'Read-only answers · file reading and search · cleared when this tab closes'}</div>
    {state?.phase === 'error' ? <div className={css.status} role="alert">{state.error}</div>
      : state?.phase !== 'ready' ? <div className={css.status} role="status">{zh ? '正在准备临时会话…' : 'Preparing temporary chat…'}</div>
      : <SessionProvider session={state.reference}>
          {renderSlot('sidechat.temporary.conversation', {})}
        </SessionProvider>}
  </div>
}

const FixedChatViews = (props: any) => <div className={css.views}>{props.renderSlot('conversation.session', { view: 'chat' })}</div>
export function EmbeddedConversation(props: any) {
  return props.renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active', hero: false }, { slots: { views: FixedChatViews } })
}
