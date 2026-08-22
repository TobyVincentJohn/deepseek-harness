# @deepseek-ai/dsh-repeat-tool-reminder

English | [中文](README.zh.md)

A loop-convergence guard, not a model-facing tool. It watches each agent's exact calls, configured root-tool sequences, and consecutive failed root calls. Configured thresholds inject escalating reminders; optional hard budgets deny the next over-budget call before its body runs. The original exact-match design is recorded in [the repeat-tool-reminder Agent Note](../../../.agents/notes/archived/feature/2026-07-08-repeat-tool-guard.md); argument-independent root-tool counting is recorded in [the Code Mode operational-guidance Agent Note](../../../.agents/notes/implemented/bug-fix/2026-08-22-code-mode-operational-guidance.md).

## Config

```yaml
- id: repeat-tool-reminder
  name: '@deepseek-ai/dsh-repeat-tool-reminder'
  config:
    thresholds: [3, 5, 8]        # default; consecutive counts that trigger a reminder
    include: []                  # tool-name patterns to track; empty ⇒ all tools
    exclude: [todo_write]        # tool-name patterns transparent to the chain
    countByTool: [run_code, bash] # root tools counted by name regardless of arguments
    argumentsPreviewChars: 500   # default; cap on arguments quoted in the detailed reminder
    maxExactRepeats: 4           # deny a fifth identical root call; 0 disables
    maxConsecutiveByTool: 80     # deny a later name-counted root call; 0 disables
    maxConsecutiveFailures: 12   # deny later root calls until user input; 0 disables
```

`thresholds` fails loud at plugin load: an empty list, a non-integer, a value below 2, or a duplicate throws, never a silent fall-back to defaults; `argumentsPreviewChars` equally rejects anything but an integer >= 1. Each hard budget must be `0` or a positive integer. The reminder list is normalized to ascending order; the first threshold delivers a short generic nudge, while later thresholds name the tool, run length, and a bounded argument preview.

`include`, `exclude`, and `countByTool` entries support `*` wildcards and are predicates over whatever tools exist at call time, not references to registry entries — a pattern matching no currently registered tool is NOT an error (`exclude: [mcp_*]` stays valid in a deployment that loads no MCP tools), unlike `toolOrder`'s referent check. `countByTool` defaults to `[]`; the base bundle sets `[run_code, bash]` so changing wrapper programs and changing shell probes both receive consolidation reminders.

## Chain semantics

The chain key is `(tool name, canonical arguments)` — canonicalization is a deep key-sort plus `JSON.stringify`, so argument objects differing only in property order count as identical. A call identical to the previous tracked call increments the agent's consecutive counter; a different tracked call resets it to 1.

A root call matching `countByTool` instead uses the tool name as its key. Its nested dispatches are transparent to that root chain, so the Bash, read, or grep calls inside `run_code` do not hide a fragmented sequence of outer programs. A different tracked root call resets the root chain. Name-counted reminders omit arguments and tell the model to consolidate known deterministic work.

- **Untracked calls are transparent to the chain.** A call excluded by `include`/`exclude` neither increments nor resets the counter, so `grep X → todo_write → grep X` still counts as two consecutive `grep X` when `todo_write` is excluded. This is what makes exclusion useful: bookkeeping tools interleaved into a loop must not launder it.
- **Denied calls count.** Detection sits on `tools/post-execute`, which also runs for calls a `tools/pre-execute` listener denied — a model hammering a denied call is exactly the loop worth breaking.
- **Hard budgets apply before dispatch.** `maxExactRepeats` and `maxConsecutiveByTool` inspect the completed chain before the next root call, so an over-budget body never runs. `maxConsecutiveFailures` counts failed root outcomes across tool names and denies later root calls until a user prompt resets the agent state.
- **Calls without an agent are ignored.** A direct `ctx.tools.execute()` caller has no model to remind and no live agent object to key on.
- **Per-agent keying.** The tool registry is context-level and subagents interleave through the same waterfall, so a `WeakMap<Agent, Chain>` keys each chain by the live agent object; one agent's repetition never trips another's reminder. A user prompt (`agent/pre-step`) resets the submitting agent's chain, and object lifetime bounds the weak entry without a disposal listener.
- **In-memory only.** A session resumed from persistence starts with a fresh chain — the guard is a heuristic nudge, not a logged invariant, later reminders are the accepted cost.

