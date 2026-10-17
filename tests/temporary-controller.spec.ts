import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTemporaryController } from '../src/client/temporary-controller.ts'
import { sidechatApi } from '../src/client/api.ts'
import type { Context } from '../src/context-types.ts'

vi.mock('../src/client/api.ts', () => ({ sidechatApi: {
  temporaryOpen: vi.fn(), temporaryClose: vi.fn(async () => ({ closed: true })),
} }))

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('temporary conversations over plain HTTP', () => {
  it('opens and closes without crypto.randomUUID on a LAN origin', async () => {
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => { bytes.fill(3); return bytes } })
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
    vi.mocked(sidechatApi.temporaryOpen).mockImplementation(() => new Promise(() => {}))
    const cleanups: Array<() => void> = []
    const ctx = { sessions: {}, effect: (fn: () => () => void) => { cleanups.push(fn()) } } as unknown as Context
    const controller = createTemporaryController(ctx)
    const signal = new AbortController()
    const entry = controller.forTab('main-session', signal.signal)
    expect(entry.getSnapshot().phase).toBe('loading')
    expect(sidechatApi.temporaryOpen).toHaveBeenCalledWith({
      key: '03030303-0303-4303-8303-030303030303', parentSessionId: 'main-session', model: undefined,
    })
    signal.abort()
    expect(entry.getSnapshot().phase).toBe('closed')
    expect(sidechatApi.temporaryClose).toHaveBeenCalledWith('03030303-0303-4303-8303-030303030303')
    cleanups.forEach(cleanup => cleanup())
  })
})
