/**
 * Structured adapter for a pipeline-owned architecture validator command.
 * @module @deepseek-ai/dsh-tool-builder/architecture-validator
 */

import type { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsVersion } from '@deepseek-ai/dsh-fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, JsonValue, ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-shell'

/** Resolved command, path, and generation-limit configuration. */
export interface ArchitectureValidatorConfig {
  architectureValidatorScript?: string
  pythonExecutable?: string
  architectureBaseSourcesPath: string
  architectureSeedPath: string
  architectureReportPath: string
  architectureMergedPlanPath: string
  architecturePreloadedDir: string
  architectureExpectedLaneId: string
  architectureSourceCap: number
  architectureEvidenceCap: number
  architectureTargetSites: number
  architectureTargetDocuments: number
  architectureMaxDocuments: number
  architectureTargetTokens: number
  architectureStorageBudgetBytes: number
  architectureAdversarialSiteMin: number
  architectureStrictAdversarialSiteMin: number
  architectureValidatorTimeoutMs: number
  maxFileBytes: number
  maxArchitectureValidationOutputChars: number
}

interface ValidationResult {
  valid: boolean
  exitCode: number | null
  reportPath: string
  mergedPlanPath: string
  report: Record<string, JsonValue>
  stdout: string
  stderr: string
}

function workspaceCwd(exec: ToolExecution): string | undefined {
  return exec.agent?.session.header.cwd
}

function commandQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function clippedDiagnostics(stdout: string, stderr: string): string {
  const details = [stdout === '' ? '' : `stdout: ${stdout}`, stderr === '' ? '' : `stderr: ${stderr}`]
    .filter(Boolean)
    .join('; ')
  if (details === '') return 'no validator diagnostics were emitted'
  const maximum = 2_000
  return details.length <= maximum ? details : `${details.slice(0, maximum)}… [diagnostics truncated]`
}

async function resolveRegularFile(ctx: Context, exec: ToolExecution, path: string, cwd: string) {
  const target = await ctx.fs.resolve(path, { cwd, signal: exec.signal })
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined) throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
  if (info.type !== 'file') throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  return target
}

async function resolveOutputPath(ctx: Context, exec: ToolExecution, path: string, cwd: string) {
  return await ctx.fs.resolve(path, { cwd, signal: exec.signal })
}

async function readJsonReport(
  ctx: Context,
  exec: ToolExecution,
  path: string,
  cwd: string,
  maxBytes: number,
  previousVersion?: FsVersion,
): Promise<{ path: string; value: unknown }> {
  const target = await resolveRegularFile(ctx, exec, path, cwd)
  const info = await ctx.fs.stat(target, exec.signal)
  if (previousVersion !== undefined && info?.version === previousVersion) {
    throw new Error(`architecture validator did not refresh report "${target.displayPath}"`)
  }
  if (info?.size !== undefined && info.size > maxBytes) {
    throw new FsError(`cannot read "${target.displayPath}": file exceeds ${maxBytes} bytes`, 'FS_TOO_LARGE')
  }
  const bytes = await ctx.fs.readBytes(target, exec.signal, maxBytes)
  return {
    path: target.displayPath,
    value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
  }
}

function renderValidation(value: ValidationResult, maximum: number): string {
  const report = JSON.stringify(value.report, null, 2)
  const diagnostics = [
    `Architecture candidate ${value.valid ? 'valid' : 'invalid'}; validator exit ${value.exitCode ?? 'signal'}.`,
    `Report: ${value.reportPath}`,
    `Merged plan: ${value.mergedPlanPath}`,
    report,
    value.stdout === '' ? '' : `stdout:\n${value.stdout}`,
    value.stderr === '' ? '' : `stderr:\n${value.stderr}`,
  ].filter(Boolean).join('\n')
  const marker = '\n[architecture validation output truncated to configured budget]'
  const points = Array.from(diagnostics)
  if (points.length <= maximum) return diagnostics
  return points.slice(0, Math.max(0, maximum - Array.from(marker).length)).join('') + marker
}