## Reminder delivery

Reminders ride the post-execute decision's `additionalContexts` (source `{kind: 'plugin', plugin: 'repeat-tool-reminder'}`), never a `content` replacement: the `tool/result` event stays the tool's own output for audit. A hard-budget denial uses the ordinary `tools/pre-execute` denial result, so the durable failed tool result names the violated budget and correction while preserving the skipped body as an auditable outcome.

## Model Experience

### First-threshold context message

#### What the model sees

At the first configured consecutive-repeat threshold, that agent receives the reminder below. No tool schema or normal-call text is added.

##### First-threshold reminder

```markdown
You are repeating the exact same tool call with identical arguments. Carefully analyze the previous result before calling again: if the task is not complete, try a different approach or different arguments instead of repeating the call.
```

#### Token effect

Zero tokens before the threshold. The reminder is retained history for that agent.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### First-threshold name-counted context message

#### What the model sees

At the first configured threshold, a `countByTool` chain receives the argument-independent reminder below.

##### First-threshold name-counted reminder

```markdown
You have called <toolName> <count> times consecutively. Before calling it again, consolidate all known remaining deterministic work into one call, or finish if enough evidence has been gathered.
```

#### Token effect

Zero tokens before the threshold. The reminder is retained history for that agent.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Later-threshold context message

#### What the model sees

A later threshold receives the detailed reminder template below. A capped argument preview ends exactly `… (+<omitted> more chars)`.

##### Later-threshold reminder

```markdown
Repeated tool call detected:
- tool: <toolName>
- consecutive_calls: <count>
- arguments: <canonicalArguments>
The repeated calls are not making progress. Do not call this tool with these exact arguments again. Inspect the latest result and choose a different action, different arguments, or finish the task if enough evidence has been gathered.
```

#### Token effect

Each reminder is retained history; `argumentsPreviewChars` bounds exact-match argument text, while agents keep independent counters.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Later-threshold name-counted context message

#### What the model sees

A later `countByTool` threshold receives the argument-independent reminder template below.

##### Later-threshold name-counted reminder

```markdown
Repeated tool sequence detected:
- tool: <toolName>
- consecutive_calls: <count>
The calls may use different arguments, but the sequence is still fragmented. Consolidate the remaining deterministic work into one call, choose a different approach, or finish if enough evidence has been gathered.
```

#### Token effect

Each reminder is retained history and carries no argument text; agents keep independent counters.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Hard-budget denial

#### What the model sees

The denied tool result names the exhausted exact-repeat, name-counted, or consecutive-failure budget and directs the model to change approach, finish, or await new user input. A user prompt resets all three per-agent counters.

#### Token effect

The short failed result appends to history; the denied tool body contributes no result payload.

#### KV Cache effect

Append-only; the denial follows the reusable request prefix.

## Known Limitations and Deferred Work

- **Exact matching remains the default** — canonicalization is a deep key-sort, so near-identical variants evade the ordinary chain. `countByTool` deliberately broadens only configured root tools; fuzzy matching is rejected pending evidence of need.
- **Compaction does not reset chains** — a chain spanning a compaction checkpoint keeps counting.
- **No subagent chain-sharing** — chains stay isolated per agent; a parent and its subagent repeating the same call never combine.
- **Legitimate idempotent polling still draws nudges** past the thresholds — the pressure valves are `thresholds`/`exclude` config.
- **Hard budgets are syntactic** — success resets the failure count even when it made no semantic progress, while changed arguments evade exact-repeat enforcement. Name-counted caps are the broader control for selected root tools.
