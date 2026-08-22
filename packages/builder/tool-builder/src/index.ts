/**
 * Deterministic model-facing operations for synthetic task builders.
 * `validate_builder_package` performs the shared cheap structural handoff
 * checks; deployments that process offline corpora may also enable the
 * in-process `corpus_query` WARC tool.
 * @module @deepseek-ai/dsh-tool-builder
 */

import type { Context } from '@deepseek-ai/cordis'
import { Readable } from 'node:stream'
import z from '@deepseek-ai/schemastery'
import { parse as parseToml } from 'smol-toml'
import { WARCParser } from 'warcio'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolExecution } from '@deepseek-ai/dsh-tools'

export const name = 'tool-builder'
export const inject = ['tools', 'fs', 'systemPrompt']

const DEFAULT_MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_RECORD_CHARS = 2_000_000
const DEFAULT_MAX_CONTENT_CHARS = 12_000
const DEFAULT_MAX_RESULTS = 20
const MAX_RESULTS = 100
const SNIPPET_CHARS = 500

const REQUIRED_PATHS = [
  '.gitattributes',
  'task.toml',
  'instruction.md',
  'environment/Dockerfile',
  'environment/pywb/config.yaml',
  'environment/corpus/archive.warc.gz',
  'environment/scripts/corpus_server.py',
  'environment/scripts/start.sh',
  'solution/solve.sh',
  'solution/report.md',
  'solution/evidence_graph.json',
  'tests/instruction.md',
  'tests/Dockerfile',
  'tests/rubrics.json',
  'tests/source_tiers.txt',
  'tests/test.sh',
  'tests/test_outputs.py',
  'tests/reference/canonical_claim_ledger.json',
  'tests/reference/corpus_manifest.json',
  'tests/reference/ground_truth.json',
  'tests/reference/reasoning_blueprint.json',
] as const

const JSON_PATHS = [
  'solution/evidence_graph.json',
  'tests/rubrics.json',
  'tests/reference/canonical_claim_ledger.json',
  'tests/reference/corpus_manifest.json',
  'tests/reference/ground_truth.json',
  'tests/reference/reasoning_blueprint.json',
] as const

/** Configuration bounds applied before either tool performs I/O. */
export interface Config {
  /** Whether to register `corpus_query` and its WARC-specific prompt guidance. */
  enableCorpusQuery?: boolean
  /** Largest compressed WARC accepted by one query. */
  maxArchiveBytes?: number
  /** Largest text file read by package validation. */
  maxFileBytes?: number
  /** Most decoded characters scanned from one WARC response body. */
  maxRecordChars?: number
  /** Most decoded response characters returned by an exact-URL read. */
  maxContentChars?: number
  /** Default maximum records returned by one corpus query. */
  maxResults?: number
}

export const Config: z<Config> = z.object({
  enableCorpusQuery: z.boolean().default(true),
  maxArchiveBytes: z.number().default(DEFAULT_MAX_ARCHIVE_BYTES),
  maxFileBytes: z.number().default(DEFAULT_MAX_FILE_BYTES),
  maxRecordChars: z.number().default(DEFAULT_MAX_RECORD_CHARS),
  maxContentChars: z.number().default(DEFAULT_MAX_CONTENT_CHARS),
  maxResults: z.number().default(DEFAULT_MAX_RESULTS),
})

interface ResolvedConfig {
  enableCorpusQuery: boolean
  maxArchiveBytes: number
  maxFileBytes: number
  maxRecordChars: number
  maxContentChars: number
  maxResults: number
}

interface CorpusInput {
  path: string
  operation: 'list' | 'search' | 'read'
  query?: string
  url?: string
  limit: number
}

interface CorpusRecord {
  url: string
  capturedAt?: string
  status?: number
  contentType?: string
  text?: string
  bodyTruncated?: boolean
}

interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

function errorMessage(error: unknown): string {
  /* v8 ignore else -- filesystem, JSON, TOML, and TextDecoder failures are Error instances. */
  if (error instanceof Error) return error.message
  /* v8 ignore next -- defensive normalization for foreign throw values. */
  return String(error)
}

