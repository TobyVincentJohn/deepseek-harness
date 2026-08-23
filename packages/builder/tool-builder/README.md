# @deepseek-ai/dsh-tool-builder

English | [中文](README.zh.md)

Builder-specific model tools over `ctx.fs` and `ctx.shell`. The package parses packaged WARC files, batches indexed architecture-corpus reads, runs a pipeline-owned architecture validator, and checks a synthetic task package's cheap generation handoff without asking the model to construct scripts or validator commands.

## Tools

`corpus_query` accepts a WARC path and one operation. `list` returns response metadata, `search` performs a case-insensitive plain-text scan over response URLs and decoded bodies, and `read` returns the decoded body for one exact `WARC-Target-URI`. The complete compressed archive is read through the filesystem service under `maxArchiveBytes`; record bodies are consumed incrementally and retained only to `maxRecordChars`. Search snippets and exact reads are bounded independently.

`architecture_corpus_query` opens a frozen `search.sqlite` FTS5 index read-only and accepts multiple searches, exact final/requested URLs, and an optional listing in one call. Every result includes corpus statistics. Per-query hits, snippets, documents, list rows, and the complete rendered result have independent configurable limits.

When `ctx.shell` is available, `validate_architecture_candidate` invokes the pipeline-owned Python validator with configured workspace-relative inputs, output paths, corpus targets, generation caps, and expected lane. A launch environment may configure the script and Python paths, or a call may provide them explicitly. A call may also override the expected lane or supply repair feedback. The tool reads the validator's JSON report, returns it with bounded diagnostics, and leaves the merged plan and exact report at their configured paths. If the subprocess fails before refreshing the report, its bounded stdout and stderr are retained in the tool error.

`validate_builder_package` checks the fixed builder task tree for regular nonempty files, parses its JSON and `task.toml`, and compares `instruction.md` with `tests/instruction.md` byte-for-byte. It reports every discovered failure in one result and does not run Harbor, an oracle, a judge, Docker, or task-owned verifier code.

All tools resolve relative paths against the calling session's workspace and declare generic search-style UI cards with their target paths. Indexed SQLite statements are synchronous and check cancellation before and after each batch; the validator forwards cancellation through `ctx.shell`.

## Config

| Field | Default | Meaning |
|---|---:|---|
| `maxArchiveBytes` | `268435456` | Largest complete compressed WARC accepted by one query. |
| `maxFileBytes` | `16777216` | Largest task text file read by validation. |
| `maxRecordChars` | `2000000` | Decoded characters retained while scanning one response body. |
| `maxContentChars` | `12000` | Decoded characters returned by an exact-URL read. |
| `maxResults` | `20` | Default record count returned by a query; per-call `limit` cannot exceed 100. |
| `maxIndexedQueries` / `maxIndexedUrls` | `20` / `40` | Unique FTS queries and exact URLs accepted by one architecture call. |
| `maxIndexedListResults` / `maxIndexedResultsPerQuery` | `100` / `8` | Listing and per-query hit limits. |
| `maxIndexedSnippetChars` / `maxIndexedDocumentChars` | `600` / `4000` | Text retained per FTS hit and exact document. |
| `maxIndexedOutputChars` | `12000` | Complete model-visible architecture-corpus result limit. |
| `architectureValidatorScript` / `pythonExecutable` | unset | Launch-configured command paths; each call may supply missing values. |
| `architectureBaseSourcesPath` / `architectureSeedPath` | `task-planning/base_sources.json` / `task-planning/architecture-seed.json` | Validator input paths relative to the architecture workspace. |
| `architectureReportPath` / `architectureMergedPlanPath` | `task-planning/architecture-validation.json` / `task-planning/architecture-merged-plan.json` | Validator output paths relative to the architecture workspace. |
| `architecturePreloadedDir` | `task-planning/lake-cache` | Frozen indexed corpus directory passed to the validator. |
| `architectureExpectedLaneId` | `architecture-01` | Expected lane identifier passed to the validator; a call may override it. |
| `architectureSourceCap` / `architectureEvidenceCap` | `520` / `110` | Source and architect-evidence caps passed to the validator. |
| `architectureTargetSites` / `architectureTargetDocuments` / `architectureMaxDocuments` | `150` / `300` / `300` | Corpus sizing targets passed to the validator. |
| `architectureTargetTokens` / `architectureStorageBudgetBytes` | `4500000` / `1800000000` | Token and storage targets passed to the validator. |
| `architectureAdversarialSiteMin` / `architectureStrictAdversarialSiteMin` | `45` / `16` | Adversarial website minima passed to the validator. |
| `architectureValidatorTimeoutMs` | `120000` | Validator subprocess timeout. |
| `maxArchitectureValidationOutputChars` | `12000` | Complete model-visible validation-result limit. |

Every numeric limit must be a positive integer. `architectureExpectedLaneId` must be nonempty, and `maxResults` cannot exceed 100; invalid configuration fails plugin load.

## Model Experience

### Builder prompt guidance

#### What the model sees

The builder always receives one instruction that routes packaged archives, indexed architecture corpora, and final handoff checks through the native tools. When `ctx.shell` is available, it receives a second instruction for architecture validation.

##### Builder tool guidance

```markdown
Use corpus_query for WARC listing, search, and exact-URL reads. For architecture work, batch FTS searches and exact reads through architecture_corpus_query. Use validate_builder_package once after final task-package files are complete. Repair only named validation failures and rerun only after a repair.

Run validate_architecture_candidate after the architecture candidate is complete. Repair only named validation failures and rerun only after a repair.
```

#### Token effect

The fixed guidance and three always-on schemas join every request using this plugin. The validator guidance and fourth schema join requests only when `ctx.shell` is available. Corpus and validation results have complete model-visible character limits in addition to item and per-document limits.

#### KV Cache effect

The prompt and schemas are prefix-stable for the plugin lifetime. Tool calls and their bounded results append to conversation history.

## Known Limitations and Deferred Work

- **WARC input is buffered under a hard limit** — the filesystem seam currently exposes bounded whole-file bytes rather than a raw-byte stream, so one query holds the compressed archive in memory up to `maxArchiveBytes`.
- **HTML conversion is intentionally syntactic** — the query removes tags and common entities without browser layout, JavaScript execution, or full HTML entity decoding.
- **Indexed queries require the pipeline schema** — `architecture_corpus_query` accepts the FTS5 `documents(url, requested_url, title, media_type, text)` table produced by the offline-search architecture stage; it does not migrate or repair indexes.
- **SQLite execution is synchronous** — one FTS statement blocks the agent process until SQLite returns and cannot be interrupted mid-statement.
- **Architecture validation remains pipeline-owned** — the native tool structures invocation and results but executes the configured validator; it does not duplicate or weaken that validator's rules.
- **Architecture validation is serialized** — calls write the configured report and merged-plan paths, so the tool is not concurrency-safe. It rejects a pre-existing report unless the validator refreshes it during the current call.
- **Package validation covers the shared cheap handoff only** — signed-inventory coherence, rubric semantics, verifier scoring, Harbor, and pipeline-specific gates remain owned by their pipeline stages.
