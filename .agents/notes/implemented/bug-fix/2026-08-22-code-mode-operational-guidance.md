# Agent Note: Code Mode operational guidance and fragmented-run reminders

Status: implemented

English | [中文](2026-08-22-code-mode-operational-guidance.zh.md)

## Problem

The Code Mode SDK told models to batch deterministic work, but it omitted operational facts that determine whether a batch succeeds. A model could rely on `require`, mistake the worker process directory for the session workspace, omit required nested-tool arguments, create intermediate files during a read-only task, or split one archive analysis across many different `run_code` programs. The exact-argument repeat guard did not detect the last pattern because every program text differed, and nested dispatches appeared between the outer calls. A real archive replay exposed three more concrete ambiguities: the model emitted SDK names such as `glob` as top-level calls, guessed multiple Bash return shapes, and treated a resolved Bash call as success even when the command exited nonzero.

## Decision

The TypeScript SDK and `run_code` schema direct models to use declared tool bindings for task I/O, avoid Node module and `process` APIs, resolve workspace-relative paths through nested tools, and pass every required nested-tool argument. The Code Mode-only section distinguishes the one top-level `run_code` transport from SDK method names and explicitly forbids emitting the latter as model tool calls. Both language SDKs direct read-only tasks away from mutating tools and file-creating commands. Workspace inspection follows a narrow sequence: `glob` locates candidate files, `grep` locates evidence, and `read` returns only relevant surrounding windows. The shipped `readLimit` is 200 lines, so an explicit broad read cannot bypass that context bound. Archive, log, and dataset analysis uses one streaming Bash pipeline that computes a bounded aggregate with source identifiers without allocating one outer program per file or subquestion or returning raw records.

Program guidance treats declared return types as exact. A foreground Bash result is consumed through `kind`, `exitCode`, `stdout.text`, and `stderr.text`; command success is distinct from promise resolution. Bash commands invoke non-shell interpreters explicitly, using a quoted heredoc for multiline scripts. Parsers guard heterogeneous event shapes, and a failed run is repaired at its smallest evidenced cause and retried once instead of being replaced with another compatibility wrapper.

The Bash `description` field is optional display metadata with a deterministic `Run shell command` fallback; only `command` remains required. The shipped Web and headless bundles default an unset `DSH_TOOLS_MODE` to `both`, so ordinary sessions expose native Codex-style discovery and editing tools alongside `run_code` for deliberate deterministic batching. Operators and the dedicated Code Mode preset may still select `native` or `code` explicitly.

`repeat-tool-reminder` accepts `countByTool`, a list of wildcard tool-name patterns whose root calls count by name regardless of arguments. Nested dispatches are transparent to this root-call chain; a different tracked root call resets it. These sequences receive argument-free consolidation reminders, while tools outside `countByTool` retain exact canonical-argument matching. The package default is empty, and the base bundle configures `[run_code, bash]`: fragmented wrapper programs and changing native shell probes are the two observed bulk-analysis loops.

The reminder remains advisory. It neither blocks a call nor imposes a universal run limit, and the worker runtime's process directory and Node capabilities remain unchanged.

## Verification

Tool-generation tests pin the TypeScript and Python SDK instructions, language-specific `run_code` descriptions, Code Mode's top-level/SDK distinction, exact Bash result handling, optional display metadata, read/search/Bash selection guidance, the 200-line read cap, and Bash definition. Guard tests vary outer arguments, execute nested calls between outer calls, exercise both reminder tiers, and verify that another tracked root tool resets the sequence. Keyless snapshots pin the assembled Code Mode prompt and transport schema. Real OpenRouter archive runs check call selection, workspace writes, completion, command failures, and answer evidence against fresh copies of the staged dataset. A Code Mode replay eliminated direct SDK-name calls but still exceeded 22 analysis steps after decisive evidence existed, confirming that advisory consolidation alone does not provide Codex-style convergence for this model and motivating the `both` default.

The final default-mode replay completed in 187.586 seconds with one `glob`, one targeted `read`, fourteen native Bash calls, reminders at Bash counts 3/5/8, a completed turn, and unchanged checksums for all 66 staged files. The comparable completed Code Mode replay took 446.903 seconds, so native-plus-batched presentation reduced wall time by 58%. Three generated parser commands still exited with Python errors before recovery; the change removes protocol and required-label failures but does not make model-written analysis code infallible.

## Alternatives considered

**Count every tool by name regardless of arguments.** Rejected because consecutive reads, searches, edits, and polling calls with distinct targets are ordinary progress. Argument-independent counting needs an explicit narrow list.

**Treat nested dispatches as chain resets.** Rejected because every useful Code Mode program contains nested calls; that rule makes an outer `run_code` sequence invisible by construction.

**Block after a fixed number of programs.** Rejected because exploratory work can legitimately need several programs, and the guard's established role is advisory. Threshold reminders preserve model discretion.

**Change the worker's process directory in this fix.** Deferred because it changes runtime semantics rather than model guidance and needs separate compatibility and isolation analysis. Nested tools already own the session-workspace resolution contract.

## Consequences

Code Mode requests carry additional stable prompt and schema text. Models receive concrete correction before common runtime and read-only failures, and fragmented `run_code` sequences trigger even when their program text changes or their nested tools differ. A legitimate long sequence can receive a reminder at configured thresholds, but execution continues unchanged. The `both` default sends native schemas plus the SDK and transport, increasing the fixed request prefix in exchange for fewer wrapper-only recovery turns; deployments that optimize prefix size over tool ergonomics can still set `DSH_TOOLS_MODE=code`.

The smaller read cap trades convenient whole-file reads for predictable context growth; callers paginate targeted source windows when necessary. Search and Bash remain advisory choices rather than a file-type prohibition, so unusual tasks can still read structured text directly within the bound.
