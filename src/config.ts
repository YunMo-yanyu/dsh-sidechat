/**
 * Configuration for the host summarize service and the side-session answer
 * model. The user-facing knobs live in the DSH settings service under the
 * `sidechat` namespace (schemastery schema); deployments without a settings
 * service fall back to {@link SIDECHAT_DEFAULTS}.
 */
import z from 'schemastery'

/** Settings namespace id. */
export const SIDECHAT_SETTINGS_NS = 'sidechat'

/** DSH reasoning-effort vocabulary: Off / High / Max. */
export type SidechatReasoningEffort = 'off' | 'high' | 'max'

/**
 * The side-question history strategy: how the parent conversation's context
 * reaches the side session.
 * - `inherit`: fork the parent (full history seed → provider prefix-cache hits).
 * - `compressed`: compress the earlier window with the fast model + verbatim recent.
 * - `trim`: keep the last `trimWindowMessages` messages verbatim, zero LLM cost.
 */
export type SidechatHistoryStrategy = 'inherit' | 'compressed' | 'trim'

/** User-editable configuration. */
export interface SidechatConfig {
  // ── History strategy (how the parent context reaches the side session) ───
  /** 'inherit' | 'compressed' | 'trim'; the per-ask selector defaults to this. */
  historyStrategy: SidechatHistoryStrategy
  /** How many recent messages `trim` keeps verbatim (no model involved). */
  trimWindowMessages: number

  // ── Summarize (fast no-thinking compression) ─────────────────────────────
  /** Registered provider route for the fast model; '' = inherit the main session's provider. */
  summarizeProvider: string
  /** Fast no-thinking chat model id. */
  summarizeModel: string
  /** Thinking effort for the fast model: Off / High / Max. */
  summarizeReasoningEffort: SidechatReasoningEffort
  /** Output budget of the generated BACKGROUND summary, in tokens (soft bound). */
  summarizeBudgetTokens: number
  /** How many recent messages to keep VERBATIM (the current-state anchor). */
  recentWindowMessages: number
  /** How many earlier messages to send to the model for background compression. */
  backgroundWindowMessages: number

  // ── Answer (side-session conversation model) ─────────────────────────────
  /** Provider route for the side session's answer model. */
  answerProvider: string
  /** Model id for the side session's answer model. */
  answerModel: string
  /** Thinking effort for the answer model: Off / High / Max. */
  answerReasoningEffort: SidechatReasoningEffort

  // ── Title (post-answer retitle, reuses the summarize model route) ─────────
  /** Output-token cap for the post-answer title generation. */
  titleBudgetTokens: number
}

/** Schema-backed defaults (also used when the settings service is absent). */
export const SIDECHAT_DEFAULTS: SidechatConfig = {
  historyStrategy: 'compressed',
  trimWindowMessages: 10,
  summarizeProvider: '',
  summarizeModel: 'deepseek-v4-flash',
  summarizeReasoningEffort: 'off',
  summarizeBudgetTokens: 160,
  recentWindowMessages: 2,
  backgroundWindowMessages: 12,
  answerProvider: 'deepseek-official',
  answerModel: 'deepseek-v4-flash',
  answerReasoningEffort: 'off',
  titleBudgetTokens: 64,
}

/** Schemastery schema for the `sidechat` settings namespace. */
export const SidechatPrefsSchema = z.object({
  historyStrategy: z.union(['inherit', 'compressed', 'trim']).default(SIDECHAT_DEFAULTS.historyStrategy),
  trimWindowMessages: z.number().step(1).min(1).max(256).default(SIDECHAT_DEFAULTS.trimWindowMessages),
  summarizeProvider: z.string().default(SIDECHAT_DEFAULTS.summarizeProvider),
  summarizeModel: z.string().default(SIDECHAT_DEFAULTS.summarizeModel),
  summarizeReasoningEffort: z.union(['off', 'high', 'max']).default(SIDECHAT_DEFAULTS.summarizeReasoningEffort),
  summarizeBudgetTokens: z.number().step(1).min(64).max(8192).default(SIDECHAT_DEFAULTS.summarizeBudgetTokens),
  recentWindowMessages: z.number().step(1).min(1).max(64).default(SIDECHAT_DEFAULTS.recentWindowMessages),
  backgroundWindowMessages: z.number().step(1).min(1).max(256).default(SIDECHAT_DEFAULTS.backgroundWindowMessages),
  answerProvider: z.string().default(SIDECHAT_DEFAULTS.answerProvider),
  answerModel: z.string().default(SIDECHAT_DEFAULTS.answerModel),
  answerReasoningEffort: z.union(['off', 'high', 'max']).default(SIDECHAT_DEFAULTS.answerReasoningEffort),
  titleBudgetTokens: z.number().step(1).min(16).max(256).default(SIDECHAT_DEFAULTS.titleBudgetTokens),
})
