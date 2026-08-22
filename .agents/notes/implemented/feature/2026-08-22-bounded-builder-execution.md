# Agent Note: Bounded builder execution

Status: implemented

English | [中文](2026-08-22-bounded-builder-execution.zh.md)

## Problem

Synthetic task generation spends most of its tool time rediscovering deterministic mechanics. The observed DeepSeek builder run issued 1,715 commands, including 810 Python invocations, 280 WARC-related probes, 137 validator-related probes, 202 raw `cat` commands, and 16 tool inputs of at least 50 KiB. One exact WARC command recurred 107 times. The general harness also exposes roughly 69,000 characters of static tool definitions across 26 tools before the task begins. These costs obscure task reasoning, enlarge requests, and let unsuccessful mechanics repeat without a terminal condition.

## Decision

The harness ships a builder-specific execution path with five coordinated controls:

1. `@deepseek-ai/dsh-tool-builder` can provide `corpus_query`, an in-process WARC list/search/read tool backed by `warcio`, bounded archive reads, bounded record text, and bounded results. `enableCorpusQuery` controls whether the tool and its guidance are registered.
2. The shipped `builder` agent preset mounts only filesystem editing and search, Bash, background jobs, package validation, and compaction. It disables corpus querying for the normal synthetic pipeline and omits unrelated web, skill, workflow, planning, delegation, self-modification, and code-runtime schemas.
3. `validate_builder_package` performs the shared cheap handoff checks once: required regular nonempty files, JSON and TOML parsing, and byte-identical instruction copies. It returns all failures together and does not execute task code or pipeline-specific judges.
4. `dsh-repeat-tool-reminder` can deny calls after configured exact-repeat, name-counted, or consecutive-failure budgets. The base composition allows four completed identical root calls, 80 consecutive `run_code` or `bash` root calls, and 12 consecutive failed root calls before denying the next call. New user input resets the counters.
5. `dsh-compaction-tool-result-pruner` replaces oversized historical tool-call arguments with valid digest-bearing JSON containing a bounded head/tail preview. The full original event stays in the append-only session log, while the replacement preserves tool name, call id, and call/result pairing on the model-visible surface.

The builder tools and preset keep their model-facing prose in English. The preset is selectable and does not change the deployment default.

## Ownership and limits

When enabled, `corpus_query` owns mechanical archive inspection, not browser rendering or semantic retrieval. It buffers the compressed archive through `ctx.fs` under a configurable byte limit because that seam does not expose a raw byte stream. `validate_builder_package` owns only invariant checks common to the builder handoff; signed inventories, rubric semantics, Harbor, verifier execution, and scoring remain pipeline responsibilities.

Convergence budgets are per live agent and memory-only. They operate on syntactic evidence: exact canonical arguments, root tool names, and failed results. Tool-input pruning occurs only after compaction pressure or canonical overflow qualifies the pruning pass. It adds a replacement event instead of mutating or deleting the source event.

## Alternatives considered

**Keep generating Python WARC scripts.** This preserves maximum flexibility but repeatedly pays for script construction, syntax errors, dependency discovery, and nearly identical archive scans. A maintained JavaScript WARC parser deletes those repeated mechanics while keeping the tool within the filesystem seam.

**Use the general preset for builder work.** One preset is simpler to describe, but every request would continue carrying schemas and instructions unrelated to offline task generation. A selectable narrow preset keeps the general surface unchanged and makes the builder surface explicit.

**Rely on reminders without denial.** Advisory thresholds help a responsive model but did not establish a terminal condition for the observed 107-call exact loop. Configurable pre-dispatch budgets bound waste while allowing deployments to disable enforcement with zero.

**Truncate or overwrite original tool events.** Destructive pruning would make replay and exact audit disagree with the live run. Append-only replacement keeps the source evidence and gives future model requests a bounded surface.

**Run the full verifier from the validation tool.** That would mix cheap generation checks with task-owned code, containers, credentials, and scoring. The native validator deliberately stops at the shared deterministic handoff.

## Consequences

Package checks become one bounded call, and a corpus-enabled deployment also makes common WARC discovery a bounded call. The builder starts with a materially smaller tool surface. Exact loops, fragmented shell/program sequences, and uninterrupted failures now have configurable stopping points. Large historical heredocs and generated scripts no longer remain verbatim in every post-pressure request, while their hashes and original events preserve identity and auditability.

The WARC query can hold as much compressed data in memory as `maxArchiveBytes`, its HTML conversion is intentionally simple, and plain-text scanning is not an index. The cheap validator cannot establish task quality. Legitimate long polling or recovery may hit a hard budget and require new user input or a changed action. Argument variants can evade the exact budget, so selected high-risk tools also use the broader name-counted limit.

## Testing

Package tests cover compressed WARC listing, search, and exact reads; aggregated validation failures; each hard-budget path; input replacement, digest metadata, pairing, and replay stability. A keyless builder-preset snapshot pins the assembled system guidance and exact tool roster. Archived builder artifacts exercise the native query and validator against the original scene.
