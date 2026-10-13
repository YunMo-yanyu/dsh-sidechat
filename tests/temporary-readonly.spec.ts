import { describe, expect, it, vi } from 'vitest'
import { installTemporaryReadOnly } from '../src/temporary-readonly.ts'

function fixture() {
  let mode = 'workspace-write'
  const native = new Map(['read', 'glob', 'grep', 'write', 'bash', 'mcp_delete'].map(name => [name, { name, execute: vi.fn(async () => 'ok') }]))
  const own = new Map<string, any>()
  let guard!: (exec: any) => string | undefined
  const commandHandlers = new Map<string, any>()
  const session = { append: vi.fn((type: string, data: any) => { if (type === 'sandbox/mode') mode = data.mode }) }
  const agent = { session: { ...session, header: { cwd: '/test' } } }
  const tools = {
    get: (name: string, scope?: any) => scope ? own.get(name) ?? native.get(name) : native.get(name),
    restrict: vi.fn(), presentAs: vi.fn(),
    register: (tool: any) => own.set(tool.name, tool),
    guard: (callback: typeof guard) => { guard = callback },
  }
  const commands = {
    list: () => ['permission', 'preset', 'fork', 'shell'].map(name => ({ name, description: name })),
    register: (command: any) => commandHandlers.set(command.name, command.handler),
  }
  const services: any = { sandboxPolicy: { resolve: () => ({ mode }) }, fs: { sandboxMode: 'workspace-write', resolve: async (path: string) => ({ targetKey: path, displayPath: path }), stat: async () => ({ type: 'file' }), readBytes: vi.fn(async () => new TextEncoder().encode('test content')), listDir: vi.fn(async () => []), writeText: vi.fn(), editText: vi.fn() }, commands, permissionPresets: { set: vi.fn() } }
  const scope = { tools, commands, get: (name: string) => services[name] }
  const execute = async (name: string, args = {}) => {
    const execution = { name, agent, signal: new AbortController().signal }
    const denied = guard(execution)
    if (denied) throw new Error(denied)
    return own.get(name).execute(args, execution)
  }
  return { scope, agent, native, own, tools, services, commandHandlers, execute, setMode: (value: string) => { mode = value } }
}

describe('temporary read-only capability enforcement', () => {
  it('allows only file reading/listing/search and seeds a separate read-only policy', async () => {
    const f = fixture()
    installTemporaryReadOnly(f.scope, f.agent)
    expect([...f.own.keys()]).toEqual(['read_file', 'list_files', 'search_files'])
    expect(f.services.permissionPresets.set).toHaveBeenCalledWith(f.agent.session, 'read-only')
    expect(await f.execute('read_file', { path: '/test/file' })).toContain('test content')
    expect(await f.execute('list_files')).toBe('')
    expect(await f.execute('search_files', { path: '/test/file', query: 'test' })).toContain('/test/file:1: test content')
    expect(f.services.fs.writeText).not.toHaveBeenCalled()
    expect(f.services.fs.editText).not.toHaveBeenCalled()
    expect(f.native.get('bash')!.execute).not.toHaveBeenCalled()
    expect(f.tools.presentAs).toHaveBeenCalledWith('native')
  })
  it('denies mutating tools even if a plugin registers them in the exempt own layer', async () => {
    const f = fixture()
    installTemporaryReadOnly(f.scope, f.agent)
    for (const name of ['write', 'edit', 'delete', 'bash', 'run_code', 'delegate', 'mcp_delete']) {
      const execute = vi.fn(async () => 'modified')
      f.own.set(name, { name, execute })
      await expect(f.execute(name)).rejects.toThrow('read-only')
      expect(execute).not.toHaveBeenCalled()
    }
  })
  it('denies a different definition that shadows an allowed tool name', async () => {
    const f = fixture()
    installTemporaryReadOnly(f.scope, f.agent)
    const execute = vi.fn(async () => 'modified')
    f.own.set('read_file', { name: 'read_file', execute })
    await expect(f.execute('read_file')).rejects.toThrow('read-only')
    expect(execute).not.toHaveBeenCalled()
  })
  it('blocks permission/preset/fork/command handlers independently of the model prompt', () => {
    const f = fixture()
    installTemporaryReadOnly(f.scope, f.agent)
    for (const handler of f.commandHandlers.values()) expect(handler({ rawInput: 'danger-full-access' })).toMatchObject({ kind: 'error', text: expect.stringContaining('read-only') })
  })
  it('fails closed if the sandbox policy changes, including direct wrapper invocation', async () => {
    const f = fixture()
    installTemporaryReadOnly(f.scope, f.agent)
    f.setMode('danger-full-access')
    await expect(f.execute('read_file')).rejects.toThrow('read-only')
    expect(() => f.own.get('read_file').execute({}, {})).toThrow('read-only')
    expect(f.native.get('read')!.execute).not.toHaveBeenCalled()
  })
  it('works without parent model tools and refuses unconfined hosts', () => {
    const f = fixture()
    f.native.delete('glob'); f.native.delete('grep')
    installTemporaryReadOnly(f.scope, f.agent)
    expect([...f.own.keys()]).toEqual(['read_file', 'list_files', 'search_files'])
    delete f.services.fs.sandboxMode
    expect(() => installTemporaryReadOnly(f.scope, f.agent)).toThrow('sandbox filesystem')
  })
})
