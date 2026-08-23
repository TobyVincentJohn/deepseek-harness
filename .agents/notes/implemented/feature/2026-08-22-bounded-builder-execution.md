# Agent Note: Bounded builder execution

Status: implemented

English | [中文](2026-08-22-bounded-builder-execution.zh.md)

## Problem

Synthetic task generation spends most of its tool time rediscovering deterministic mechanics. The observed DeepSeek builder runs issued 1,715 commands in one final-package workload and 669 model-to-tool round trips in nine retained architecture sessions. The architecture sessions spent about 156 aggregate minutes generating model output and under four minutes executing root tools while appending 29 tool results of at least 40,000 characters. The general harness also exposes roughly 69,000 characters of static tool definitions across 26 tools before the task begins. These costs obscure task reasoning, enlarge requests, and let unsuccessful mechanics repeat without a terminal condition.

## Decision

The harness ships a builder-specific execution path with five coordinated controls:

1. `@deepseek-ai/dsh-tool-builder` provides `corpus_query`, an in-process WARC list/search/read tool backed by `warcio`, plus `architecture_corpus_query`, a read-only batched adapter for the pipeline's frozen SQLite FTS index. The indexed tool combines statistics, multiple searches, exact final/requested URL reads, and an optional listing under per-item and complete-result limits.
2. The shipped `builder` agent preset mounts only filesystem editing and search, Bash, background jobs, the builder tools, and compaction. It omits unrelated web, skill, workflow, planning, delegation, self-modification, and code-runtime schemas.
3. `validate_builder_package` performs the shared cheap final-package handoff checks once. `validate_architecture_candidate` invokes the pipeline-owned validator with configured paths and corpus limits, returns its JSON report under a complete-result limit, and preserves the validator's report and merged-plan outputs. The harness does not duplicate pipeline validation rules.
4. `dsh-repeat-tool-reminder` can deny calls after configured exact-repeat, name-counted, or consecutive-failure budgets. The base composition allows four completed identical root calls, 80 consecutive `run_code` or `bash` root calls, and 12 consecutive failed root calls before denying the next call. New user input resets the counters.
5. `dsh-compaction-tool-result-pruner` replaces oversized historical tool-call arguments with valid digest-bearing JSON containing a bounded head/tail preview. The full original event stays in the append-only session log, while the replacement preserves tool name, call id, and call/result pairing on the model-visible surface.

The builder tools and preset keep their model-facing prose in English. The preset is selectable and does not change the deployment default.

## Ownership and limits

`corpus_query` owns mechanical archive inspection, not browser rendering or semantic retrieval. It buffers the compressed archive through `ctx.fs` under a configurable byte limit because that seam does not expose a raw byte stream. `architecture_corpus_query` accepts only the pipeline's documented FTS5 documents table, opens it read-only, and cannot interrupt one synchronous SQLite statement. `validate_builder_package` owns only invariant checks common to the final-package handoff; `validate_architecture_candidate` delegates all architecture semantics to its configured pipeline script. Signed inventories, rubric semantics, Harbor, verifier execution, and scoring remain pipeline responsibilities.

Convergence budgets are per live agent and memory-only. They operate on syntactic evidence: exact canonical arguments, root tool names, and failed results. Tool-input pruning occurs only after compaction pressure or canonical overflow qualifies the pruning pass. It adds a replacement event instead of mutating or deleting the source event.

## Alternatives considered

**Keep generating Python WARC scripts.** This preserves maximum flexibility but repeatedly pays for script construction, syntax errors, dependency discovery, and nearly identical archive scans. A maintained JavaScript WARC parser deletes those repeated mechanics while keeping the tool within the filesystem seam.

**Use the general preset for builder work.** One preset is simpler to describe, but every request would continue carrying schemas and instructions unrelated to offline task generation. A selectable narrow preset keeps the general surface unchanged and makes the builder surface explicit.

**Rely on reminders without denial.** Advisory thresholds help a responsive model but did not establish a terminal condition for the observed 107-call exact loop. Configurable pre-dispatch budgets bound waste while allowing deployments to disable enforcement with zero.

**Truncate or overwrite original tool events.** Destructive pruning would make replay and exact audit disagree with the live run. Append-only replacement keeps the source evidence and gives future model requests a bounded surface.

**Run the full verifier from the validation tool.** That would mix cheap generation checks with task-owned code, containers, credentials, and scoring. The native validator deliberately stops at the shared deterministic handoff.

**Reimplement architecture validation in the harness.** Copying a large pipeline schema would make two components disagree as the architecture contract evolves. A structured adapter keeps the model-facing call stable while the pipeline remains the sole owner of validation semantics and merged-plan generation.

**Scan every indexed document for every architecture query.** The architecture stage already materializes an FTS5 index and exact text rows. Reusing it supports many queries in one call and avoids repeated archive parsing or model-authored Python.

## Consequences

Common WARC discovery, batched architecture research, architecture validation, and package checks become bounded native calls, and the builder starts with a materially smaller tool surface. Exact loops, fragmented shell/program sequences, and uninterrupted failures have configurable stopping points. Large historical heredocs and generated scripts do not remain verbatim in every post-pressure request, while their hashes and original events preserve identity and auditability.

The WARC query can hold as much compressed data in memory as `maxArchiveBytes`, its HTML conversion is intentionally simple, and plain-text scanning is not an index. The cheap validator cannot establish task quality. Legitimate long polling or recovery may hit a hard budget and require new user input or a changed action. Argument variants can evade the exact budget, so selected high-risk tools also use the broader name-counted limit.

## Testing

Package tests cover compressed WARC operations, the archived SQLite FTS schema and exact-read contract, complete-result clipping, structured architecture-validator invocation, aggregated package failures, hard-budget paths, input replacement, digest metadata, pairing, and replay stability. A keyless builder-preset snapshot pins the assembled system guidance and exact tool roster. The retained builder artifacts supplied the index schema, validator CLI contract, and workload evidence used by those tests.
