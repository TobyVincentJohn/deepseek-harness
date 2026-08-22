import type { CallId } from '@deepseek-ai/dsh-llm'

/** Character-budget policy for deterministic tool-result pruning. */
export interface ToolResultPruneConfig {
  /** Prune when total text exceeds this many Unicode code points. Defaults to `8192`. */
  thresholdChars?: number
  /** Maximum leading Unicode code points retained. Defaults to `4096`. */
  headChars?: number
  /** Maximum trailing Unicode code points retained. Defaults to `1024`. */
  tailChars?: number
  /** Prune a tool-call argument string above this many Unicode code points. Defaults to `8192`. */
  inputThresholdChars?: number
  /** Maximum argument-preview code points retained inside the replacement JSON. Defaults to `512`. */
  inputPreviewChars?: number
}

/** Validated, detached, deeply immutable pruning configuration. */
export interface ResolvedConfig {
  readonly thresholdChars: number
  readonly headChars: number
  readonly tailChars: number
  readonly inputThresholdChars: number
  readonly inputPreviewChars: number
}

/** One assistant-message replacement whose oversized tool inputs were pruned. */
export interface PrunedInputEntry {
  /** Full-fidelity assistant event shadowed by the replacement. */
  readonly originalSeq: number
  /** Newly appended assistant event carrying bounded tool-call arguments. */
  readonly replacementSeq: number
  /** Tool calls whose argument strings were replaced. */
  readonly callIds: readonly CallId[]
  /** Original argument size across replaced calls in Unicode code points. */
  readonly charsBefore: number
  /** Replacement argument size across replaced calls in Unicode code points. */
  readonly charsAfter: number
}

/** Cited source event and size accounting for one landed surface replacement. */
export interface PrunedEntry {
  /** Full-fidelity tool-result event shadowed by the replacement. */
  readonly originalSeq: number
  /** Newly appended pruned tool-result event. */
  readonly replacementSeq: number
  /** Tool call shared by the original and replacement. */
  readonly callId: CallId
  /** Original text size in Unicode code points. */
  readonly charsBefore: number
  /** Replacement text size in Unicode code points. */
  readonly charsAfter: number
}

/** Aggregate outcome of one stable-surface pruning pass. */
export interface PruneResult {
  /** Replacements in the snapshotted surface order. */
  readonly pruned: readonly PrunedEntry[]
  /** Oversized assistant tool-call input replacements. */
  readonly prunedInputs: readonly PrunedInputEntry[]
  /** Total Unicode code points removed across replacements. */
  readonly charsRemoved: number
}
