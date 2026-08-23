/**
 * Batched read-only access to the SQLite FTS corpus prepared for architecture builders.
 * @module @deepseek-ai/dsh-tool-builder/architecture-corpus
 */

import type { Context } from '@deepseek-ai/cordis'
import type { DatabaseSync } from 'node:sqlite'
import { FsError } from '@deepseek-ai/dsh-fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolExecution } from '@deepseek-ai/dsh-tools'

/** Resolved limits for one indexed architecture-corpus request. */
export interface ArchitectureCorpusConfig {
  maxIndexedQueries: number
  maxIndexedUrls: number
  maxIndexedListResults: number
  maxIndexedResultsPerQuery: number
  maxIndexedSnippetChars: number
  maxIndexedDocumentChars: number
  maxIndexedOutputChars: number
}

interface SearchRow {
  url: string
  requested_url: string
  title: string | null
  media_type: string | null
  snippet: string
  score: number
}

interface DocumentRow {
  url: string
  requested_url: string
  title: string | null
  media_type: string | null
  text: string
}

interface ListRow {
  url: string
  title: string | null
  media_type: string | null
  chars: number
}

interface StatsRow {
  documents: number
  extracted_chars: number
}

interface ArchitectureCorpusHit {
  url: string
  requestedUrl: string
  title?: string
  mediaType?: string
  snippet: string
  score: number
}

interface ArchitectureCorpusDocument {
  url: string
  requestedUrl: string
  title?: string
  mediaType?: string
  text: string
  truncated: boolean
}

interface ArchitectureCorpusListItem {
  url: string
  title?: string
  mediaType?: string
  chars: number
}

interface ArchitectureCorpusResult {
  index: string
  stats: { documents: number; hosts: number; extractedChars: number; estimatedTokens: number }
  searches: Array<{ query: string; hits: ArchitectureCorpusHit[] }>
  documents: ArchitectureCorpusDocument[]
  listed: ArchitectureCorpusListItem[]
}

function workspaceCwd(exec: ToolExecution): string | undefined {
  return exec.agent?.session.header.cwd
}

function uniqueNonempty(values: readonly string[], label: string, maximum: number): string[] {
  const normalized = [...new Set(values.map(value => value.trim()).filter(Boolean))]
  if (normalized.length > maximum) throw new Error(`${label} accepts at most ${maximum} unique values`)
  return normalized
}

function positiveInteger(value: number | undefined, fallback: number, label: string, maximum: number): number {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error(`${label} must be an integer from 1 through ${maximum}`)
  }
  return resolved
}

function clip(value: string, maximum: number): { text: string; truncated: boolean } {
  const points = Array.from(value)
  if (points.length <= maximum) return { text: value, truncated: false }
  return { text: points.slice(0, maximum).join(''), truncated: true }
}

function optionalText(value: string | null): string | undefined {
  return value === null || value === '' ? undefined : value
}

function rowMetadata(row: { title: string | null; media_type: string | null }): { title?: string; mediaType?: string } {
  const metadata: { title?: string; mediaType?: string } = {}
  const title = optionalText(row.title)
  const mediaType = optionalText(row.media_type)
  if (title !== undefined) metadata.title = title
  if (mediaType !== undefined) metadata.mediaType = mediaType
  return metadata
}

function assertDocumentsSchema(db: DatabaseSync, path: string): void {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='documents'",
  ).get() as { sql?: string } | undefined
  const sql = row?.sql ?? ''
  for (const column of ['url', 'requested_url', 'title', 'media_type', 'text']) {
    if (!new RegExp(`\\b${column}\\b`, 'u').test(sql)) {
      throw new Error(`architecture corpus index "${path}" lacks documents.${column}`)
    }
  }
  if (!/using\s+fts5\b/iu.test(sql)) {
    throw new Error(`architecture corpus index "${path}" does not contain the required FTS5 documents table`)
  }
}

function countHosts(db: DatabaseSync): number {
  const rows = db.prepare('SELECT url FROM documents').all() as Array<{ url: string }>
  return new Set(rows.flatMap(({ url }) => {
    try {
      return [new URL(url).host]
    } catch {
      return []
    }
  })).size
}

