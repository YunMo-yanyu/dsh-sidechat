const FILE_BYTES = 2 * 1024 * 1024
const OUTPUT_CHARS = 64 * 1024
const SEARCH_ENTRIES = 1000
const SEARCH_BYTES = 32 * 1024 * 1024
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '.dsh'])

/** A small, explicit read-only surface; no shell, write API, or delegated tools. */
export function temporaryFileTools(fs: any, cwd: string | undefined) {
  const pathTarget = (path: unknown, fallback = false) => {
    if (fallback && path === undefined) path = cwd ?? '.'
    if (typeof path !== 'string' || path.trim() === '') throw new Error('path must be a non-empty string')
    return fs.resolve(path, { cwd })
  }
  const text = async (target: any, signal: AbortSignal) => {
    signal.throwIfAborted()
    const info = await fs.stat(target, signal)
    if (info?.type !== 'file') throw new Error('path must name a regular text file')
    const bytes = await fs.readBytes(target, signal, FILE_BYTES)
    if (bytes.includes(0)) throw new Error('binary files are not supported')
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  const tool = (name: string, description: string, properties: any, required: string[], execute: (args: any, signal: AbortSignal) => Promise<string>) => ({
    name, description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
    execute: (args: any, execution: any) => execute(args, execution.signal),
  })
  const path = { type: 'string', description: 'File or directory path, relative to the main conversation workspace or absolute.' }
  return [
    tool('read_file', 'Read a UTF-8 text file with line numbers. Files are limited to 2 MiB per call.', {
      path, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 2000 },
    }, ['path'], async (args, signal) => {
      const offset = args.offset ?? 1, limit = args.limit ?? 2000
      if (!Number.isInteger(offset) || offset < 1 || !Number.isInteger(limit) || limit < 1 || limit > 2000) throw new Error('offset and limit must be positive integers; limit must not exceed 2000')
      const target = await pathTarget(args.path)
      const lines = (await text(target, signal)).split('\n')
      const selected = lines.slice(offset - 1, offset - 1 + limit).map((line, index) => `${offset + index}: ${line}`).join('\n')
      return `${target.displayPath} (${lines.length} lines)\n${selected.slice(0, OUTPUT_CHARS)}${selected.length > OUTPUT_CHARS || offset - 1 + limit < lines.length ? '\n[truncated; use offset/limit to continue]' : ''}`
    }),
    tool('list_files', 'List the immediate files and directories in a directory. Does not execute commands.', { path }, [], async (args, signal) => {
      signal.throwIfAborted()
      const target = await pathTarget(args.path, true)
      const entries = await fs.listDir(target, signal)
      const output = entries.slice(0, SEARCH_ENTRIES).map((entry: any) => `${entry.type}: ${entry.target.displayPath}`).join('\n')
      return `${output.slice(0, OUTPUT_CHARS)}${entries.length > SEARCH_ENTRIES || output.length > OUTPUT_CHARS ? '\n[truncated]' : ''}`
    }),
    tool('search_files', 'Search a literal string in a text file or recursively in a directory. Bounded search; skips .git, node_modules, .dsh, binary and over-2-MiB files. Returns paths and line numbers.', {
      path, query: { type: 'string', description: 'Literal text to find, not a regular expression or command.' },
    }, ['query'], async (args, signal) => {
      if (typeof args.query !== 'string' || args.query.length === 0 || args.query.length > 1000) throw new Error('query must contain 1 to 1000 characters')
      const pending = [await pathTarget(args.path, true)]
      const seen = new Set<string>()
      const matches: string[] = []
      let visited = 0, chars = 0, skipped = 0, bytesRead = 0, byteLimit = false
      while (pending.length && visited < SEARCH_ENTRIES && chars < OUTPUT_CHARS) {
        signal.throwIfAborted()
        const target = pending.shift()!
        if (seen.has(target.targetKey)) continue
        seen.add(target.targetKey); visited++
        const info = await fs.stat(target, signal)
        if (info?.type === 'directory') {
          const entries = await fs.listDir(target, signal)
          // Keep the pending frontier bounded even for extremely wide directories.
          for (const entry of entries) {
            if (entry.type === 'other' || SKIP_DIRECTORIES.has(entry.name)) continue
            if (pending.length >= SEARCH_ENTRIES) { skipped++; continue }
            pending.push(entry.target)
          }
        } else if (info?.type === 'file') {
          const size = Math.min(info.size ?? FILE_BYTES, FILE_BYTES)
          if (bytesRead + size > SEARCH_BYTES) { byteLimit = true; break }
          bytesRead += size
          let content: string
          try { content = await text(target, signal) }
          catch (error) { signal.throwIfAborted(); skipped++; continue }
          const lines = content.split('\n')
          for (let index = 0; index < lines.length && chars < OUTPUT_CHARS; index++) {
            if (!lines[index]!.includes(args.query)) continue
            const match = `${target.displayPath}:${index + 1}: ${lines[index]!.slice(0, 1000)}`
            matches.push(match); chars += match.length + 1
          }
        }
      }
      return `${matches.join('\n').slice(0, OUTPUT_CHARS) || '[no matches]'}\n[visited ${visited}; skipped ${skipped}${pending.length || chars >= OUTPUT_CHARS || byteLimit ? '; truncated' : ''}]`
    }),
  ]
}
