import { gzipSync } from 'node:zlib'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolRunContext } from '@deepseek-ai/dsh-tools'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import * as ToolBuilder from '@deepseek-ai/dsh-tool-builder'

const signal = new AbortController().signal
let root: string | undefined
let context: Context | undefined
let callNumber = 0
let shellSpecs: ShellExecSpec[] = []
let refreshValidatorReport = true
let validatorExitCode: number | null = 0
let validatorStderr = ''

class FixtureShell extends ShellExecutor {
  resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      command: request.command,
      workdir: request.workdir ?? process.cwd(),
      timeoutMs: request.timeoutMs ?? 1_000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 64_000,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    shellSpecs.push(spec)
    if (refreshValidatorReport) {
      const report = join(spec.workdir, 'task-planning/architecture-validation.json')
      await writeFile(report, await readFile(report))
    }
    return {
      exitCode: validatorExitCode,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: 'validator complete', truncated: false },
      stderr: { text: validatorStderr, truncated: false },
    }
  }

  start(): ShellProcess {
    throw new Error('not used by tool-builder tests')
  }
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  shellSpecs = []
  refreshValidatorReport = true
  validatorExitCode = 0
  validatorStderr = ''
})

async function setup(config: ToolBuilder.Config = {}): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-tool-builder-'))
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FsLocal, { cwd: root })
  await ctx.plugin(FixtureShell)
  await ctx.plugin(ToolBuilder, config)
  context = ctx
  return ctx
}

async function call(ctx: Context, name: string, argumentsValue: unknown) {
  return await ctx.tools.execute({
    signal,
    callId: CallId(`builder-${++callNumber}`),
    name,
    arguments: argumentsValue,
  })
}

async function callAtCwd(ctx: Context, name: string, argumentsValue: unknown) {
  return await ctx.tools.execute({
    signal,
    callId: CallId(`builder-${++callNumber}`),
    name,
    arguments: argumentsValue,
    agent: { session: { header: { cwd: root } } } as never,
  })
}

function warcResponse(url: string, body: string): string {
  const http = `HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${body}`
  return [
    'WARC/1.0',
    'WARC-Type: response',
    `WARC-Target-URI: ${url}`,
    'WARC-Date: 2026-08-22T00:00:00Z',
    'WARC-Record-ID: <urn:uuid:00000000-0000-0000-0000-000000000001>',
    'Content-Type: application/http; msgtype=response',
    `Content-Length: ${Buffer.byteLength(http)}`,
    '',
    http,
    '',
    '',
  ].join('\r\n')
}

function warcRecord(type: string, headers: string[], content = '', includeDate = true): string {
  return [
    'WARC/1.0',
    `WARC-Type: ${type}`,
    ...(includeDate ? ['WARC-Date: 2026-08-22T00:00:00Z'] : []),
    'WARC-Record-ID: <urn:uuid:00000000-0000-0000-0000-000000000002>',
    ...headers,
    `Content-Length: ${Buffer.byteLength(content)}`,
    '',
    content,
    '',
    '',
  ].join('\r\n')
}

const requiredPaths = [
  '.gitattributes', 'task.toml', 'instruction.md', 'environment/Dockerfile',
  'environment/pywb/config.yaml', 'environment/corpus/archive.warc.gz',
  'environment/scripts/corpus_server.py', 'environment/scripts/start.sh',
  'solution/solve.sh', 'solution/report.md', 'solution/evidence_graph.json',
  'tests/instruction.md', 'tests/Dockerfile', 'tests/rubrics.json',
  'tests/source_tiers.txt', 'tests/test.sh', 'tests/test_outputs.py',
  'tests/reference/canonical_claim_ledger.json',
  'tests/reference/corpus_manifest.json', 'tests/reference/ground_truth.json',
  'tests/reference/reasoning_blueprint.json',
]

async function writeTask(taskRoot: string): Promise<void> {
  for (const relative of requiredPaths) {
    await mkdir(join(taskRoot, relative, '..'), { recursive: true })
    let content: string | Uint8Array = 'x\n'
    if (relative.endsWith('.json')) content = '{}\n'
    if (relative === 'task.toml') content = '[task]\nname = "fixture"\n'
    if (relative === 'instruction.md' || relative === 'tests/instruction.md') content = 'Build the task.\n'
    if (relative.endsWith('.warc.gz')) content = gzipSync(warcResponse('https://example.test/', '<p>fixture</p>'))
    await writeFile(join(taskRoot, relative), content)
  }
}