function assertPositiveInteger(label: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-builder: ${label} must be a positive integer`)
  }
}

function workspaceCwd(exec: ToolExecution): string | undefined {
  return exec.agent?.session.header.cwd
}

function resolveOptions(exec: ToolExecution): { cwd?: string; signal: AbortSignal } {
  const cwd = workspaceCwd(exec)
  return { ...(cwd === undefined ? {} : { cwd }), signal: exec.signal }
}

async function regularFile(
  ctx: Context,
  exec: ToolExecution,
  path: string,
): Promise<{ target: FsTarget; info: FsInfo }> {
  const target = await ctx.fs.resolve(path, resolveOptions(exec))
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined) throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
  if (info.type !== 'file') throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  return { target, info }
}

async function readBoundedText(
  ctx: Context,
  exec: ToolExecution,
  path: string,
  maxBytes: number,
): Promise<string> {
  const { target, info } = await regularFile(ctx, exec, path)
  if (info.size !== undefined && info.size > maxBytes) {
    throw new FsError(`cannot read "${target.displayPath}": file exceeds ${maxBytes} bytes`, 'FS_TOO_LARGE')
  }
  const bytes = await ctx.fs.readBytes(target, exec.signal, maxBytes)
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

function parseCorpusInput(
  args: { path: string; operation: 'list' | 'search' | 'read'; query?: string; url?: string; limit?: number },
  config: ResolvedConfig,
): CorpusInput {
  if (args.path.trim().length === 0) throw new Error('path must be a non-empty string')
  if (args.operation === 'search' && (args.query === undefined || args.query.trim().length === 0)) {
    throw new Error('query is required for operation "search"')
  }
  if (args.operation === 'read' && (args.url === undefined || args.url.trim().length === 0)) {
    throw new Error('url is required for operation "read"')
  }
  const limit = args.limit ?? config.maxResults
  assertPositiveInteger('corpus_query limit', limit)
  if (limit > MAX_RESULTS) throw new Error(`corpus_query limit must be no greater than ${MAX_RESULTS}`)
  return {
    path: args.path,
    operation: args.operation,
    ...(args.query === undefined ? {} : { query: args.query }),
    ...(args.url === undefined ? {} : { url: args.url }),
    limit,
  }
}

async function recordText(
  record: AsyncIterable<Uint8Array>,
  maxChars: number,
  signal: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  const decoder = new TextDecoder('utf-8', { fatal: false })
  let text = ''
  let truncated = false
  for await (const chunk of record) {
    signal.throwIfAborted()
    /* v8 ignore else -- warcio currently yields each buffered record body as one chunk; keep draining future chunked implementations. */
    if (text.length < maxChars) {
      text += decoder.decode(chunk, { stream: true })
      if (text.length > maxChars) {
        text = text.slice(0, maxChars)
        truncated = true
      }
    } else {
      truncated = true
    }
  }
  if (!truncated) text += decoder.decode()
  return { text, truncated }
}

function htmlToSearchText(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replace(/\s+/gu, ' ')
    .trim()
}

function snippet(text: string, query: string): string {
  const normalized = htmlToSearchText(text)
  const index = normalized.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
  if (index < 0) return normalized.slice(0, SNIPPET_CHARS)
  const start = Math.max(0, index - Math.floor(SNIPPET_CHARS / 3))
  return normalized.slice(start, start + SNIPPET_CHARS)
}

function responseStatus(record: { httpHeaders: { statusCode: number | string | undefined } | null }): number | undefined {
  const raw = record.httpHeaders?.statusCode
  const parsed = Number(raw)
  return Number.isInteger(parsed) ? parsed : undefined
}

async function queryCorpus(
  ctx: Context,
  exec: ToolExecution,
  input: CorpusInput,
  config: ResolvedConfig,
): Promise<{ path: string; operation: CorpusInput['operation']; records: CorpusRecord[]; scanned: number; truncated: boolean }> {
  const { target, info } = await regularFile(ctx, exec, input.path)
  if (info.size !== undefined && info.size > config.maxArchiveBytes) {
    throw new FsError(`cannot query "${target.displayPath}": archive exceeds ${config.maxArchiveBytes} bytes`, 'FS_TOO_LARGE')
  }
  const bytes = await ctx.fs.readBytes(target, exec.signal, config.maxArchiveBytes)

  const records: CorpusRecord[] = []
  let scanned = 0
  let overLimit = false
  for await (const record of new WARCParser(Readable.from([bytes]))) {
    exec.signal.throwIfAborted()
    if (record.warcType !== 'response' && record.warcType !== 'resource' && record.warcType !== 'revisit') {
      for await (const _chunk of record) { /* drain */ }
      continue
    }
    scanned += 1
    const url = record.warcTargetURI ?? ''
    const contentType = record.httpHeaders?.headers.get('content-type')
      ?? record.warcHeaders.headers.get('Content-Type')
      ?? undefined
    const capturedAt = record.warcHeaders.headers.get('WARC-Date') ?? undefined
    const status = responseStatus(record)
    const base: CorpusRecord = {
      url,
      ...(capturedAt === undefined ? {} : { capturedAt }),
      ...(status === undefined ? {} : { status }),
      ...(contentType === undefined ? {} : { contentType }),
    }

    if (input.operation === 'list') {
      for await (const _chunk of record) { /* drain */ }
      records.push(base)
      if (records.length >= input.limit) {
        overLimit = true
        break
      }
      continue
    }

    if (input.operation === 'read' && url !== input.url) {
      for await (const _chunk of record) { /* drain */ }
      continue
    }

    const body = await recordText(record, config.maxRecordChars, exec.signal)
    if (input.operation === 'search') {
      const query = input.query as string
      const searchable = `${url}\n${body.text}`
      if (!searchable.toLocaleLowerCase().includes(query.toLocaleLowerCase())) continue
      records.push({ ...base, text: snippet(body.text, query), ...(body.truncated ? { bodyTruncated: true } : {}) })
      if (records.length >= input.limit) {
        overLimit = true
        break
      }
      continue
    }

    const rendered = htmlToSearchText(body.text).slice(0, config.maxContentChars)
    records.push({
      ...base,
      text: rendered,
      ...(body.truncated || htmlToSearchText(body.text).length > config.maxContentChars ? { bodyTruncated: true } : {}),
    })
    break
  }
  return { path: target.displayPath, operation: input.operation, records, scanned, truncated: overLimit }
}

function packagePath(root: string, relative: string): string {
  return root.endsWith('/') ? `${root}${relative}` : `${root}/${relative}`
}

async function validatePackage(
  ctx: Context,
  exec: ToolExecution,
  root: string,
  config: ResolvedConfig,
): Promise<{ valid: boolean; root: string; checks: CheckResult[]; failures: number }> {
  const checks: CheckResult[] = []
  for (const relative of REQUIRED_PATHS) {
    const path = packagePath(root, relative)
    try {
      const { target, info } = await regularFile(ctx, exec, path)
      const ok = info.size === undefined || info.size > 0
      checks.push({ name: `required:${relative}`, ok, detail: ok ? target.displayPath : 'file is empty' })
    } catch (error: unknown) {
      exec.signal.throwIfAborted()
      checks.push({ name: `required:${relative}`, ok: false, detail: errorMessage(error) })
    }
  }

  for (const relative of JSON_PATHS) {
    try {
      const text = await readBoundedText(ctx, exec, packagePath(root, relative), config.maxFileBytes)
      JSON.parse(text)
      checks.push({ name: `json:${relative}`, ok: true, detail: 'valid JSON' })
    } catch (error: unknown) {
      exec.signal.throwIfAborted()
      checks.push({ name: `json:${relative}`, ok: false, detail: errorMessage(error) })
    }
  }

  try {
    const text = await readBoundedText(ctx, exec, packagePath(root, 'task.toml'), config.maxFileBytes)
    parseToml(text)
    checks.push({ name: 'toml:task.toml', ok: true, detail: 'valid TOML' })
  } catch (error: unknown) {
    exec.signal.throwIfAborted()
    checks.push({ name: 'toml:task.toml', ok: false, detail: errorMessage(error) })
  }

  try {
    const instruction = await readBoundedText(ctx, exec, packagePath(root, 'instruction.md'), config.maxFileBytes)
    const verifierInstruction = await readBoundedText(ctx, exec, packagePath(root, 'tests/instruction.md'), config.maxFileBytes)
    const ok = instruction === verifierInstruction
    checks.push({ name: 'instructions:byte-identical', ok, detail: ok ? 'instruction files match' : 'instruction.md differs from tests/instruction.md' })
  } catch (error: unknown) {
    exec.signal.throwIfAborted()
    checks.push({ name: 'instructions:byte-identical', ok: false, detail: errorMessage(error) })
  }

  const failures = checks.filter(check => !check.ok).length
  const rootTarget = await ctx.fs.resolve(root, resolveOptions(exec))
  return { valid: failures === 0, root: rootTarget.displayPath, checks, failures }
}

function renderCorpus(value: { records: CorpusRecord[]; scanned: number; truncated: boolean }): string {
  const lines = [`Scanned ${value.scanned} corpus records; returned ${value.records.length}${value.truncated ? ' (result limit reached)' : ''}.`]
  for (const [index, record] of value.records.entries()) {
    lines.push('', `${index + 1}. ${record.url}`)
    const facts = [record.status, record.contentType, record.capturedAt].filter(item => item !== undefined)
    if (facts.length > 0) lines.push(`   ${facts.join(' | ')}`)
    if (record.text !== undefined) lines.push(`   ${record.text}${record.bodyTruncated ? ' … [body truncated]' : ''}`)
  }
  return lines.join('\n')
}

/** Register package validation and, when configured, offline-corpus querying. */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveInteger('maxArchiveBytes', resolved.maxArchiveBytes)
  assertPositiveInteger('maxFileBytes', resolved.maxFileBytes)
  assertPositiveInteger('maxRecordChars', resolved.maxRecordChars)
  assertPositiveInteger('maxContentChars', resolved.maxContentChars)
  assertPositiveInteger('maxResults', resolved.maxResults)
  if (resolved.maxResults > MAX_RESULTS) throw new Error(`tool-builder: maxResults must be no greater than ${MAX_RESULTS}`)

  ctx.systemPrompt.section({
    name: 'tool:builder',
    order: 106,
    text: resolved.enableCorpusQuery
      ? 'Use corpus_query for WARC listing, search, and exact-URL reads instead of writing archive-parsing scripts. Use validate_builder_package once after the required task files are complete; repair only the named failures and rerun it only after a repair.'
      : 'Use validate_builder_package once after the required task files are complete; repair only the named failures and rerun it only after a repair.',
  })

  if (resolved.enableCorpusQuery) ctx.tools.register(defineTool({
    name: 'corpus_query',
    description: 'List, search, or read response records in a local .warc or .warc.gz file without Python, warcio installation, or shell scripts.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to the WARC file, relative to the session workspace or absolute.' },
      operation: { type: 'string', required: true, enum: ['list', 'search', 'read'], description: 'list returns record metadata; search returns matching snippets; read returns one exact URL.' },
      query: { type: 'string', description: 'Case-insensitive plain-text search over URL and decoded response body. Required for search.' },
      url: { type: 'string', description: 'Exact WARC-Target-URI. Required for read.' },
      limit: { type: 'number', description: `Maximum records to return, at most ${MAX_RESULTS}. Defaults to ${resolved.maxResults}.` },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          operation: { type: 'string', required: true, enum: ['list', 'search', 'read'] },
          records: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                url: { type: 'string', required: true },
                capturedAt: { type: 'string' },
                status: { type: 'integer' },
                contentType: { type: 'string' },
                text: { type: 'string' },
                bodyTruncated: { type: 'boolean' },
              },
            },
          },
          scanned: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderCorpus(value) }],
    },
    async execute(args, exec) {
      return await queryCorpus(ctx, exec, parseCorpusInput(args, resolved), resolved)
    },
    isConcurrencySafe: () => true,
    presentCall: args => ({ card: 'generic', kind: 'search', title: 'Query offline corpus', locations: [{ path: args.path }] }),
  }))

  ctx.tools.register(defineTool({
    name: 'validate_builder_package',
    description: 'Run the builder handoff checks once: required nonempty files, JSON/TOML parsing, and byte-identical instruction copies. Returns every failure together.',
    parameters: {
      root: { type: 'string', required: true, description: 'Task package directory, relative to the session workspace or absolute.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          valid: { type: 'boolean', required: true },
          root: { type: 'string', required: true },
          checks: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                ok: { type: 'boolean', required: true },
                detail: { type: 'string', required: true },
              },
            },
          },
          failures: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.valid
          ? `Builder package valid: ${value.checks.length} checks passed.`
          : `Builder package invalid: ${value.failures} of ${value.checks.length} checks failed.\n${value.checks.filter(check => !check.ok).map(check => `- ${check.name}: ${check.detail}`).join('\n')}`,
      }],
    },
    async execute(args, exec) {
      if (args.root.trim().length === 0) throw new Error('root must be a non-empty string')
      return await validatePackage(ctx, exec, args.root, resolved)
    },
    isConcurrencySafe: () => true,
    presentCall: (args): GenericCallView | undefined => ({ card: 'generic', kind: 'search', title: 'Validate builder package', locations: [{ path: args.root }] }),
  }))
}
