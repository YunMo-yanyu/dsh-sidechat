import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, access, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTemporarySessions, ownedDirectory, type TemporaryHost } from '../src/temporary.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(createWait?: Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'sidechat-'))
  roots.push(root)
  const persistence = { root, locate: (header: any) => ({ path: join(root, 'project', header.id, 'v4.jsonl') }), coldLogMemo: new Map(), stat: async () => ({ header: { cwd: '/test', version: 4, createdAt: 0 } }) }
  const dispose = vi.fn(async () => {})
  const restrict = vi.fn()
  const section = vi.fn()
  const append = vi.fn()
  const readonlyServices = { sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) }, fs: { sandboxMode: 'workspace-write' } }
  const create = vi.fn(async (options: any) => {
    await createWait
    options.setup({ get: (key: string) => (readonlyServices as any)[key], tools: { restrict, guard: vi.fn(), get: vi.fn(), register: vi.fn(), presentAs: vi.fn() }, systemPrompt: { section } }, { session: { append } })
    const header = { id: options.sessionId, cwd: '/test', version: 4, createdAt: 0 }
    const directory = join(root, 'project', header.id)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'v4.jsonl'), 'temporary test chat')
    return { agent: { session: { header }, ctx: {} }, dispose }
  })
  const archiveSession = vi.fn(async () => {})
  const unarchiveSession = vi.fn(async () => {})
  const ctx: TemporaryHost = {
    get: name => name === 'sessionPersistence' ? persistence : { get: () => undefined },
    agents: { create },
    sessionQuery: { readSurface: async () => ({ events: [] }) },
    workspaceRegistry: { archiveSession, unarchiveSession },
  }
  const manager = createTemporarySessions(ctx)
  const payload = { key: 'tab-key', parentSessionId: 'main', model: { provider: 'test', model: 'a', reasoningEffort: 'high' } }
  return { root, ctx, manager, payload, create, dispose, restrict, section, append, archiveSession, unarchiveSession }
}

describe('temporary session ownership', () => {
  it('creates once, uses the parent model, does not archive running conversations, and seeds read-only permissions', async () => {
    const f = await fixture()
    const first = await f.manager.open(f.payload)
    expect(await f.manager.open(f.payload)).toEqual(first)
    expect(f.create).toHaveBeenCalledTimes(1)
    expect(f.create.mock.calls[0]![0].agentOptions).toEqual(f.payload.model)
    expect(f.restrict).toHaveBeenCalledWith({ allow: [] })
    expect(f.append).toHaveBeenCalledWith('sandbox/mode', { mode: 'read-only' })
    expect(f.section.mock.calls[0]![0].complete).toBe(true)
    expect(f.archiveSession).not.toHaveBeenCalled()
    await f.manager.dispose()
  })
  it('drains generation before erasing only its own journal and recovery entry', async () => {
    const f = await fixture()
    await mkdir(join(f.root, 'project', 'main'), { recursive: true })
    await writeFile(join(f.root, 'project', 'main', 'journal'), 'keep')
    const { sessionId } = await f.manager.open(f.payload)
    f.dispose.mockImplementation(async () => { expect(await readFile(join(f.root, 'project', sessionId, 'v4.jsonl'), 'utf8')).toBe('temporary test chat') })
    await f.manager.close({ key: f.payload.key })
    expect(f.dispose).toHaveBeenCalledTimes(1)
    await expect(access(join(f.root, 'project', sessionId))).rejects.toThrow()
    expect(await readFile(join(f.root, 'project', 'main', 'journal'), 'utf8')).toBe('keep')
    expect(JSON.parse(await readFile(join(f.root, '.sidechat-temporary.json'), 'utf8'))).toEqual([])
    expect(f.unarchiveSession).toHaveBeenCalledWith(sessionId)
    await expect(f.manager.open(f.payload)).rejects.toThrow('closed')
  })
  it('closing during creation still disposes the eventual handle and artifact', async () => {
    let release!: () => void
    const wait = new Promise<void>(resolve => { release = resolve })
    const f = await fixture(wait)
    const opening = f.manager.open(f.payload)
    await vi.waitFor(() => expect(f.create).toHaveBeenCalledTimes(1))
    const closing = f.manager.close({ key: f.payload.key })
    release()
    await expect(opening).rejects.toThrow('closed')
    await closing
    expect(f.dispose).toHaveBeenCalledTimes(1)
    expect(JSON.parse(await readFile(join(f.root, '.sidechat-temporary.json'), 'utf8'))).toEqual([])
  })
  it('refuses opening after an early close without creating a session', async () => {
    const f = await fixture()
    await f.manager.close({ key: f.payload.key })
    await expect(f.manager.open(f.payload)).rejects.toThrow('closed')
    expect(f.create).not.toHaveBeenCalled()
  })
  it('cleans journal leftovers from a stopped host before creating the next chat', async () => {
    const f = await fixture()
    const { sessionId } = await f.manager.open(f.payload)
    const restarted = createTemporarySessions(f.ctx)
    await restarted.open({ ...f.payload, key: 'new-tab' })
    await expect(access(join(f.root, 'project', sessionId))).rejects.toThrow()
    await restarted.dispose()
  })
  it('recovers earlier named temporary artifacts during the package rename', async () => {
    const f = await fixture()
    await f.manager.close({ key: 'unrelated' })
    const id = 'session-sidebarqa-temp-11111111-1111-1111-1111-111111111111'
    const directory = join(f.root, 'project', id)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'journal'), 'old temporary chat')
    const ledger = join(f.root, '.sidebarqa-temporary.json')
    await writeFile(ledger, JSON.stringify([{ sessionId: id, directory }]))
    const restarted = createTemporarySessions(f.ctx)
    await restarted.open(f.payload)
    await expect(access(directory)).rejects.toThrow()
    await expect(access(ledger)).rejects.toThrow()
    await restarted.dispose()
  })
  it('does not erase artifacts after a failed drain and retains the retry ledger', async () => {
    const f = await fixture()
    const { sessionId } = await f.manager.open(f.payload)
    f.dispose.mockRejectedValueOnce(new Error('drain failed'))
    await expect(f.manager.close({ key: f.payload.key })).rejects.toThrow('drain failed')
    await access(join(f.root, 'project', sessionId))
    await f.manager.close({ key: f.payload.key })
    await expect(access(join(f.root, 'project', sessionId))).rejects.toThrow()
  })
  it('refuses a symlink to an unrelated directory during deletion', async () => {
    const f = await fixture()
    const { sessionId } = await f.manager.open(f.payload)
    const other = await mkdtemp(join(tmpdir(), 'sidechat-other-')); roots.push(other)
    await writeFile(join(other, 'keep'), 'keep')
    const dir = join(f.root, 'project', sessionId)
    await rm(dir, { recursive: true })
    await symlink(other, dir)
    await expect(f.manager.close({ key: f.payload.key })).rejects.toThrow('symlink')
    expect(await readFile(join(other, 'keep'), 'utf8')).toBe('keep')
  })
  it('refuses unsupported backends before taking ownership', () => {
    expect(() => createTemporarySessions({ get: () => ({}) } as any)).toThrow('JSONL')
  })
  it('rejects parent identities, traversal, and mismatched owned directories', () => {
    const id = 'session-sidechat-temp-11111111-1111-1111-1111-111111111111'
    expect(() => ownedDirectory('/safe', '/safe/main/log', 'main')).toThrow()
    expect(() => ownedDirectory('/safe', `/elsewhere/${id}/log`, id)).toThrow()
    expect(() => ownedDirectory('/safe', '/safe/wrong/log', id)).toThrow()
  })
})
