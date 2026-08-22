# Agent Note: Code Mode operational guidance and fragmented-run reminders

Status: implemented

English | [中文](2026-08-22-code-mode-operational-guidance.zh.md)

## Problem

The Code Mode SDK told models to batch deterministic work, but it omitted operational facts that determine whether a batch succeeds. A model could rely on `require`, mistake the worker process directory for the session workspace, omit required nested-tool arguments, create intermediate files during a read-only task, or split one archive analysis across many different `run_code` programs. The exact-argument repeat guard did not detect the last pattern because every program text differed, and nested dispatches appeared between the outer calls.

## Decision

The TypeScript SDK and `run_code` schema direct models to use declared tool bindings for task I/O, avoid Node module and `process` APIs, resolve workspace-relative paths through nested tools, and pass every required nested-tool argument. Both language SDKs direct read-only tasks away from mutating tools and file-creating commands, and direct archive or log analysis to stream inputs into a compact aggregate without allocating one outer program per file or subquestion. The Bash definition reinforces the single multiline script or pipeline pattern and the read-only constraint.

`repeat-tool-reminder` accepts `countByTool`, a list of wildcard tool-name patterns whose root calls count by name regardless of arguments. Nested dispatches are transparent to this root-call chain; a different tracked root call resets it. These sequences receive argument-free consolidation reminders, while tools outside `countByTool` retain exact canonical-argument matching. The package default is empty, and the base bundle configures `[run_code]`.

The reminder remains advisory. It neither blocks a call nor imposes a universal run limit, and the worker runtime's process directory and Node capabilities remain unchanged.

## Verification

Tool-generation tests pin the TypeScript and Python SDK instructions, language-specific `run_code` descriptions, and Bash definition. Guard tests vary outer arguments, execute nested calls between outer calls, exercise both reminder tiers, and verify that another tracked root tool resets the sequence. Keyless snapshots pin the assembled Code Mode prompt and transport schema.

## Alternatives considered

**Count every tool by name regardless of arguments.** Rejected because consecutive reads, searches, edits, and polling calls with distinct targets are ordinary progress. Argument-independent counting needs an explicit narrow list.

**Treat nested dispatches as chain resets.** Rejected because every useful Code Mode program contains nested calls; that rule makes an outer `run_code` sequence invisible by construction.

**Block after a fixed number of programs.** Rejected because exploratory work can legitimately need several programs, and the guard's established role is advisory. Threshold reminders preserve model discretion.

**Change the worker's process directory in this fix.** Deferred because it changes runtime semantics rather than model guidance and needs separate compatibility and isolation analysis. Nested tools already own the session-workspace resolution contract.

## Consequences

Code Mode requests carry additional stable prompt and schema text. Models receive concrete correction before common runtime and read-only failures, and fragmented `run_code` sequences trigger even when their program text changes or their nested tools differ. A legitimate long sequence can receive a reminder at configured thresholds, but execution continues unchanged.
