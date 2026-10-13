import { describe, expect, it, vi } from 'vitest'
import { temporaryFileTools } from '../src/temporary-files.ts'

function fixture() {
  const files = new Map<string, string | Uint8Array>([['/workspace/main.ts', 'alpha\n机器人 beta\ngamma'], ['/workspace/src/helper.ts', '机器人 helper']])
  const directories = new Map([['/workspace', ['main.ts', 'src', 'node_modules']], ['/workspace/src', ['helper.ts']], ['/workspace/node_modules', ['ignored.ts']]])
  const resolve = (path: string) => ({ targetKey: path, displayPath: path })
  const fs = {
    resolve: vi.fn(async (path: string, { cwd }: any) => resolve(path.startsWith('/') ? path : cwd + '/' + path)),
    stat: async ({ targetKey }: any) => directories.has(targetKey) ? { type: 'directory' } : files.has(targetKey) ? { type: 'file', size: new TextEncoder().encode(String(files.get(targetKey))).length } : undefined,
    readBytes: vi.fn(async ({ targetKey }: any, _signal: any, max: number) => {
      const content = files.get(targetKey)!
      const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
      if (bytes.length > max) throw new Error('too large')
      return bytes
    }),
    listDir: async ({ targetKey }: any) => (directories.get(targetKey) ?? []).map(name => ({ name, target: resolve(targetKey + '/' + name), type: directories.has(targetKey + '/' + name) ? 'directory' : 'file' })),
  }
  const definitions = temporaryFileTools(fs, '/workspace')
  const execute = (name: string, args: any, signal = new AbortController().signal) => definitions.find(tool => tool.name === name)!.execute(args, { signal })
  return { fs, files, directories, definitions, execute }
}

describe('temporary file inspection', () => {
  it('resolves relative paths against the main workspace and returns a numbered window', async () => {
    const f = fixture()
    expect(await f.execute('read_file', { path: 'main.ts', offset: 2, limit: 1 })).toContain('2: 机器人 beta')
    expect(f.fs.resolve).toHaveBeenCalledWith('main.ts', { cwd: '/workspace' })
  })
  it('lists and recursively searches files without treating the query as a command', async () => {
    const f = fixture()
    expect(await f.execute('list_files', { path: '/workspace' })).toContain('directory: /workspace/src')
    const found = await f.execute('search_files', { path: '/workspace', query: '机器人' })
    expect(found).toContain('/workspace/main.ts:2: 机器人 beta')
    expect(found).toContain('/workspace/src/helper.ts:1: 机器人 helper')
    expect(found).not.toContain('ignored.ts')
    expect(await f.execute('search_files', { path: '/workspace', query: '$(touch hacked)' })).toContain('[no matches]')
  })
  it('refuses binary, oversized, and non-file reads, and reports skipped search inputs', async () => {
    const f = fixture()
    f.files.set('/workspace/binary', new Uint8Array([0, 1, 2]))
    f.files.set('/workspace/large', 'x'.repeat(2 * 1024 * 1024 + 1))
    await expect(f.execute('read_file', { path: '/workspace/binary' })).rejects.toThrow('binary')
    await expect(f.execute('read_file', { path: '/workspace/large' })).rejects.toThrow('too large')
    await expect(f.execute('read_file', { path: '/workspace' })).rejects.toThrow('regular text')
    expect(await f.execute('search_files', { path: '/workspace/binary', query: 'x' })).toContain('skipped 1')
  })
  it('honors cancellation before reading, invalid windows, and output bounds', async () => {
    const f = fixture()
    const abort = new AbortController(); abort.abort()
    await expect(f.execute('read_file', { path: '/workspace/main.ts' }, abort.signal)).rejects.toThrow()
    expect(f.fs.readBytes).not.toHaveBeenCalled()
    await expect(f.execute('read_file', { path: '/workspace/main.ts', offset: 0 })).rejects.toThrow('positive integers')
    f.files.set('/workspace/long', 'a'.repeat(100000))
    expect((await f.execute('read_file', { path: '/workspace/long' })).length).toBeLessThan(66000)
  })
  it('bounds directory cycles and the search frontier', async () => {
    const f = fixture()
    f.fs.listDir = async () => Array.from({ length: 1500 }, (_, index) => ({ name: 'file' + index, type: 'directory', target: { targetKey: '/workspace', displayPath: '/workspace' } }))
    const found = await f.execute('search_files', { path: '/workspace', query: 'alpha' })
    expect(found).toContain('visited 1')
    expect(found).toContain('skipped 500')
  })
})