async function validateArchitecture(
  ctx: Context,
  exec: ToolExecution,
  args: {
    candidate: string
    workspace?: string
    validator_script?: string
    python_executable?: string
    expected_lane_id?: string
    repair_feedback?: string
  },
  config: ArchitectureValidatorConfig,
): Promise<ValidationResult> {
  if (args.candidate.trim() === '') throw new Error('candidate must be a non-empty string')
  const sessionCwd = workspaceCwd(exec)
  const workspaceTarget = await ctx.fs.resolve(args.workspace ?? '.', {
    ...(sessionCwd === undefined ? {} : { cwd: sessionCwd }),
    signal: exec.signal,
  })
  const workspace = ctx.fs.processPath(workspaceTarget)
  const candidate = await resolveRegularFile(ctx, exec, args.candidate, workspace)
  const scriptValue = args.validator_script ?? config.architectureValidatorScript
  const pythonValue = args.python_executable ?? config.pythonExecutable
  if (scriptValue === undefined || scriptValue.trim() === '') {
    throw new Error('validator_script is required when architectureValidatorScript is not configured')
  }
  if (pythonValue === undefined || pythonValue.trim() === '') {
    throw new Error('python_executable is required when pythonExecutable is not configured')
  }
  const script = await resolveRegularFile(ctx, exec, scriptValue, workspace)
  const baseSources = await resolveRegularFile(ctx, exec, config.architectureBaseSourcesPath, workspace)
  const seed = await resolveRegularFile(ctx, exec, config.architectureSeedPath, workspace)
  const report = await resolveOutputPath(ctx, exec, config.architectureReportPath, workspace)
  const mergedPlan = await resolveOutputPath(ctx, exec, config.architectureMergedPlanPath, workspace)
  const preloaded = await ctx.fs.resolve(config.architecturePreloadedDir, { cwd: workspace, signal: exec.signal })
  const expectedLaneId = args.expected_lane_id ?? config.architectureExpectedLaneId
  if (expectedLaneId.trim() === '') throw new Error('expected_lane_id must be a non-empty string')
  const repairFeedback = args.repair_feedback === undefined
    ? undefined
    : await resolveRegularFile(ctx, exec, args.repair_feedback, workspace)
  const previousReport = await ctx.fs.stat(report, exec.signal)
  const command = [
    pythonValue,
    ctx.fs.processPath(script),
    '--candidate', ctx.fs.processPath(candidate),
    '--base-sources', ctx.fs.processPath(baseSources),
    '--seed', ctx.fs.processPath(seed),
    '--report', ctx.fs.processPath(report),
    '--merged-plan', ctx.fs.processPath(mergedPlan),
    '--preloaded-dir', ctx.fs.processPath(preloaded),
    '--source-cap', String(config.architectureSourceCap),
    '--architect-evidence-cap', String(config.architectureEvidenceCap),
    '--target-sites', String(config.architectureTargetSites),
    '--target-documents', String(config.architectureTargetDocuments),
    '--max-documents', String(config.architectureMaxDocuments),
    '--target-tokens', String(config.architectureTargetTokens),
    '--storage-budget-bytes', String(config.architectureStorageBudgetBytes),
    '--adversarial-site-min', String(config.architectureAdversarialSiteMin),
    '--strict-adversarial-site-min', String(config.architectureStrictAdversarialSiteMin),
    '--expected-lane-id', expectedLaneId,
    ...(repairFeedback === undefined ? [] : ['--repair-feedback', ctx.fs.processPath(repairFeedback)]),
  ].map(commandQuote).join(' ')
  const outcome = await ctx.shell.run(ctx.shell.resolve({
    command,
    workdir: workspace,
    timeoutMs: config.architectureValidatorTimeoutMs,
    signal: exec.signal,
  }))
  let parsed: Awaited<ReturnType<typeof readJsonReport>>
  try {
    parsed = await readJsonReport(
      ctx,
      exec,
      config.architectureReportPath,
      workspace,
      config.maxFileBytes,
      previousReport?.version,
    )
  } catch (error: unknown) {
    if (outcome.exitCode !== 0) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `architecture validator exited ${outcome.exitCode ?? 'by signal'} without a usable fresh report: ${message}; ${clippedDiagnostics(outcome.stdout.text, outcome.stderr.text)}`,
      )
    }
    throw error
  }
  if (typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
    throw new Error(`architecture validation report "${parsed.path}" must be a JSON object`)
  }
  const reportObject = parsed.value as Record<string, JsonValue>
  const valid = outcome.exitCode === 0 && reportObject.valid === true
  return {
    valid,
    exitCode: outcome.exitCode,
    reportPath: parsed.path,
    mergedPlanPath: mergedPlan.displayPath,
    report: reportObject,
    stdout: outcome.stdout.text,
    stderr: outcome.stderr.text,
  }
}

/**
 * Register the pipeline-owned architecture-validator adapter.
 * @param ctx Cordis context that provides tools, filesystem, and shell services.
 * @param config Resolved validator paths, limits, and command configuration.
 */
export function registerArchitectureValidatorTool(ctx: Context, config: ArchitectureValidatorConfig): void {
  ctx.tools.register(defineTool({
    name: 'validate_architecture_candidate',
    description: 'Run the configured pipeline validator for one architecture JSON, write its report and merged plan, and return the complete validation report without constructing a shell command.',
    parameters: {
      candidate: { type: 'string', required: true, description: 'Architecture JSON path, relative to workspace or absolute.' },
      workspace: { type: 'string', description: 'Architecture work directory. Defaults to the session working directory.' },
      validator_script: { type: 'string', description: 'Pipeline validator script path. Omit when configured by the launch environment.' },
      python_executable: { type: 'string', description: 'Python executable path. Omit when configured by the launch environment.' },
      expected_lane_id: { type: 'string', description: `Expected architecture lane identifier. Defaults to ${config.architectureExpectedLaneId}.` },
      repair_feedback: { type: 'string', description: 'Optional repair-feedback JSON path supplied to the pipeline validator.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          valid: { type: 'boolean', required: true },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
          reportPath: { type: 'string', required: true },
          mergedPlanPath: { type: 'string', required: true },
          report: { type: 'object', required: true, additionalProperties: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderValidation(value, config.maxArchitectureValidationOutputChars) }],
    },
    async execute(args, exec) {
      return await validateArchitecture(ctx, exec, args, config)
    },
    isConcurrencySafe: () => false,
    presentCall: (args): GenericCallView | undefined => ({
      card: 'generic',
      kind: 'search',
      title: 'Validate architecture candidate',
      locations: [{ path: args.candidate }],
    }),
  }))
}
