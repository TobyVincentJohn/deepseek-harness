/** Configuration resolution for deterministic tool-result pruning. */

import { deepFreeze } from '@deepseek-ai/dsh-llm'
import type { ResolvedConfig, ToolResultPruneConfig } from './types.ts'

/** Fixed marker substituted for every removed middle span. */
export const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n'
/** Marker retained inside bounded tool-call argument previews. */
export const INPUT_PRUNE_MARKER = '[... tool input middle pruned ...]'
/** Conservative maximum JSON metadata overhead outside the configured input preview. */
const INPUT_REPLACEMENT_OVERHEAD_CHARS = 256

/** Low-friction defaults for coding-agent tool output. */
export const DEFAULTS: ResolvedConfig = deepFreeze({
  thresholdChars: 8192,
  headChars: 4096,
  tailChars: 1024,
  inputThresholdChars: 8192,
  inputPreviewChars: 512,
})

const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'thresholdChars',
  'headChars',
  'tailChars',
  'inputThresholdChars',
  'inputPreviewChars',
])

/**
 * Count Unicode code points without splitting surrogate pairs.
 * @param text - text to measure.
 * @returns the Unicode code-point count.
 */
export function codePointLength(text: string): number {
  return Array.from(text).length
}

/**
 * Resolve and validate pruning budgets.
 * @param config - raw plugin configuration.
 * @returns a detached deeply immutable configuration.
 */
export function resolveConfig(config: ToolResultPruneConfig = {}): ResolvedConfig {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(
        `ToolResultPruneConfig: unknown key "${key}" `
        + '(allowed: thresholdChars, headChars, tailChars, inputThresholdChars, inputPreviewChars)',
      )
    }
  }

  const resolved: ResolvedConfig = {
    thresholdChars: config.thresholdChars ?? DEFAULTS.thresholdChars,
    headChars: config.headChars ?? DEFAULTS.headChars,
    tailChars: config.tailChars ?? DEFAULTS.tailChars,
    inputThresholdChars: config.inputThresholdChars ?? DEFAULTS.inputThresholdChars,
    inputPreviewChars: config.inputPreviewChars ?? DEFAULTS.inputPreviewChars,
  }
  assertPositiveInteger('thresholdChars', resolved.thresholdChars)
  assertNonNegativeInteger('headChars', resolved.headChars)
  assertNonNegativeInteger('tailChars', resolved.tailChars)
  assertPositiveInteger('inputThresholdChars', resolved.inputThresholdChars)
  assertNonNegativeInteger('inputPreviewChars', resolved.inputPreviewChars)

  const emittedChars = resolved.headChars
    + codePointLength(PRUNE_MARKER)
    + resolved.tailChars
  if (emittedChars > resolved.thresholdChars) {
    throw new Error(
      `ToolResultPruneConfig: headChars + marker + tailChars (${emittedChars}) `
      + `must be at most thresholdChars (${resolved.thresholdChars})`,
    )
  }
  if (resolved.inputPreviewChars + INPUT_REPLACEMENT_OVERHEAD_CHARS >= resolved.inputThresholdChars) {
    throw new Error(
      `ToolResultPruneConfig: inputPreviewChars + ${INPUT_REPLACEMENT_OVERHEAD_CHARS} (${resolved.inputPreviewChars + INPUT_REPLACEMENT_OVERHEAD_CHARS}) `
      + `must be below inputThresholdChars (${resolved.inputThresholdChars})`,
    )
  }
  return deepFreeze(structuredClone(resolved))
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`ToolResultPruneConfig: ${name} (${value}) must be a positive integer`)
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`ToolResultPruneConfig: ${name} (${value}) must be a non-negative integer`)
  }
}
