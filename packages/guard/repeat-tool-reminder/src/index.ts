/**
 * Per-agent convergence guard. It enriches post-execute decisions with logged
 * model context and can deny calls after configured repeat or failure budgets.
 * Configuration and chain semantics live in the package README.
 * @module @deepseek-ai/dsh-repeat-tool-reminder
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { PostToolDecision, PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

export const name = 'repeat-tool-reminder'

/**
 * Plugin config, validated by the same-named schemastery schema plus the
 * load-time checks in `apply` (misconfiguration fails loud: an empty
 * `thresholds` list, a non-integer, a value below 2, or a duplicate throws at
 * plugin load, never a silent fall-back). `include`/`exclude` entries are
 * `*`-wildcard predicates over tool names at call time, not references to
 * registry entries — a pattern matching no currently registered tool is valid
 * (`exclude: [mcp_*]` must stay legal in a deployment that loads no MCP tools).
 * `countByTool` uses the same pattern syntax for argument-independent root
 * call chains.
 */
export interface Config {
  /** Consecutive-repeat counts that trigger a reminder (default `[3, 5, 8]`). */
  thresholds?: number[]
  /** Tool-name patterns to track; empty means every tool is tracked. */
  include?: string[]
  /** Tool-name patterns transparent to the chain (neither count nor reset). */
  exclude?: string[]
  /**
   * Root tool-name patterns counted by tool name regardless of arguments.
   * Nested calls are transparent to this root-call chain (default `[]`).
   */
  countByTool?: string[]
  /**
   * Maximum characters of canonical arguments quoted in the DETAILED reminder
   * (default 500). Large payloads (a `write` body, a long command) would
   * otherwise ride into the next request unbounded — precisely in a loop
   * scenario; the cap bounds the reminder, never the detection (the chain key
   * always compares the FULL canonical string).
   */
  argumentsPreviewChars?: number
  /** Maximum completed identical root calls before later repeats are denied; `0` disables enforcement. */
  maxExactRepeats?: number
  /** Maximum consecutive root calls for a `countByTool` match; `0` disables enforcement. */
  maxConsecutiveByTool?: number
  /** Maximum consecutive failed root calls before later root calls are denied; `0` disables enforcement. */
  maxConsecutiveFailures?: number
}

export const Config: z<Config> = z.object({
  thresholds: z.array(z.number()).default([3, 5, 8]),
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  countByTool: z.array(z.string()).default([]),
  argumentsPreviewChars: z.number().default(500),
  maxExactRepeats: z.number().default(0),
  maxConsecutiveByTool: z.number().default(0),
  maxConsecutiveFailures: z.number().default(0),
})

/**
 * The `{kind:'plugin'}` source stamped on every reminder this guard injects —
 * the label is load-bearing (an unlabeled context would render as a user
 * prompt in derived history).
 */
const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'repeat-tool-reminder' }

/**
 * The gentle first-threshold reminder. Keyed to `thresholds[0]`, not a literal
 * count, so a custom first threshold keeps the gentle-then-detailed escalation.
 */
const GENTLE_REMINDER =
  'You are repeating the exact same tool call with identical arguments. '
  + 'Carefully analyze the previous result before calling again: if the task is '
  + 'not complete, try a different approach or different arguments instead of '
  + 'repeating the call.'

/** First-threshold reminder for a fragmented root-tool sequence whose arguments may differ. */
function gentleToolReminder(toolName: string, count: number): string {
  return `You have called ${toolName} ${count} times consecutively. `
    + 'Before calling it again, consolidate all known remaining deterministic work '
    + 'into one call, or finish if enough evidence has been gathered.'
}

/** The detailed later-threshold reminder naming the tool, the run length, and the canonical arguments. */
function detailedReminder(toolName: string, count: number, canonicalArguments: string): string {
  return 'Repeated tool call detected:\n'
    + `- tool: ${toolName}\n`
    + `- consecutive_calls: ${count}\n`
    + `- arguments: ${canonicalArguments}\n`
    + 'The repeated calls are not making progress. Do not call this tool with '
    + 'these exact arguments again. Inspect the latest result and choose a '
    + 'different action, different arguments, or finish the task if enough '
    + 'evidence has been gathered.'
}

/** Later-threshold reminder for a fragmented root-tool sequence whose arguments may differ. */
function detailedToolReminder(toolName: string, count: number): string {
  return 'Repeated tool sequence detected:\n'
    + `- tool: ${toolName}\n`
    + `- consecutive_calls: ${count}\n`
    + 'The calls may use different arguments, but the sequence is still fragmented. '
    + 'Consolidate the remaining deterministic work into one call, choose a different '
    + 'approach, or finish if enough evidence has been gathered.'
}

