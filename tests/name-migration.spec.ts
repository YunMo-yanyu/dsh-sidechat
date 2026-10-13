import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSidechatStore } from '../src/client/store.ts'

const storage = (initial: Record<string, string>) => {
  const values = new Map(Object.entries(initial))
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) })
  return values
}
afterEach(() => vi.unstubAllGlobals())

describe('Sidechat naming migration', () => {
  it('retains earlier history, titles and collapse state under the new package keys', () => {
    const values = storage({ 'dsh-sidebar-qa:map': '{"main":["followup"]}', 'dsh-sidebar-qa:titled': '["followup"]', 'dsh-sidebar-qa:collapsed': '["main"]' })
    const store = createSidechatStore()
    expect(store.childrenOf('main')).toEqual(['followup'])
    expect(store.isTitled('followup')).toBe(true)
    expect(store.isCollapsed('main')).toBe(true)
    for (const suffix of ['map', 'titled', 'collapsed']) expect(values.get('dsh-sidechat:' + suffix)).toBe(values.get('dsh-sidebar-qa:' + suffix))
  })
  it('keeps current data authoritative and does not resurrect removed records', () => {
    storage({ 'dsh-sidebar-qa:map': '{"main":["old"]}', 'dsh-sidechat:map': '{}' })
    expect(createSidechatStore().childrenOf('main')).toEqual([])
  })
})