describe('tool-builder registration and corpus query', () => {
  it('registers the focused tools and prompt guidance', async () => {
    const ctx = await setup()
    expect(ctx.tools.schemas().map(schema => schema.name).sort())
      .toEqual([
        'architecture_corpus_query',
        'corpus_query',
        'validate_architecture_candidate',
        'validate_builder_package',
      ])
    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    expect(prompt).toContain('Use corpus_query for WARC listing')
    expect(prompt).toContain('architecture_corpus_query')
    expect(prompt).toContain('validate_architecture_candidate')
    expect(prompt).toContain('Use validate_builder_package once')
  })

  it('keeps archive, index, and package tools active when no shell provider is mounted', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-tool-builder-no-shell-'))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(FsLocal, { cwd: root })
    await ctx.plugin(ToolBuilder)
    context = ctx
    expect(ctx.tools.schemas().map(schema => schema.name).sort()).toEqual([
      'architecture_corpus_query',
      'corpus_query',
      'validate_builder_package',
    ])
    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    expect(prompt).toContain('architecture_corpus_query')
    expect(prompt).not.toContain('validate_architecture_candidate')
  })

  it('searches gzip WARC responses and reads an exact URL without Python', async () => {
    const ctx = await setup()
    const archive = join(root!, 'archive.warc.gz')
    const raw = warcResponse('https://example.test/alpha', '<html><p>Alpha needle result</p></html>')
      + warcResponse('https://example.test/beta', '<html><p>Unrelated page</p></html>')
    await writeFile(archive, gzipSync(raw))

    const searched = await call(ctx, 'corpus_query', {
      path: archive,
      operation: 'search',
      query: 'needle',
    })
    expect(searched.isError).toBe(false)
    expect(searched.value).toMatchObject({
      operation: 'search',
      records: [{ url: 'https://example.test/alpha', status: 200 }],
    })
    expect(JSON.stringify(searched.value)).toContain('Alpha needle result')

    const read = await call(ctx, 'corpus_query', {
      path: archive,
      operation: 'read',
      url: 'https://example.test/beta',
    })
    expect(read.isError).toBe(false)
    expect(JSON.stringify(read.value)).toContain('Unrelated page')
  })

  it('bounds list/search/read work and handles non-response and header-light records', async () => {
    const ctx = await setup({ maxRecordChars: 200, maxContentChars: 20 })
    const archive = join(root!, 'mixed.warc.gz')
    const raw = warcRecord('metadata', ['Content-Type: application/json'], '{}')
      + warcRecord('resource', [
        'WARC-Target-URI: https://example.test/resource',
        'Content-Type: text/plain',
      ], `URL-only match ${'x'.repeat(300)}`)
      + warcResponse('https://example.test/final', `<style>x{}</style><script>bad()</script><p>A&nbsp;&amp;&lt;&gt;&quot; ${'z'.repeat(100)}</p>`)
      + warcRecord('resource', [], 'header light', false)
    await writeFile(archive, gzipSync(raw))

    const listed = await call(ctx, 'corpus_query', { path: archive, operation: 'list', limit: 1 })
    expect(listed.value).toMatchObject({ scanned: 1, truncated: true, records: [{ url: 'https://example.test/resource' }] })

    const searched = await call(ctx, 'corpus_query', {
      path: archive,
      operation: 'search',
      query: 'https://example.test/resource',
      limit: 1,
    })
    expect(searched.value).toMatchObject({ scanned: 1, truncated: true, records: [{ bodyTruncated: true }] })

    const missing = await call(ctx, 'corpus_query', { path: archive, operation: 'search', query: 'absent' })
    expect(missing.value).toMatchObject({ scanned: 3, records: [], truncated: false })

    const read = await call(ctx, 'corpus_query', {
      path: archive,
      operation: 'read',
      url: 'https://example.test/final',
    })
    expect(read.value).toMatchObject({ records: [{ text: 'A &<>" zzzzzzzzzzzzz', bodyTruncated: true }] })

    const all = await call(ctx, 'corpus_query', { path: archive, operation: 'list', limit: 10 })
    expect(all.value).toMatchObject({ scanned: 3, truncated: false })
    expect((all.value as { records: Array<{ url: string }> }).records.at(-1)).toEqual({ url: '' })
  })

  it('fails loud on invalid config, arguments, paths, and archive limits', async () => {
    for (const config of [
      { maxArchiveBytes: 0 },
      { maxArchiveBytes: 1.5 },
      { maxResults: 101 },
      { architectureExpectedLaneId: ' ' },
    ]) {
      const failed = new Context()
      await failed.plugin(SystemPrompt)
      await failed.plugin(ToolRuntime)
      await failed.plugin(FsLocal, { cwd: process.cwd() })
      await failed.plugin(FixtureShell)
      await expect(failed.plugin(ToolBuilder, config)).rejects.toThrow(/tool-builder/)
      await failed.fiber.dispose()
    }

    const ctx = await setup({ maxArchiveBytes: 10 })
    const archive = join(root!, 'large.warc.gz')
    await writeFile(archive, gzipSync(warcResponse('https://example.test/', '<p>large</p>')))
    await mkdir(join(root!, 'directory.warc'))
    const cases = [
      { path: ' ', operation: 'list' },
      { path: archive, operation: 'search' },
      { path: archive, operation: 'search', query: ' ' },
      { path: archive, operation: 'read' },
      { path: archive, operation: 'read', url: ' ' },
      { path: archive, operation: 'list', limit: 0 },
      { path: archive, operation: 'list', limit: 1.5 },
      { path: archive, operation: 'list', limit: 101 },
      { path: 'missing.warc.gz', operation: 'list' },
      { path: 'directory.warc', operation: 'list' },
      { path: archive, operation: 'list' },
    ]
    for (const args of cases) {
      const result = await call(ctx, 'corpus_query', args)
      expect(result.isError).toBe(true)
    }
    const invalidRoot = await call(ctx, 'validate_builder_package', { root: ' ' })
    expect(invalidRoot.isError).toBe(true)
  })

  it('batches indexed FTS searches, exact reads, stats, and listings under one output cap', async () => {
    const ctx = await setup({
      maxIndexedSnippetChars: 30,
      maxIndexedDocumentChars: 40,
      maxIndexedOutputChars: 500,
    })
    const index = join(root!, 'search.sqlite')
    const db = new DatabaseSync(index)
    db.exec("CREATE VIRTUAL TABLE documents USING fts5(url UNINDEXED, requested_url UNINDEXED, title, media_type UNINDEXED, text, tokenize='porter unicode61')")
    const insert = db.prepare('INSERT INTO documents(url, requested_url, title, media_type, text) VALUES(?,?,?,?,?)')
    insert.run('https://example.test/alpha', 'https://example.test/a', 'Alpha', 'text/html', `needle ${'x'.repeat(100)}`)
    insert.run('https://second.test/beta', 'https://second.test/beta', 'Beta', 'text/plain', 'second needle result')
    db.close()

    const result = await callAtCwd(ctx, 'architecture_corpus_query', {
      index,
      queries: ['needle', 'needle', 'second'],
      urls: ['https://example.test/a', 'https://missing.test/'],
      per_query_limit: 2,
      list_limit: 2,
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ stats: { documents: 2, hosts: 2 } })
    const value = result.value as {
      searches: Array<{ query: string; hits: Array<{ title: string }> }>
      documents: Array<{ url: string; truncated: boolean }>
      listed: Array<{ title: string }>
    }
    expect(value.searches.map(search => search.query)).toEqual(['needle', 'second'])
    expect(value.searches[0]?.hits.map(hit => hit.title)).toEqual(['Alpha', 'Beta'])
    expect(value.documents).toMatchObject([{ url: 'https://example.test/alpha', truncated: true }])
    expect(value.listed).toMatchObject([{ title: 'Alpha' }, { title: 'Beta' }])
    const tool = ctx.tools.get('architecture_corpus_query')!
    const rendered = tool.output.render({}, result.value!)[0]
    expect(rendered).toMatchObject({ type: 'text' })
    expect((rendered as { text: string }).text.length).toBeLessThanOrEqual(500)
    expect(tool.presentCall?.({ index })).toMatchObject({ kind: 'search' })
    expect(tool.isConcurrencySafe?.({ index })).toBe(true)
  })

  it('rejects malformed indexed corpus requests and incompatible databases', async () => {
    const ctx = await setup({ maxIndexedQueries: 1, maxIndexedUrls: 1 })
    const plain = join(root!, 'plain.sqlite')
    const db = new DatabaseSync(plain)
    db.exec('CREATE TABLE documents(url TEXT)')
    db.close()
    const empty = join(root!, 'empty.sqlite')
    new DatabaseSync(empty).close()
    const nonFts = join(root!, 'non-fts.sqlite')
    const nonFtsDb = new DatabaseSync(nonFts)
    nonFtsDb.exec('CREATE TABLE documents(url TEXT, requested_url TEXT, title TEXT, media_type TEXT, text TEXT)')
    nonFtsDb.close()
    const invalidUrl = join(root!, 'invalid-url.sqlite')
    const invalidUrlDb = new DatabaseSync(invalidUrl)
    invalidUrlDb.exec('CREATE VIRTUAL TABLE documents USING fts5(url UNINDEXED, requested_url UNINDEXED, title, media_type UNINDEXED, text)')
    invalidUrlDb.prepare('INSERT INTO documents VALUES(?,?,?,?,?)').run('not a URL', 'not a URL', null, null, 'body')
    invalidUrlDb.close()
    await mkdir(join(root!, 'directory.sqlite'))
    const cases = [
      { index: ' ' },
      { index: 'missing.sqlite' },
      { index: 'directory.sqlite' },
      { index: empty },
      { index: plain },
      { index: nonFts },
      { index: plain, queries: ['one', 'two'] },
      { index: plain, urls: ['one', 'two'] },
      { index: plain, per_query_limit: 0 },
      { index: plain, list_limit: 101 },
    ]
    for (const args of cases) {
      expect((await call(ctx, 'architecture_corpus_query', args)).isError).toBe(true)
    }
    const invalidUrlResult = await call(ctx, 'architecture_corpus_query', { index: invalidUrl, list_limit: 1 })
    expect(invalidUrlResult.isError).toBe(false)
    expect(invalidUrlResult.value).toMatchObject({ stats: { hosts: 0 } })
    const tool = ctx.tools.get('architecture_corpus_query')!
    const listedText = tool.output.render({}, invalidUrlResult.value!)[0] as { text: string }
    expect(listedText.text).toContain('unknown type | (untitled) | not a URL')

    const queried = await call(ctx, 'architecture_corpus_query', {
      index: invalidUrl,
      queries: ['body'],
      urls: ['not a URL'],
    })
    expect(queried.isError).toBe(false)
    expect(queried.value).toMatchObject({ documents: [{ truncated: false }], listed: [] })
    const queriedText = tool.output.render({}, queried.value!)[0] as { text: string }
    expect(queriedText.text).toContain('(untitled) — not a URL')
    expect(queriedText.text).not.toContain('result truncated')
  })

  it('runs the pipeline architecture validator with configured paths and returns its report', async () => {
    const ctx = await setup({
      architectureValidatorScript: 'scripts/validate_architecture_candidate.py',
      pythonExecutable: '/fixture/python',
      maxArchitectureValidationOutputChars: 300,
      architectureExpectedLaneId: 'architecture-01',
    })
    await mkdir(join(root!, 'scripts'), { recursive: true })
    await mkdir(join(root!, 'task-planning/lake-cache'), { recursive: true })
    await writeFile(join(root!, 'scripts/validate_architecture_candidate.py'), '# fixture\n')
    await writeFile(join(root!, 'candidate.json'), '{}\n')
    await writeFile(join(root!, 'task-planning/base_sources.json'), '{}\n')
    await writeFile(join(root!, 'task-planning/architecture-seed.json'), '{}\n')
    await writeFile(join(root!, 'task-planning/architecture-validation.json'), JSON.stringify({ valid: true, errors: [] }))
    await writeFile(join(root!, 'repair-feedback.json'), '{}\n')

    const result = await callAtCwd(ctx, 'validate_architecture_candidate', {
      candidate: 'candidate.json',
      repair_feedback: 'repair-feedback.json',
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ valid: true, exitCode: 0, report: { valid: true } })
    expect(shellSpecs).toHaveLength(1)
    expect(shellSpecs[0]?.command).toContain("'--candidate'")
    expect(shellSpecs[0]?.command).toContain("'--strict-adversarial-site-min' '16'")
    expect(shellSpecs[0]?.command).toContain("'--expected-lane-id' 'architecture-01'")
    expect(shellSpecs[0]?.command).toContain("'--repair-feedback'")
    const tool = ctx.tools.get('validate_architecture_candidate')!
    expect(tool.presentCall?.({ candidate: 'candidate.json' })).toMatchObject({ kind: 'search' })
    expect(tool.isConcurrencySafe?.({ candidate: 'candidate.json' })).toBe(false)
    const rendered = tool.output.render({}, result.value!)[0] as { text: string }
    expect(rendered.text.length).toBeLessThanOrEqual(300)
    expect(rendered.text).toContain('Architecture candidate valid')
    const invalidRendered = tool.output.render({}, {
      valid: false,
      exitCode: null,
      reportPath: 'report.json',
      mergedPlanPath: 'merged.json',
      report: { valid: false },
      stdout: '',
      stderr: 'failed',
    })[0] as { text: string }
    expect(invalidRendered.text).toContain('Architecture candidate invalid; validator exit signal.')
  })

  it('reports missing validator configuration and rejects unusable reports', async () => {
    const ctx = await setup({ maxFileBytes: 30 })
    await mkdir(join(root!, 'scripts'), { recursive: true })
    await mkdir(join(root!, 'task-planning/lake-cache'), { recursive: true })
    await writeFile(join(root!, 'scripts/validator.py'), '# fixture\n')
    await writeFile(join(root!, 'candidate.json'), '{}\n')
    await writeFile(join(root!, 'task-planning/base_sources.json'), '{}\n')
    await writeFile(join(root!, 'task-planning/architecture-seed.json'), '{}\n')
    await writeFile(join(root!, 'task-planning/architecture-validation.json'), '{}\n')

    expect((await call(ctx, 'validate_architecture_candidate', { candidate: ' ' })).isError).toBe(true)
    expect((await call(ctx, 'validate_architecture_candidate', { candidate: 'candidate.json' })).isError).toBe(true)
    expect((await call(ctx, 'validate_architecture_candidate', {
      candidate: 'candidate.json',
      validator_script: 'scripts/validator.py',
    })).isError).toBe(true)
    expect((await call(ctx, 'validate_architecture_candidate', {
      candidate: 'candidate.json',
      validator_script: 'scripts/validator.py',
      python_executable: '/fixture/python',
      expected_lane_id: ' ',
    })).isError).toBe(true)
    expect((await call(ctx, 'validate_architecture_candidate', {
      candidate: 'candidate.json',
      validator_script: 'scripts/validator.py',
      python_executable: '/fixture/python',
      repair_feedback: 'missing-feedback.json',
    })).isError).toBe(true)
    expect((await call(ctx, 'validate_architecture_candidate', {
      candidate: 'missing.json',
      validator_script: 'scripts/validator.py',
      python_executable: '/fixture/python',
    })).isError).toBe(true)
    await mkdir(join(root!, 'candidate-directory'))
    expect((await call(ctx, 'validate_architecture_candidate', {
      candidate: 'candidate-directory',
      validator_script: 'scripts/validator.py',
      python_executable: '/fixture/python',
    })).isError).toBe(true)

    await writeFile(join(root!, 'task-planning/architecture-validation.json'), JSON.stringify({ detail: 'x'.repeat(100) }))
    expect((await call(ctx, 'validate_architecture_candidate', {
      candidate: 'candidate.json',
      validator_script: 'scripts/validator.py',
      python_executable: '/fixture/python',
      workspace: root,
    })).isError).toBe(true)

    refreshValidatorReport = false
    expect((await call(ctx, 'validate_architecture_candidate', {
      candidate: 'candidate.json',
      validator_script: 'scripts/validator.py',
      python_executable: '/fixture/python',
    })).isError).toBe(true)
    refreshValidatorReport = true

    refreshValidatorReport = false
    validatorExitCode = 2
    validatorStderr = 'missing dependency: example'
    const failedProcess = await call(ctx, 'validate_architecture_candidate', {
      candidate: 'candidate.json',
      validator_script: 'scripts/validator.py',
      python_executable: '/fixture/python',
    })
    expect(failedProcess.isError).toBe(true)
    expect(JSON.stringify(failedProcess)).toContain('missing dependency: example')
    refreshValidatorReport = true
    validatorExitCode = 0
    validatorStderr = ''

    await writeFile(join(root!, 'task-planning/architecture-validation.json'), JSON.stringify({ valid: false }))
    const invalid = await call(ctx, 'validate_architecture_candidate', {
      candidate: 'candidate.json',
      validator_script: 'scripts/validator.py',
      python_executable: '/fixture/python',
    })
    expect(invalid.value).toMatchObject({ valid: false, exitCode: 0 })

    await writeFile(join(root!, 'task-planning/architecture-validation.json'), '[]')
    expect((await call(ctx, 'validate_architecture_candidate', {
      candidate: 'candidate.json',
      validator_script: 'scripts/validator.py',
      python_executable: '/fixture/python',
    })).isError).toBe(true)
  })

  it('exposes deterministic presentation and renderer metadata', async () => {
    const ctx = await setup()
    const corpus = ctx.tools.get('corpus_query')!
    expect(corpus.presentCall?.(null)).toBeUndefined()
    expect(corpus.presentCall?.({})).toBeUndefined()
    expect(corpus.presentCall?.({ path: 1 })).toBeUndefined()
    expect(corpus.presentCall?.({ path: 'archive.warc.gz', operation: 'list' })).toMatchObject({ kind: 'search' })
    expect(corpus.isConcurrencySafe?.({ path: 'archive.warc.gz', operation: 'list' })).toBe(true)
    expect(corpus.output.render({}, {
      path: 'archive.warc.gz',
      operation: 'search',
      scanned: 2,
      truncated: true,
      records: [
        { url: 'https://example.test/plain' },
        { url: 'https://example.test/text', status: 200, contentType: 'text/plain', capturedAt: 'now', text: 'body', bodyTruncated: true },
      ],
    })[0]).toMatchObject({ type: 'text' })

    await writeFile(join(root!, 'relative.warc.gz'), gzipSync(
      warcResponse('https://example.test/relative', '<p>relative cwd</p>'),
    ))
    const relativeResult = await corpus.execute({
      path: 'relative.warc.gz',
      operation: 'list',
    }, {
      signal,
      agent: { session: { header: { cwd: root } } },
    } as unknown as ToolRunContext)
    expect(relativeResult).toMatchObject({ records: [{ url: 'https://example.test/relative' }] })

    const validator = ctx.tools.get('validate_builder_package')!
    expect(validator.isConcurrencySafe?.({ root: 'task' })).toBe(true)
    expect(validator.presentCall?.({ root: 'task' })).toMatchObject({ kind: 'search' })
    expect(validator.output.render({}, { valid: true, root: 'task', checks: [], failures: 0 })[0])
      .toMatchObject({ type: 'text', text: 'Builder package valid: 0 checks passed.' })
    expect(validator.output.render({}, {
      valid: false,
      root: 'task',
      checks: [{ name: 'required:x', ok: false, detail: 'missing' }],
      failures: 1,
    })[0]).toMatchObject({ type: 'text' })
  })
})