/**
 * Deep key-sort of a parsed-JSON value so two argument objects that differ
 * only in property order canonicalize identically. Arguments reach the guard
 * as the loop's `JSON.parse` output (or its raw-string fallback for malformed
 * argument JSON), so JSON's value domain is the whole input domain — no
 * bigint, cycle, or `undefined` handling exists because no input path can
 * produce them.
 */
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortJsonValue(record[key])
    }
    return sorted
  }
  return value
}

/** Canonical string form of a call's arguments: deep key-sort, then stringify. */
function canonicalize(argumentsValue: unknown): string {
  return JSON.stringify(sortJsonValue(argumentsValue))
}

/** Compile one `*`-wildcard pattern to an anchored RegExp (every other regex metacharacter is matched literally). */
function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

/**
 * Head-truncate the canonical arguments for quoting in the detailed reminder,
 * marking how much was omitted. Bounds only the model-visible text — the
 * chain key always uses the full canonical string.
 */
function previewArguments(canonical: string, cap: number): string {
  if (canonical.length <= cap) return canonical
  return `${canonical.slice(0, cap)}… (+${canonical.length - cap} more chars)`
}

/**
 * Validate `thresholds` per the fail-loud contract and return them sorted
 * ascending (the escalation rule reads `thresholds[0]` as the gentle tier, so
 * order is normalized here, once).
 */
function validateThresholds(values: number[]): number[] {
  if (values.length === 0) {
    throw new Error('repeat-tool-reminder: `thresholds` must not be empty')
  }
  for (const value of values) {
    if (!Number.isInteger(value) || value < 2) {
      throw new Error(`repeat-tool-reminder: invalid threshold ${value} — every threshold must be an integer >= 2`)
    }
  }
  if (new Set(values).size !== values.length) {
    throw new Error('repeat-tool-reminder: `thresholds` must not contain duplicates')
  }
  return [...values].sort((a, b) => a - b)
}

/**
 * Prepend the guard's reminder while preserving every downstream context's
 * source and metadata.
 */
function prependContext(ours: UserMessage, theirs: UserMessage[] | undefined): UserMessage[] {
  return [ours, ...theirs ?? []]
}

/** One agent's consecutive-repeat chain: the last tracked call's identity key and its run length. */
interface Chain {
  key: string
  count: number
}

/** Validate a disabled-or-positive convergence budget. */
function validateBudget(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`repeat-tool-reminder: invalid ${name} ${value} — must be 0 or a positive integer`)
  }
  return value
}

