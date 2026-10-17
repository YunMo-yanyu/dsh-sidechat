import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { Config } from '../src/config.ts'

const root = process.env.DSH_INSTALL_ROOT
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

describe.skipIf(!root)('installed Harness contracts', () => {
  let boot: any
  let cordis: any
  let cosmokit: any
  let runtimeVersion: string
  beforeAll(async () => {
    const load = (name: string) => import(pathToFileURL(join(root!, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href)
    boot = await load('dsh-app-boot')
    cordis = await load('cordis')
    cosmokit = await load('cosmokit')
    runtimeVersion = JSON.parse(readFileSync(join(root!, 'package.json'), 'utf8')).version
  })

  it('passes the running host compatibility gate', () => {
    expect(boot.evaluatePluginCompatibility(manifest, {}, runtimeVersion)).toBeUndefined()
    expect(boot.evaluatePluginCompatibility(manifest, {}, '0.2.0-rc.1')).toMatchObject({ requirements: { 'engines.dsh': manifest.engines.dsh } })
  })

  it('exports metadata that the real host resolves in Chinese and English', () => {
    const meta = boot.readPluginMeta(manifest.name, new URL('../package.json', import.meta.url).href)
    expect(meta.error).toBeUndefined()
    expect(meta.title.zh).toBe('Sidechat 侧边临时会话')
    expect(meta.description.zh).toBe(manifest.description)
    expect(meta.description.en).toContain('Read-only')
  })

  it('keeps Config references live across the host library boundary', () => {
    const config = cordis.resolveConfig({ Config }, { trimWindowMessages: 10 })
    expect(cosmokit.isVolatile(config)).toBe(true)
    cosmokit.updateVolatile(config, Config({ trimWindowMessages: 27 }))
    expect(config.get().trimWindowMessages).toBe(27)
    expect(() => cordis.resolveConfig({ Config }, { trimWindowMessages: 0 })).toThrow()
  })
})
