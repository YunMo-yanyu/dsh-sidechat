import { temporaryFileTools } from './temporary-files.ts'
const DENIED = 'This temporary chat is read-only. Return to the main conversation to perform actions.'

export function installTemporaryReadOnly(scope: any, agent: any) {
  const policy = scope.get('sandboxPolicy')
  const fs = scope.get('fs')
  const commands = scope.get('commands')
  if (!policy || fs?.sandboxMode === undefined || typeof scope.tools.guard !== 'function') {
    throw new Error('temporary read-only chat requires the Harness sandbox filesystem and tool execution guards')
  }

  // Seed before publication, so the host cannot apply the writable default.
  const permissions = scope.get('permissionPresets')
  permissions?.set(agent.session, 'read-only')
  agent.session.append('sandbox/mode', { mode: 'read-only' })

  const definitions = new Map<string, any>()
  for (const original of temporaryFileTools(fs, agent.session.header?.cwd)) {
    const definition = {
      ...original,
      execute: (args: unknown, execution: any) => {
        if (policy.resolve({ session: agent.session }).mode !== 'read-only') throw new Error(DENIED)
        return original.execute(args, execution)
      },
    }
    definitions.set(definition.name, definition)
  }
  scope.tools.restrict({ allow: [] })
  scope.tools.presentAs('native')
  for (const definition of definitions.values()) scope.tools.register(definition)
  scope.tools.guard((execution: any) => {
    const pinned = definitions.get(execution.name)
    return pinned && scope.tools.get(execution.name, execution.agent) === pinned
      && policy.resolve({ session: agent.session }).mode === 'read-only' ? undefined : DENIED
  })

  // Slash commands bypass model tools. Shadow them in this agent only, so
  // /permission, /preset, /fork, etc. cannot turn a side question into work.
  for (const command of commands?.list(agent) ?? []) {
    commands.register({
      ...command,
      handler: () => ({ kind: 'error', text: DENIED }),
    })
  }
}