/**
 * Install the guard's listeners.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - validated {@link Config}; `thresholds` is re-checked fail-loud here.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery's .default() guarantees the fields are set after validation.
  const thresholds = validateThresholds(config.thresholds as number[])
  const thresholdSet = new Set(thresholds)
  const includePatterns = (config.include as string[]).map(wildcardToRegExp)
  const excludePatterns = (config.exclude as string[]).map(wildcardToRegExp)
  const countByToolPatterns = (config.countByTool as string[]).map(wildcardToRegExp)
  const argumentsPreviewChars = config.argumentsPreviewChars as number
  if (!Number.isInteger(argumentsPreviewChars) || argumentsPreviewChars < 1) {
    throw new Error(`repeat-tool-reminder: invalid argumentsPreviewChars ${argumentsPreviewChars} — must be an integer >= 1`)
  }
  const maxExactRepeats = validateBudget('maxExactRepeats', config.maxExactRepeats as number)
  const maxConsecutiveByTool = validateBudget('maxConsecutiveByTool', config.maxConsecutiveByTool as number)
  const maxConsecutiveFailures = validateBudget('maxConsecutiveFailures', config.maxConsecutiveFailures as number)

  const exactChains = new WeakMap<Agent, Chain>()
  // Enforcement tracks exact root calls independently from reminder mode.
  // A tool configured in `countByTool` still needs the tighter exact-repeat
  // budget when its arguments do not change.
  const exactRootChains = new WeakMap<Agent, Chain>()
  const rootToolChains = new WeakMap<Agent, Chain>()
  const failureCounts = new WeakMap<Agent, number>()

  /** Whether a tool participates in the chain (untracked calls are transparent: they neither count nor reset). */
  function tracked(toolName: string): boolean {
    if (includePatterns.length > 0 && !includePatterns.some(pattern => pattern.test(toolName))) return false
    return !excludePatterns.some(pattern => pattern.test(toolName))
  }

  /** Whether a root call is counted by name instead of exact arguments. */
  function countsByTool(toolName: string): boolean {
    return countByToolPatterns.some(pattern => pattern.test(toolName))
  }

  /** Deny a root call whose next execution would exceed a configured budget. */
  function convergenceDenial(exec: ToolExecution): string | undefined {
    if (exec.agent === undefined || exec.parent !== undefined || !tracked(exec.name)) return undefined
    const failures = failureCounts.get(exec.agent) ?? 0
    if (maxConsecutiveFailures > 0 && failures >= maxConsecutiveFailures) {
      return `Convergence guard blocked further tool use after ${failures} consecutive failed calls. Stop the tool loop and report the blocker, or wait for new user input.`
    }
    if (countsByTool(exec.name)) {
      const chain = rootToolChains.get(exec.agent)
      if (maxConsecutiveByTool > 0 && chain?.key === exec.name && chain.count >= maxConsecutiveByTool) {
        return `Convergence guard blocked ${exec.name}: it already ran ${chain.count} times consecutively. Consolidate the remaining work into a different action or finish.`
      }
    }
    const canonical = canonicalize(exec.arguments)
    const key = JSON.stringify([exec.name, canonical])
    const chain = exactRootChains.get(exec.agent)
    if (maxExactRepeats > 0 && chain?.key === key && chain.count >= maxExactRepeats) {
      return `Convergence guard blocked an identical ${exec.name} call after ${chain.count} consecutive attempts. Change the arguments or approach; do not retry the same call.`
    }
    return undefined
  }

  /** Track whether root tool execution is converging through successful outcomes. */
  function observeOutcome(exec: ToolExecution, result: Readonly<ToolExecutionResult>): void {
    if (exec.agent === undefined || exec.parent !== undefined || !tracked(exec.name)) return
    const canonical = canonicalize(exec.arguments)
    const exactKey = JSON.stringify([exec.name, canonical])
    const exactChain = exactRootChains.get(exec.agent)
    const exactCount = exactChain !== undefined && exactChain.key === exactKey ? exactChain.count + 1 : 1
    exactRootChains.set(exec.agent, { key: exactKey, count: exactCount })
    if (result.isError) failureCounts.set(exec.agent, (failureCounts.get(exec.agent) ?? 0) + 1)
    else failureCounts.delete(exec.agent)
  }

  /**
   * Advance the calling agent's chain for one attempt and return the reminder
   * to deliver, if this attempt's run length hits a configured threshold.
   * Counting happens here — in post-execute — because denied calls also flow
   * through this waterfall (`ToolRuntime.execute` routes a deny through the
   * same pipeline), and a model hammering a denied call is exactly the loop
   * worth breaking.
   */
  function observe(exec: ToolExecution): UserMessage | undefined {
    // A direct `ctx.tools.execute()` caller has no model to remind and no id
    // to key on; only agent-loop calls participate.
    if (!exec.agent) return undefined
    if (!tracked(exec.name)) return undefined
    if (exec.parent === undefined && countsByTool(exec.name)) {
      exactChains.delete(exec.agent)
      const chain = rootToolChains.get(exec.agent)
      const count = chain !== undefined && chain.key === exec.name ? chain.count + 1 : 1
      rootToolChains.set(exec.agent, { key: exec.name, count })
      if (!thresholdSet.has(count)) return undefined
      const text = count === thresholds[0]
        ? gentleToolReminder(exec.name, count)
        : detailedToolReminder(exec.name, count)
      return createUserMessage({
        content: [{ type: 'text', text }],
        source: { ...PLUGIN_SOURCE, form: 'notice', summary: `${exec.name} × ${count}` },
      })
    }
    if (exec.parent === undefined) rootToolChains.delete(exec.agent)
    const canonical = canonicalize(exec.arguments)
    const key = JSON.stringify([exec.name, canonical])
    const chain = exactChains.get(exec.agent)
    const count = chain !== undefined && chain.key === key ? chain.count + 1 : 1
    exactChains.set(exec.agent, { key, count })
    if (!thresholdSet.has(count)) return undefined
    const text = count === thresholds[0]
      ? GENTLE_REMINDER
      : detailedReminder(exec.name, count, previewArguments(canonical, argumentsPreviewChars))
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { ...PLUGIN_SOURCE, form: 'notice', summary: `${exec.name} × ${count}` },
    })
  }

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const reason = convergenceDenial(exec)
    if (reason !== undefined) return { kind: 'deny', reason }
    return await next()
  })

  // Count every settled attempt, including a pre-execute denial, then fold a
  // reminder onto the downstream decision without replacing the tool result.
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const reminder = observe(exec)
    observeOutcome(exec, result)
    const downstream = await next()
    if (!reminder) return downstream
    if (downstream.kind === 'block') {
      return { kind: 'block', feedback: downstream.feedback, additionalContexts: prependContext(reminder, downstream.additionalContexts) }
    }
    return {
      ...downstream,
      additionalContexts: prependContext(reminder, downstream.additionalContexts),
    }
  })

  // A user interjection changes the context; repetition across it is not a
  // loop. Pure reset hook: always delegates (attaching nothing, vetoing
  // nothing).
  ctx.on('agent/pre-step', ({ agent, messages }, next): Promise<PreStepDecision> => {
    if (messages.some(message => message.source.kind === 'user')) {
      exactChains.delete(agent)
      exactRootChains.delete(agent)
      rootToolChains.delete(agent)
      failureCounts.delete(agent)
    }
    return next()
  })
}