async function queryArchitectureCorpus(
  ctx: Context,
  exec: ToolExecution,
  args: {
    index: string
    queries?: string[]
    urls?: string[]
    per_query_limit?: number
    list_limit?: number
  },
  config: ArchitectureCorpusConfig,
): Promise<ArchitectureCorpusResult> {
  if (args.index.trim() === '') throw new Error('index must be a non-empty string')
  const cwd = workspaceCwd(exec)
  const target = await ctx.fs.resolve(args.index, { ...(cwd === undefined ? {} : { cwd }), signal: exec.signal })
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined) throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
  if (info.type !== 'file') throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  const queries = uniqueNonempty(args.queries ?? [], 'queries', config.maxIndexedQueries)
  const urls = uniqueNonempty(args.urls ?? [], 'urls', config.maxIndexedUrls)
  const perQueryLimit = positiveInteger(
    args.per_query_limit,
    config.maxIndexedResultsPerQuery,
    'per_query_limit',
    config.maxIndexedResultsPerQuery,
  )
  const listLimit = args.list_limit === undefined
    ? 0
    : positiveInteger(args.list_limit, 1, 'list_limit', config.maxIndexedListResults)
  exec.signal.throwIfAborted()
  const { DatabaseSync } = await import('node:sqlite')
  const processPath = ctx.fs.processPath(target)
  const db = new DatabaseSync(processPath, { readOnly: true })
  try {
    assertDocumentsSchema(db, target.displayPath)
    const stats = db.prepare(
      'SELECT count(*) AS documents, coalesce(sum(length(text)), 0) AS extracted_chars FROM documents',
    ).get() as unknown as StatsRow
    const searchStatement = db.prepare(
      "SELECT url, requested_url, title, media_type, snippet(documents, 4, '[', ']', ' … ', 28) AS snippet, "
      + 'bm25(documents) AS score FROM documents WHERE documents MATCH ? ORDER BY bm25(documents) LIMIT ?',
    )
    const searches = queries.map(query => ({
      query,
      hits: (searchStatement.all(query, perQueryLimit) as unknown as SearchRow[]).map(row => ({
        url: row.url,
        requestedUrl: row.requested_url,
        ...rowMetadata(row),
        snippet: clip(row.snippet.trim(), config.maxIndexedSnippetChars).text,
        score: row.score,
      })),
    }))
    const documentStatement = db.prepare(
      'SELECT url, requested_url, title, media_type, text FROM documents '
      + 'WHERE url = ? OR requested_url = ? LIMIT 1',
    )
    const documents = urls.flatMap((url): ArchitectureCorpusDocument[] => {
      const row = documentStatement.get(url, url) as unknown as DocumentRow | undefined
      if (row === undefined) return []
      const content = clip(row.text, config.maxIndexedDocumentChars)
      return [{
        url: row.url,
        requestedUrl: row.requested_url,
        ...rowMetadata(row),
        text: content.text,
        truncated: content.truncated,
      }]
    })
    const listed = listLimit === 0
      ? []
      : (db.prepare(
        'SELECT url, title, media_type, length(text) AS chars FROM documents ORDER BY rowid LIMIT ?',
      ).all(listLimit) as unknown as ListRow[]).map(row => ({
        url: row.url,
        ...rowMetadata(row),
        chars: row.chars,
      }))
    exec.signal.throwIfAborted()
    return {
      index: target.displayPath,
      stats: {
        documents: stats.documents,
        hosts: countHosts(db),
        extractedChars: stats.extracted_chars,
        estimatedTokens: Math.floor(stats.extracted_chars / 4),
      },
      searches,
      documents,
      listed,
    }
  } finally {
    db.close()
  }
}