describe('builder package validation', () => {
  it('returns one successful aggregate for the complete cheap handoff', async () => {
    const ctx = await setup()
    const taskRoot = join(root!, 'task')
    await writeTask(taskRoot)

    const result = await call(ctx, 'validate_builder_package', { root: taskRoot })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ valid: true, failures: 0 })
  })

  it('reports every structural and parse failure together', async () => {
    const ctx = await setup()
    const taskRoot = join(root!, 'task')
    await writeTask(taskRoot)
    await writeFile(join(taskRoot, 'tests/instruction.md'), 'different\n')
    await writeFile(join(taskRoot, 'tests/rubrics.json'), '{bad json')
    await rm(join(taskRoot, 'solution/report.md'))

    const result = await call(ctx, 'validate_builder_package', { root: taskRoot })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ valid: false, failures: 3 })
    expect(JSON.stringify(result.value)).toContain('required:solution/report.md')
    expect(JSON.stringify(result.value)).toContain('json:tests/rubrics.json')
    expect(JSON.stringify(result.value)).toContain('instructions:byte-identical')
  })

  it('reports empty files, directories, invalid TOML, invalid UTF-8, and size limits in one pass', async () => {
    const ctx = await setup({ maxFileBytes: 20 })
    const taskRoot = join(root!, 'task')
    await writeTask(taskRoot)
    await writeFile(join(taskRoot, '.gitattributes'), '')
    await rm(join(taskRoot, 'environment/pywb/config.yaml'))
    await mkdir(join(taskRoot, 'environment/pywb/config.yaml'))
    await writeFile(join(taskRoot, 'task.toml'), 'not = [valid')
    await writeFile(join(taskRoot, 'tests/rubrics.json'), new Uint8Array([0xff, 0xfe]))
    await writeFile(join(taskRoot, 'tests/reference/ground_truth.json'), JSON.stringify({ value: 'x'.repeat(100) }))
    await writeFile(join(taskRoot, 'tests/instruction.md'), 'x'.repeat(100))

    const result = await call(ctx, 'validate_builder_package', { root: `${taskRoot}/` })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ valid: false })
    const serialized = JSON.stringify(result.value)
    expect(serialized).toContain('file is empty')
    expect(serialized).toContain('not a regular file')
    expect(serialized).toContain('toml:task.toml')
    expect(serialized).toContain('file exceeds 20 bytes')
    expect(serialized).toContain('instructions:byte-identical')
  })
})
