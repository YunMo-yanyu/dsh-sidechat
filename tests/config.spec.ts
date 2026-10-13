import { describe, expect, it } from 'vitest'
import { SIDECHAT_DEFAULTS, SidechatPrefsSchema } from '../src/config.ts'

/**
 * Regression guard for the PR #3 class of bug ("panel changes fail to save"):
 * the host registers the `sidechat` namespace through schemastery, so a
 * schema that throws on defaults / panel patches / stale yaml keys leaves
 * `configFace` undefined and `/sidechat/api/config.update` answers 503.
 * Every future settings key must keep these passes green.
 */

/** Call the schemastery schema with untyped input (mirrors the runtime seam,
 *  where the settings service passes unknown user values). */
function parse(input: unknown): unknown {
  return (SidechatPrefsSchema as unknown as { (input: unknown): unknown })(input)
}

describe('SidechatPrefsSchema (settings registration surface)', () => {
  it('parses an empty config into the full defaults (registration with no user config)', () => {
    expect(parse({})).toEqual(SIDECHAT_DEFAULTS)
  })

  it('fills defaults for a partial user config (settings.yaml merge)', () => {
    expect(parse({ historyStrategy: 'inherit' })).toEqual({
      ...SIDECHAT_DEFAULTS,
      historyStrategy: 'inherit',
    })
  })

  it('accepts every panel patch the ConfigPanel can send', () => {
    const patches: unknown[] = [
      { historyStrategy: 'trim' },
      { trimWindowMessages: 42 },
      { answerProvider: 'deepseek-official' },
      { answerModel: 'deepseek-v4' },
      { answerReasoningEffort: 'high' },
      { summarizeProvider: '' },
      { summarizeModel: 'deepseek-v4-flash' },
      { summarizeReasoningEffort: 'off' },
    ]
    for (const patch of patches) {
      expect(parse(patch)).toMatchObject(patch as Record<string, unknown>)
    }
  })

  it('rejects values outside the declared vocabulary instead of accepting them', () => {
    expect(() => parse({ historyStrategy: 'bogus' })).toThrow()
    expect(() => parse({ trimWindowMessages: 999 })).toThrow()
    expect(() => parse({ answerReasoningEffort: 'ultra' })).toThrow()
  })

  it('tolerates unknown keys (stale/extra settings.yaml entries must not break registration)', () => {
    expect(parse({ foo: 1, historyStrategy: 'trim' })).toMatchObject({
      foo: 1,
      historyStrategy: 'trim',
    })
  })

  it('round-trips the full defaults object', () => {
    expect(parse(SIDECHAT_DEFAULTS)).toEqual(SIDECHAT_DEFAULTS)
  })
})
