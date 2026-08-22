/**
 * Replay-safe, model-free tool-input and tool-result pruning service.
 *
 * @module @deepseek-ai/dsh-compaction-tool-result-pruner
 */

import { createHash } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { CallId, ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, ToolResultMessage } from '@deepseek-ai/dsh-session'
// Type-only: the `compaction/*` SessionEventMap merges (the shadow-price event).
import type {} from '@deepseek-ai/dsh-compaction'
// Type-only: the `ctx.tokenMeter` Context merge for the declared injection.
import type {} from '@deepseek-ai/dsh-token-meter'
import { codePointLength, DEFAULTS, INPUT_PRUNE_MARKER, PRUNE_MARKER, resolveConfig } from './config.ts'
import type {
  PrunedInputEntry,
  PrunedEntry,
  PruneResult,
  ResolvedConfig,
  ToolResultPruneConfig,
} from './types.ts'

export { codePointLength, DEFAULTS, INPUT_PRUNE_MARKER, PRUNE_MARKER, resolveConfig } from './config.ts'
export type {
  PrunedInputEntry,
  PrunedEntry,
  PruneResult,
  ResolvedConfig,
  ToolResultPruneConfig,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    toolResultPruner: ToolResultPruner
  }
}

interface SnapshotCandidate {
  readonly seq: number
  readonly event: SessionEvent<'tool/result'>
}

interface InputSnapshotCandidate {
  readonly seq: number
  readonly event: SessionEvent<'assistant/message'>
}

/** Deterministic head/middle/tail pruning for current tool-interaction surface nodes. */
export class ToolResultPruner extends Service {
  // The token meter prices each shadowed node for its logged shadow-price
  // event, so pruning genuinely requires the pricing capability.
  static inject = ['tokenMeter']

  static Config: z<ToolResultPruneConfig> = z.object({
    thresholdChars: z.number().step(1).min(1).default(DEFAULTS.thresholdChars),
    headChars: z.number().step(1).min(0).default(DEFAULTS.headChars),
    tailChars: z.number().step(1).min(0).default(DEFAULTS.tailChars),
    inputThresholdChars: z.number().step(1).min(1).default(DEFAULTS.inputThresholdChars),
    inputPreviewChars: z.number().step(1).min(0).default(DEFAULTS.inputPreviewChars),
  })

  /** Resolved and immutable character budgets. */
  readonly config: ResolvedConfig

  constructor(ctx: Context, config: ToolResultPruneConfig = {}) {
    super(ctx, 'toolResultPruner')
    this.config = resolveConfig(config)
  }

  /**
   * Measure text content in Unicode code points; non-text blocks cost zero.
   * @param blocks - tool-result content to measure.
   * @returns total Unicode code points across text blocks.
   */
  measureContent(blocks: readonly ContentBlock[]): number {
    let chars = 0
    for (const block of blocks) {
      if (block.type === 'text') chars += codePointLength(block.text)
    }
    return chars
  }

