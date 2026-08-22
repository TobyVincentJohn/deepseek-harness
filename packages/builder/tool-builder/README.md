# @deepseek-ai/dsh-tool-builder

English | [中文](README.zh.md)

Builder-specific model tools over `ctx.fs`. The package checks a synthetic task package's cheap generation handoff and can parse offline WARC files in-process without asking the model to write Python, install `warcio`, rediscover required paths, or interpret validator output.

## Tools

When `enableCorpusQuery` is true, `corpus_query` accepts a WARC path and one operation. `list` returns response metadata, `search` performs a case-insensitive plain-text scan over response URLs and decoded bodies, and `read` returns the decoded body for one exact `WARC-Target-URI`. The complete compressed archive is read through the filesystem service under `maxArchiveBytes`; record bodies are consumed incrementally and retained only to `maxRecordChars`. Search snippets and exact reads are bounded independently.

`validate_builder_package` checks the fixed builder task tree for regular nonempty files, parses its JSON and `task.toml`, and compares `instruction.md` with `tests/instruction.md` byte-for-byte. It reports every discovered failure in one result and does not run Harbor, an oracle, a judge, Docker, or task-owned verifier code.

Each enabled tool resolves relative paths against the calling session's workspace, forwards cancellation to filesystem operations, and declares a generic search-style UI card with its target path.

## Config

| Field | Default | Meaning |
|---|---:|---|
| `enableCorpusQuery` | `true` | Register `corpus_query` and its WARC-specific prompt guidance. |
| `maxArchiveBytes` | `268435456` | Largest complete compressed WARC accepted by one query. |
| `maxFileBytes` | `16777216` | Largest task text file read by validation. |
| `maxRecordChars` | `2000000` | Decoded characters retained while scanning one response body. |
| `maxContentChars` | `12000` | Decoded characters returned by an exact-URL read. |
| `maxResults` | `20` | Default record count returned by a query; per-call `limit` cannot exceed 100. |

Every numeric value must be a positive integer. `maxResults` cannot exceed 100; invalid configuration fails plugin load.

## Model Experience

### Builder prompt guidance

#### What the model sees

The builder receives one fixed instruction selected by `enableCorpusQuery`.

##### Builder tool guidance with corpus query

```markdown
Use corpus_query for WARC listing, search, and exact-URL reads instead of writing archive-parsing scripts. Use validate_builder_package once after the required task files are complete; repair only the named failures and rerun it only after a repair.
```

##### Builder tool guidance without corpus query

```markdown
Use validate_builder_package once after the required task files are complete; repair only the named failures and rerun it only after a repair.
```

#### Token effect

The fixed validation guidance and schema join every request using this plugin. Enabling corpus queries adds the WARC guidance and schema; results are bounded by record count, snippet size, exact-read size, and the fixed validation check count.

#### KV Cache effect

The prompt and schemas are prefix-stable for the plugin lifetime. Tool calls and their bounded results append to conversation history.

## Known Limitations and Deferred Work

- **WARC input is buffered under a hard limit** — the filesystem seam currently exposes bounded whole-file bytes rather than a raw-byte stream, so one query holds the compressed archive in memory up to `maxArchiveBytes`.
- **HTML conversion is intentionally syntactic** — the query removes tags and common entities without browser layout, JavaScript execution, or full HTML entity decoding.
- **Validation covers the shared cheap handoff only** — signed-inventory coherence, rubric semantics, verifier scoring, Harbor, and pipeline-specific gates remain owned by their pipeline stages.
