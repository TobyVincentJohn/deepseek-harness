# @deepseek-ai/dsh-compaction-tool-result-pruner

English | [中文](README.zh.md)

The replay-safe model-free pruning service (`ctx.toolResultPruner`). It rewrites over-budget `tool/result` text and assistant tool-call argument strings while retaining every full original event in the append-only session log.

This is a concrete companion to [`dsh-compaction-basic`](../compaction-basic/README.md), not a compaction backend or model-facing tool. Compact-basic reads it through optional `ctx.get('toolResultPruner')`, so either package remains independently composable.

## Service API

`pruneSession(session)` scans one stable snapshot of the current surface. Every over-budget tool result is replaced by one newly appended `tool/result`; an assistant message containing over-budget tool-call arguments is replaced by one newly appended `assistant/message`. Each replacement targets only its original node and cites that node through `sourceEventSeqs`. Original events remain available for persistence, replay, and exact-log inspection.

Tool-call arguments above `inputThresholdChars` become valid JSON containing the original Unicode-code-point count, a SHA-256 digest, and a bounded head/tail preview separated by `[... tool input middle pruned ...]`. Tool name and call id stay unchanged, so the retained result remains paired with the bounded historical call. `prunedInputs` reports each assistant replacement and its affected call ids.

The method throws synchronously when the session rejects a replacement. Replacements committed earlier in the pass remain durable.

`measureContent(blocks)` counts Unicode code points in `text` blocks. `pruneContent(blocks)` returns the bounded replacement or `null` when content is already within the threshold. Non-text blocks are retained at their original relative positions; text slicing never splits a UTF-16 surrogate pair, though it can split a multi-code-point grapheme cluster.

Every emitted result has exactly the configured head budget, fixed marker, and tail budget in text code points, is no larger than `thresholdChars`, and is strictly smaller than the triggering input. A second pass therefore emits no replacement.

## Config

Unrecognized keys fail at plugin construction. Resolved config is detached and deeply immutable.

| Key | Required | Meaning |
|---|---|---|
| `thresholdChars` | no (default `8192`) | Prune when combined text exceeds this many Unicode code points. |
| `headChars` | no (default `4096`) | Leading Unicode code points retained. |
| `tailChars` | no (default `1024`) | Trailing Unicode code points retained. |
| `inputThresholdChars` | no (default `8192`) | Replace a tool-call argument string above this many Unicode code points. |
| `inputPreviewChars` | no (default `512`) | Argument code points retained across the replacement's head and tail preview. |

All values are integers; thresholds are positive and retention values are non-negative. Each configured replacement must fit below its triggering threshold, so pruning never grows a node and a second pass emits no replacement.

## Usage

```ts
import type { Context } from '@deepseek-ai/cordis'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'

export function apply(ctx: Context): void {
  ctx.plugin(ToolResultPruner)
}
```

## Model Experience

### Pruned tool result

#### What the model sees

Once a compaction trigger qualifies, future requests see the retained result head/tail and bounded digest-bearing JSON in place of oversized tool-call arguments. Rich result blocks and tool call ids keep their order. The model does not see a second copy of either original.

#### Token effect

Each rewritten tool result has at most `thresholdChars` text code points, and each rewritten tool input is smaller than its triggering argument string. Pruning itself makes no model call; compaction-basic skips summarization when the remeasured request falls below pressure, otherwise the summarizer reads the pruned surface.

#### KV Cache effect

Replacing an earlier result invalidates reuse from the first changed token. The pruned prefix is eligible for reuse while its route, envelope, and preceding history remain identical.

## Known Limitations and Deferred Work

- **Character budgets are not token budgets** — provider token density varies, so `ctx.tokenMeter` remains the authority for deciding whether pruning relieved request pressure.
- **Pruning is syntactic** — it retains the beginning and end without interpreting which middle lines are semantically important.
- **Grapheme clusters can split** — code-point slicing protects surrogate pairs but does not perform locale-aware grapheme segmentation.