  /**
   * Replace an over-budget text middle while retaining rich-block order.
   * Text slicing is by Unicode code point, not UTF-16 code unit, so a retained
   * boundary cannot split a surrogate pair. Grapheme clusters may still split.
   * @param blocks - original tool-result content.
   * @returns pruned content, or `null` when the text is within budget.
   */
  pruneContent(blocks: readonly ContentBlock[]): ContentBlock[] | null {
    const totalChars = this.measureContent(blocks)
    if (totalChars <= this.config.thresholdChars) return null

    const removedStart = this.config.headChars
    const removedEnd = totalChars - this.config.tailChars
    const pruned: ContentBlock[] = []
    let consumed = 0
    let markerInserted = false

    for (const block of blocks) {
      if (block.type !== 'text') {
        pruned.push(block)
        continue
      }

      const points = Array.from(block.text)
      const blockStart = consumed
      const blockEnd = blockStart + points.length
      const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart))
      const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart))
      const intersectsRemoved = blockStart < removedEnd && blockEnd > removedStart
      const marker = intersectsRemoved && !markerInserted ? PRUNE_MARKER : ''
      if (marker.length > 0) markerInserted = true
      const text = points.slice(0, headEnd).join('')
        + marker
        + points.slice(tailStart).join('')
      if (text.length > 0) pruned.push({ ...block, text })
      consumed = blockEnd
    }

    /* v8 ignore next -- totalChars > threshold and valid budgets guarantee a removed text span. */
    if (!markerInserted) throw new Error('tool-result prune: failed to locate the removed text span')
    const charsAfter = this.measureContent(pruned)
    /* v8 ignore next -- config validation fixes the emitted head + marker + tail budget. */
    if (charsAfter > this.config.thresholdChars || charsAfter >= totalChars) {
      throw new Error('tool-result prune: replacement must be smaller and within threshold')
    }
    return pruned
  }

  /**
   * Replace an oversized raw tool-call argument string with valid JSON carrying
   * its digest, original size, and a bounded head/tail preview.
   * @param argumentsJson - raw assistant tool-call arguments.
   * @returns bounded replacement JSON, or `null` when already within budget.
   */
  pruneArguments(argumentsJson: string): string | null {
    const charsBefore = codePointLength(argumentsJson)
    if (charsBefore <= this.config.inputThresholdChars) return null
    const points = Array.from(argumentsJson)
    const headChars = Math.ceil(this.config.inputPreviewChars / 2)
    const tailChars = Math.floor(this.config.inputPreviewChars / 2)
    const preview = points.slice(0, headChars).join('')
      + INPUT_PRUNE_MARKER
      + (tailChars === 0 ? '' : points.slice(-tailChars).join(''))
    const replacement = JSON.stringify({
      _dsh_pruned_tool_input: {
        sha256: createHash('sha256').update(argumentsJson, 'utf8').digest('hex'),
        characters: charsBefore,
        preview,
      },
    })
    /* v8 ignore next 3 -- resolved config keeps preview plus conservative JSON overhead below the trigger threshold. */
    if (codePointLength(replacement) >= charsBefore) {
      throw new Error('tool-input prune: replacement must be smaller than the original arguments')
    }
    return replacement
  }

  /**
   * Prune every over-budget tool input and result from one stable surface snapshot.
   * Each replacement preserves the complete event data except for its bounded
   * model-visible content, cites the shadowed node for replay recovery, and is
   * immediately preceded by a `compaction/prune` shadow-price event pricing the
   * shadowed node through the injected token meter, so pure consumers can
   * subtract it without per-node state.
   * @param session - session whose current surface is rewritten.
   * @returns landed replacements and aggregate Unicode-code-point savings.
   * @throws when the session rejects a replacement; replacements committed
   * earlier in the pass remain durable.
   */
  pruneSession(session: Session): PruneResult {
    const candidates: SnapshotCandidate[] = []
    const inputCandidates: InputSnapshotCandidate[] = []
    for (const seq of [...session.surface.nodes]) {
      const event = session.events[seq]
      /* v8 ignore next -- surface seqs are validated contiguous log references. */
      if (event?.type === 'tool/result') candidates.push({ seq, event })
      else if (event?.type === 'assistant/message') inputCandidates.push({ seq, event })
    }

    const pruned: PrunedEntry[] = []
    const prunedInputs: PrunedInputEntry[] = []
    let charsRemoved = 0
    for (const { seq, event } of inputCandidates) {
      const callIds: CallId[] = []
      let charsBefore = 0
      let charsAfter = 0
      const content = event.data.message.content.map((block) => {
        if (block.type !== 'tool-call') return block
        const argumentsJson = this.pruneArguments(block.arguments)
        if (argumentsJson === null) return block
        callIds.push(block.id)
        charsBefore += codePointLength(block.arguments)
        charsAfter += codePointLength(argumentsJson)
        return { ...block, arguments: argumentsJson }
      })
      if (callIds.length === 0) continue
      const message = freezeMessage({ ...event.data.message, content })
      session.append('compaction/prune', {
        shadowedRange: { start: seq, end: seq },
        shadowedSeqs: [seq],
        shadowedTokenCount: this.ctx.tokenMeter.estimateMessage(event.data.message),
      })
      const replacement = session.append('assistant/message', {
        ...event.data,
        message,
      }, {
        surfaceOp: { op: 'replace', start: seq, end: seq },
        sourceEventSeqs: [seq],
      })
      prunedInputs.push({
        originalSeq: seq,
        replacementSeq: replacement.seq,
        callIds,
        charsBefore,
        charsAfter,
      })
      charsRemoved += charsBefore - charsAfter
    }
    for (const { seq, event } of candidates) {
      const result = event.data.message.content[0]
      const content = this.pruneContent(result.content)
      if (content === null) continue
      const charsBefore = this.measureContent(result.content)
      const charsAfter = this.measureContent(content)
      const message = freezeMessage<ToolResultMessage>({
        ...event.data.message,
        content: [{
          ...result,
          content,
        }] as [typeof result],
      })
      // Shadow-price protocol: the metering event and its replacement are
      // appended synchronously adjacent, so pure consumers subtract the
      // shadowed node's heuristic price without retaining per-node state.
      session.append('compaction/prune', {
        shadowedRange: { start: seq, end: seq },
        shadowedSeqs: [seq],
        shadowedTokenCount: this.ctx.tokenMeter.estimateMessage(event.data.message),
      })
      const replacement = session.append('tool/result', {
        ...event.data,
        message,
      }, {
        surfaceOp: { op: 'replace', start: seq, end: seq },
        sourceEventSeqs: [seq],
      })
      pruned.push({
        originalSeq: seq,
        replacementSeq: replacement.seq,
        callId: event.data.message.source.callId,
        charsBefore,
        charsAfter,
      })
      charsRemoved += charsBefore - charsAfter
    }
    return { pruned, prunedInputs, charsRemoved }
  }
}

export default ToolResultPruner
