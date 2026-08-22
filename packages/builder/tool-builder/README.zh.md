# @deepseek-ai/dsh-tool-builder

[English](README.md) | 中文

面向构建器的模型工具，基于 `ctx.fs` 工作。该包检查合成任务包的低成本生成交接条件，并可在进程内解析离线 WARC 文件，无需模型编写 Python、安装 `warcio`、重复查找必需路径或解释校验器输出。

## 工具

当 `enableCorpusQuery` 为 true 时，`corpus_query` 接受一个 WARC 路径和一种操作。`list` 返回响应元数据，`search` 对响应 URL 和解码后的正文执行不区分大小写的纯文本扫描，`read` 返回一个精确 `WARC-Target-URI` 的解码正文。完整压缩归档通过文件系统服务读取，并受 `maxArchiveBytes` 限制；记录正文以增量方式消费，最多保留 `maxRecordChars` 个字符。搜索片段和精确读取分别受限。

`validate_builder_package` 检查固定构建器任务树中的常规非空文件，解析其中的 JSON 和 `task.toml`，并逐字节比较 `instruction.md` 与 `tests/instruction.md`。它在一次结果中报告所有发现的失败，不运行 Harbor、oracle、judge、Docker 或任务自带的校验器代码。

每个已启用的工具都会相对调用会话的工作区解析相对路径，将取消信号传递给文件系统操作，并为目标路径声明通用搜索式 UI 卡片。

## 配置

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `enableCorpusQuery` | `true` | 注册 `corpus_query` 及其 WARC 专用提示词指导。 |
| `maxArchiveBytes` | `268435456` | 单次查询接受的完整压缩 WARC 最大字节数。 |
| `maxFileBytes` | `16777216` | 校验时读取的任务文本文件最大字节数。 |
| `maxRecordChars` | `2000000` | 扫描单个响应正文时保留的解码字符数。 |
| `maxContentChars` | `12000` | 精确 URL 读取返回的解码字符数。 |
| `maxResults` | `20` | 查询默认返回的记录数；单次调用的 `limit` 不得超过 100。 |

每个数值都必须是正整数。`maxResults` 不得超过 100；无效配置会使插件加载失败。

## 模型体验

### 构建器提示指导

#### 模型看到的内容

构建器会收到一条由 `enableCorpusQuery` 选择的固定指令。

##### 启用语料查询的构建器工具指导

```markdown
Use corpus_query for WARC listing, search, and exact-URL reads instead of writing archive-parsing scripts. Use validate_builder_package once after the required task files are complete; repair only the named failures and rerun it only after a repair.
```

##### 未启用语料查询的构建器工具指导

```markdown
Use validate_builder_package once after the required task files are complete; repair only the named failures and rerun it only after a repair.
```

#### Token 影响

固定的校验指导和 schema 会加入使用该插件的每次请求。启用语料查询后还会加入 WARC 指导与 schema；结果受记录数量、片段大小、精确读取大小和固定校验项数量限制。

#### KV Cache 影响

提示和 schema 在插件生命周期内保持前缀稳定。工具调用及其有界结果追加到对话历史。

## 已知限制与延期工作

- **WARC 输入在硬限制内缓冲**：文件系统能力目前提供有界的整文件字节而非原始字节流，因此一次查询会在内存中持有不超过 `maxArchiveBytes` 的压缩归档。
- **HTML 转换刻意保持语法级**：查询会移除标签和常见实体，但不执行浏览器布局、JavaScript 或完整 HTML 实体解码。
- **校验仅覆盖共享的低成本交接**：签名清单一致性、rubric 语义、校验器评分、Harbor 和流水线专属检查仍由对应流水线阶段负责。