function renderArchitectureCorpus(value: ArchitectureCorpusResult, maximum: number): string {
  const lines = [
    `Corpus: ${value.stats.documents} documents, ${value.stats.hosts} hosts, ${value.stats.extractedChars} extracted characters (~${value.stats.estimatedTokens} tokens).`,
  ]
  for (const search of value.searches) {
    lines.push('', `Query: ${search.query} (${search.hits.length} hits)`)
    for (const [index, hit] of search.hits.entries()) {
      lines.push(`${index + 1}. ${hit.title ?? '(untitled)'} — ${hit.url}`)
      lines.push(`   ${hit.mediaType ?? 'unknown type'} | score ${hit.score.toFixed(4)} | ${hit.snippet}`)
    }
  }
  if (value.documents.length > 0) lines.push('', `Exact documents (${value.documents.length})`)
  for (const document of value.documents) {
    lines.push(`${document.title ?? '(untitled)'} — ${document.url}`)
    lines.push(document.text + (document.truncated ? ' … [document truncated]' : ''))
  }
  if (value.listed.length > 0) lines.push('', `Corpus listing (${value.listed.length})`)
  for (const item of value.listed) {
    lines.push(`${item.chars} chars | ${item.mediaType ?? 'unknown type'} | ${item.title ?? '(untitled)'} | ${item.url}`)
  }
  const rendered = lines.join('\n')
  const marker = '\n\n[architecture corpus result truncated to configured output budget]'
  const points = Array.from(rendered)
  if (points.length <= maximum) return rendered
  return points.slice(0, Math.max(0, maximum - Array.from(marker).length)).join('') + marker
}

/**
 * Register the batched SQLite architecture-corpus tool.
 * @param ctx Cordis context that provides tools and filesystem services.
 * @param config Resolved request and rendering limits.
 */
export function registerArchitectureCorpusTool(ctx: Context, config: ArchitectureCorpusConfig): void {
  ctx.tools.register(defineTool({
    name: 'architecture_corpus_query',
    description: 'Batch FTS searches, exact-URL reads, corpus stats, and an optional bounded listing against the frozen architecture search.sqlite index.',
    parameters: {
      index: { type: 'string', required: true, description: 'Path to the frozen search.sqlite index, relative to the session workspace or absolute.' },
      queries: { type: 'array', items: { type: 'string' }, description: `FTS5 queries to run together; at most ${config.maxIndexedQueries}.` },
      urls: { type: 'array', items: { type: 'string' }, description: `Exact final or requested URLs to read together; at most ${config.maxIndexedUrls}.` },
      per_query_limit: { type: 'integer', description: `Hits per query, from 1 through ${config.maxIndexedResultsPerQuery}.` },
      list_limit: { type: 'integer', description: `Also list the first N corpus records, from 1 through ${config.maxIndexedListResults}.` },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          index: { type: 'string', required: true },
          stats: {
            type: 'object', required: true, additionalProperties: false,
            properties: {
              documents: { type: 'integer', required: true },
              hosts: { type: 'integer', required: true },
              extractedChars: { type: 'integer', required: true },
              estimatedTokens: { type: 'integer', required: true },
            },
          },
          searches: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                query: { type: 'string', required: true },
                hits: {
                  type: 'array', required: true,
                  items: {
                    type: 'object', additionalProperties: false,
                    properties: {
                      url: { type: 'string', required: true },
                      requestedUrl: { type: 'string', required: true },
                      title: { type: 'string' },
                      mediaType: { type: 'string' },
                      snippet: { type: 'string', required: true },
                      score: { type: 'number', required: true },
                    },
                  },
                },
              },
            },
          },
          documents: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                url: { type: 'string', required: true },
                requestedUrl: { type: 'string', required: true },
                title: { type: 'string' },
                mediaType: { type: 'string' },
                text: { type: 'string', required: true },
                truncated: { type: 'boolean', required: true },
              },
            },
          },
          listed: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                url: { type: 'string', required: true },
                title: { type: 'string' },
                mediaType: { type: 'string' },
                chars: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderArchitectureCorpus(value, config.maxIndexedOutputChars) }],
    },
    async execute(args, exec) {
      return await queryArchitectureCorpus(ctx, exec, args, config)
    },
    isConcurrencySafe: () => true,
    presentCall: (args): GenericCallView | undefined => ({
      card: 'generic',
      kind: 'search',
      title: 'Query architecture corpus',
      locations: [{ path: args.index }],
    }),
  }))
}
