import { gzipSync } from 'node:zlib'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolRunContext } from '@deepseek-ai/dsh-tools'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import * as ToolBuilder from '@deepseek-ai/dsh-tool-builder'

const signal = new AbortController().signal
let root: string | undefined
let context: Context | undefined
let callNumber = 0

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function setup(config: ToolBuilder.Config = {}): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-tool-builder-'))
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FsLocal, { cwd: root })
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
      .toEqual(['corpus_query', 'validate_builder_package'])
    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    expect(prompt).toContain('Use corpus_query for WARC listing')
    expect(prompt).toContain('Use validate_builder_package once')
  })

  it('omits corpus querying and its guidance for a normal synthetic pipeline', async () => {
    const ctx = await setup({ enableCorpusQuery: false })
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(['validate_builder_package'])
    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    expect(prompt).not.toContain('corpus_query')
    expect(prompt).toContain('Use validate_builder_package once')
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
    for (const config of [{ maxArchiveBytes: 0 }, { maxArchiveBytes: 1.5 }, { maxResults: 101 }]) {
      const failed = new Context()
      await failed.plugin(SystemPrompt)
      await failed.plugin(ToolRuntime)
      await failed.plugin(FsLocal, { cwd: process.cwd() })
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
