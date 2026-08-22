# @deepseek-ai/dsh-compaction-tool-result-pruner

[English](README.md) | 中文

可安全回放、不依赖模型的剪枝服务（`ctx.toolResultPruner`）。它会改写超出预算的 `tool/result` 文本与 assistant 工具调用参数字符串，同时在仅追加会话日志中保留每个完整原始事件。

这是 [`dsh-compaction-basic`](../compaction-basic/README.zh.md) 的具体配套服务，不是压缩（compaction）后端或面向模型的工具。Compact-basic 通过可选的 `ctx.get('toolResultPruner')` 读取它，因此这两个包仍可各自独立组合。

## 服务 API

`pruneSession(session)` 会扫描当前表层的一个稳定快照。每个超出预算的工具结果会由一个新追加的 `tool/result` 替换；包含超大工具调用参数的 assistant 消息会由一个新追加的 `assistant/message` 替换。每个替换只指向其原始节点，并通过 `sourceEventSeqs` 引用该节点。原始事件仍可用于持久化、回放和精确日志检查。

超过 `inputThresholdChars` 的工具调用参数会变成有效 JSON，其中包含原始 Unicode 码点数、SHA-256 摘要，以及由 `[... tool input middle pruned ...]` 分隔的有界头尾预览。工具名与调用 id 保持不变，因此保留的结果仍与有界历史调用配对。`prunedInputs` 会报告每个 assistant 替换及其受影响的调用 id。

当会话拒绝替换时，该方法会同步抛出异常。本次扫描中先前已提交的替换仍会保留。

`measureContent(blocks)` 会统计 `text` 块中的 Unicode 码点。`pruneContent(blocks)` 会返回长度受限的替换；如果内容已在阈值内，则返回 `null`。非文本块保持原始相对位置；文本切片绝不会拆分 UTF-16 代理项对，但可能拆分由多个码点组成的字素簇。

每个发出的结果在文本码点上都精确包含已配置的头部预算、固定标记和尾部预算，不大于 `thresholdChars`，且严格小于触发输入。因此第二次扫描不会发出替换。

## 配置

无法识别的配置键会使插件在构造时失败。已解析配置与输入脱离，并且深度不可变。

| 配置键 | 必填 | 含义 |
|---|---|---|
| `thresholdChars` | 否（默认 `8192`） | 合并文本超过此 Unicode 码点数时剪枝。 |
| `headChars` | 否（默认 `4096`） | 保留的开头 Unicode 码点数。 |
| `tailChars` | 否（默认 `1024`） | 保留的末尾 Unicode 码点数。 |
| `inputThresholdChars` | 否（默认 `8192`） | 工具调用参数字符串超过此 Unicode 码点数时替换。 |
| `inputPreviewChars` | 否（默认 `512`） | 替换的头尾预览合计保留的参数 Unicode 码点数。 |

所有值都必须是整数；阈值必须为正数，保留值必须为非负数。每个配置的替换都必须小于触发它的阈值，因此剪枝不会增大节点，第二次扫描也不会再次替换。

## 用法

```ts
import type { Context } from '@deepseek-ai/cordis'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'

export function apply(ctx: Context): void {
  ctx.plugin(ToolResultPruner)
}
```

## 模型体验

### 已剪枝的工具结果

#### 模型看到的内容

一旦满足压缩触发条件，后续请求看到的将是保留的结果头尾，以及替代超大工具调用参数的有界、带摘要 JSON。富结果块与工具调用 id 保持顺序。模型不会看到任一原文的第二份副本。

#### Token 影响

每个已改写工具结果最多包含 `thresholdChars` 个文本码点，每个已改写工具输入都小于触发它的参数字符串。剪枝本身不会发起模型调用；重新测量的请求低于压力阈值时，compaction-basic 会跳过摘要，否则摘要器会读取已剪枝的表层。

#### KV Cache 影响

替换较早的结果会使从第一个改变的 token 起的复用失效。当其路由、envelope 与之前的历史保持一致时，已剪枝前缀可以复用。

## 已知限制与暂缓事项

- **字符预算不是 token 预算**：不同提供方的 token 密度各异，因此 `ctx.tokenMeter` 仍负责判定剪枝是否缓解了请求压力。
- **剪枝只基于语法**：它保留开头与结尾，不解释中间哪些行在语义上重要。
- **字素簇可能被拆分**：按码点切片可保护代理项对，但不会执行感知区域设置的字素簇分割。
