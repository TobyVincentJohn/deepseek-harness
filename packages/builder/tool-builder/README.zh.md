# @deepseek-ai/dsh-tool-builder

[English](README.md) | 中文

面向构建器的模型工具，基于 `ctx.fs` 和 `ctx.shell` 工作。该包解析已打包的 WARC 文件、批量读取索引化架构语料、运行流水线自有的架构校验器，并检查合成任务包的低成本生成交接条件，无需模型构造脚本或校验命令。

## 工具

`corpus_query` 接受一个 WARC 路径和一种操作。`list` 返回响应元数据，`search` 对响应 URL 和解码后的正文执行不区分大小写的纯文本扫描，`read` 返回一个精确 `WARC-Target-URI` 的解码正文。完整压缩归档通过文件系统服务读取，并受 `maxArchiveBytes` 限制；记录正文以增量方式消费，最多保留 `maxRecordChars` 个字符。搜索片段和精确读取分别受限。

`architecture_corpus_query` 以只读方式打开冻结的 `search.sqlite` FTS5 索引，并在一次调用中接受多条搜索、精确的最终／请求 URL 和可选列表。每个结果都包含语料统计信息。单查询命中、片段、文档、列表行和完整渲染结果分别受可配置限制。

当 `ctx.shell` 可用时，`validate_architecture_candidate` 使用已配置的工作区相对输入、输出路径、语料目标、生成上限和预期 lane 来调用流水线自有的 Python 校验器。启动环境可以配置脚本和 Python 路径，调用也可以显式提供。调用还可以覆盖预期 lane 或提供修复反馈。工具读取校验器的 JSON 报告，以有界诊断返回报告，并将合并计划和精确报告保留在配置路径中。如果子进程在刷新报告前失败，其有界 stdout 和 stderr 会保留在工具错误中。

`validate_builder_package` 检查固定构建器任务树中的常规非空文件，解析其中的 JSON 和 `task.toml`，并逐字节比较 `instruction.md` 与 `tests/instruction.md`。它在一次结果中报告所有发现的失败，不运行 Harbor、oracle、judge、Docker 或任务自带的校验器代码。

所有工具都会相对调用会话的工作区解析相对路径，并为目标路径声明通用搜索式 UI 卡片。索引化 SQLite 语句同步执行，在批次前后检查取消；校验器通过 `ctx.shell` 传递取消。

## 配置

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `maxArchiveBytes` | `268435456` | 单次查询接受的完整压缩 WARC 最大字节数。 |
| `maxFileBytes` | `16777216` | 校验时读取的任务文本文件最大字节数。 |
| `maxRecordChars` | `2000000` | 扫描单个响应正文时保留的解码字符数。 |
| `maxContentChars` | `12000` | 精确 URL 读取返回的解码字符数。 |
| `maxResults` | `20` | 查询默认返回的记录数；单次调用的 `limit` 不得超过 100。 |
| `maxIndexedQueries` / `maxIndexedUrls` | `20` / `40` | 单次架构调用接受的唯一 FTS 查询和精确 URL 数量。 |
| `maxIndexedListResults` / `maxIndexedResultsPerQuery` | `100` / `8` | 列表和单查询命中上限。 |
| `maxIndexedSnippetChars` / `maxIndexedDocumentChars` | `600` / `4000` | 每个 FTS 命中和精确文档保留的文本字符数。 |
| `maxIndexedOutputChars` | `12000` | 面向模型的完整架构语料结果上限。 |
| `architectureValidatorScript` / `pythonExecutable` | 未设置 | 启动时配置的命令路径；每次调用可补充缺失值。 |
| `architectureBaseSourcesPath` / `architectureSeedPath` | `task-planning/base_sources.json` / `task-planning/architecture-seed.json` | 相对架构工作区的校验器输入路径。 |
| `architectureReportPath` / `architectureMergedPlanPath` | `task-planning/architecture-validation.json` / `task-planning/architecture-merged-plan.json` | 相对架构工作区的校验器输出路径。 |
| `architecturePreloadedDir` | `task-planning/lake-cache` | 传给校验器的冻结索引语料目录。 |
| `architectureExpectedLaneId` | `architecture-01` | 传给校验器的预期 lane 标识符；调用可以覆盖它。 |
| `architectureSourceCap` / `architectureEvidenceCap` | `520` / `110` | 传给校验器的来源和架构证据上限。 |
| `architectureTargetSites` / `architectureTargetDocuments` / `architectureMaxDocuments` | `150` / `300` / `300` | 传给校验器的语料规模目标。 |
| `architectureTargetTokens` / `architectureStorageBudgetBytes` | `4500000` / `1800000000` | 传给校验器的 token 和存储目标。 |
| `architectureAdversarialSiteMin` / `architectureStrictAdversarialSiteMin` | `45` / `16` | 传给校验器的对抗网站最小值。 |
| `architectureValidatorTimeoutMs` | `120000` | 校验器子进程超时。 |
| `maxArchitectureValidationOutputChars` | `12000` | 面向模型的完整校验结果上限。 |

每个数值限制都必须是正整数。`architectureExpectedLaneId` 必须非空，且 `maxResults` 不得超过 100；无效配置会使插件加载失败。

## 模型体验

### 构建器提示指导

#### 模型看到的内容

构建器始终会收到一条固定指令，将已打包归档、索引化架构语料和最终交接检查导向原生工具。当 `ctx.shell` 可用时，它还会收到第二条架构校验指令。

##### 构建器工具指导

```markdown
Use corpus_query for WARC listing, search, and exact-URL reads. For architecture work, batch FTS searches and exact reads through architecture_corpus_query. Use validate_builder_package once after final task-package files are complete. Repair only named validation failures and rerun only after a repair.

Run validate_architecture_candidate after the architecture candidate is complete. Repair only named validation failures and rerun only after a repair.
```

#### Token 影响

固定指导和三个始终启用的 schema 会加入使用该插件的每次请求。只有 `ctx.shell` 可用时，校验器指导和第四个 schema 才会加入请求。除条目数和单文档限制外，语料和校验结果还有完整的面向模型字符上限。

#### KV Cache 影响

提示和 schema 在插件生命周期内保持前缀稳定。工具调用及其有界结果追加到对话历史。

## 已知限制与延期工作

- **WARC 输入在硬限制内缓冲**：文件系统能力目前提供有界的整文件字节而非原始字节流，因此一次查询会在内存中持有不超过 `maxArchiveBytes` 的压缩归档。
- **HTML 转换刻意保持语法级**：查询会移除标签和常见实体，但不执行浏览器布局、JavaScript 或完整 HTML 实体解码。
- **索引查询要求流水线 schema**：`architecture_corpus_query` 接受离线搜索架构阶段生成的 FTS5 `documents(url, requested_url, title, media_type, text)` 表；它不会迁移或修复索引。
- **SQLite 同步执行**：一个 FTS 语句会阻塞 agent 进程直到 SQLite 返回，且不能在语句执行中中断。
- **架构校验仍归流水线所有**：原生工具负责结构化调用和结果，但执行配置的校验器；它不会复制或弱化校验规则。
- **架构校验会串行执行**：调用会写入已配置的报告和合并计划路径，因此该工具不具备并发安全性。如果校验器没有在当前调用中刷新已有报告，工具会拒绝该报告。
- **任务包校验仅覆盖共享的低成本交接**：签名清单一致性、rubric 语义、校验器评分、Harbor 和流水线专属检查仍由对应流水线阶段负责。
