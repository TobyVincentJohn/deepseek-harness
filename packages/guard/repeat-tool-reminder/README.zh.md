# @deepseek-ai/dsh-repeat-tool-reminder

[English](README.md) | 中文

这是一个仅提供建议的循环中断器，而非面向模型的工具：它不会出现在工具列表中，不会否决或改写调用，而是监视每个 agent（智能体）的工具调用，识别重复的精确调用或已配置的碎片化根工具序列。达到所配置的连续次数时，它会注入逐级增强的提醒，要求模型改用其他方案、合并工作或结束任务。决定权仍完全属于模型：合理的重复调用既不会延迟，也不会受阻。原始精确匹配设计记录在 [repeat-tool-reminder Agent Note](../../../.agents/notes/archived/feature/2026-07-08-repeat-tool-guard.md) 中；忽略参数的根工具计数记录在 [Code Mode 操作指南 Agent Note](../../../.agents/notes/implemented/bug-fix/2026-08-22-code-mode-operational-guidance.zh.md) 中。

## 配置

```yaml
- id: repeat-tool-reminder
  name: '@deepseek-ai/dsh-repeat-tool-reminder'
  config:
    thresholds: [3, 5, 8]        # default; consecutive counts that trigger a reminder
    include: []                  # tool-name patterns to track; empty ⇒ all tools
    exclude: [todo_write]        # tool-name patterns transparent to the chain
    countByTool: [run_code, bash] # root tools counted by name regardless of arguments
    argumentsPreviewChars: 500   # default; cap on arguments quoted in the detailed reminder
```

插件加载时，`thresholds` 会对错误配置快速失败：空列表、非整数、小于 2 的值或重复值都会抛出错误，绝不静默回退到默认值；`argumentsPreviewChars` 同样只接受大于等于 1 的整数。系统会将列表按升序规范化；第一个阈值只发送简短的通用提醒，后续每个阈值都会发送详细版本，列出工具、连续次数和规范参数。参数内容截取前 `argumentsPreviewChars` 个字符，并附带省略字符数标记，避免循环中的 `write`／`edit` 载荷无限制进入下一次请求（链键始终比较完整的规范字符串；此上限只约束提醒，不影响检测）。

`include`、`exclude` 与 `countByTool` 条目支持 `*` 通配符，并针对调用时实际存在的工具执行谓词判断，而不是引用注册表条目。因此，与当前任何已注册工具都不匹配的模式并非错误（未加载 MCP 工具的部署中，`exclude: [mcp_*]` 仍然有效）；这与 `toolOrder` 的引用目标检查不同。`countByTool` 默认为 `[]`；基础 bundle 将其设为 `[run_code, bash]`，使不断变化的 wrapper 程序和 shell 探测命令都会收到合并提醒。

## 链语义

链键为「`(tool name, canonical arguments)`」：规范化过程会对键进行深度排序，然后执行 `JSON.stringify`，因此仅属性顺序不同的参数对象会视为相同。若某次调用与上一条受跟踪调用相同，该 agent 的连续计数器递增；换成另一条受跟踪调用则重置为 1。

匹配 `countByTool` 的根调用改用工具名作为键。其嵌套调用对根链透明，因此 `run_code` 内部的 Bash、read 或 grep 调用不会掩盖碎片化的外层程序序列。另一条受跟踪的根调用会重置根链。按工具名计数的提醒不包含参数，并要求模型合并已知的确定性工作。

- **不受跟踪的调用对链透明。** 被 `include`／`exclude` 排除的调用既不递增计数器，也不重置计数器；因此，`grep X → todo_write → grep X` 仍算作连续两次 `grep X`，即使 `todo_write` 已被排除。这正是排除机制的价值：循环中穿插的记录类工具不能掩盖循环。
- **被拒绝的调用也计数。** 检测位于 `tools/post-execute`；即便调用被 `tools/pre-execute` 监听器拒绝，该事件也会运行。模型反复尝试被拒绝的调用，恰恰是需要打断的循环。
- **忽略没有 agent 的调用。** 直接调用 `ctx.tools.execute()` 的调用方没有需要提醒的模型，也没有可作为键的活跃 agent 对象。
- **按 agent 分键。** 工具注册表位于上下文层级，subagent 会交错通过同一个 waterfall（瀑布式事件），因此每条链使用 `WeakMap<Agent, Chain>`，以活跃 agent 对象为键。一个 agent 的重复调用绝不会触发另一个 agent 的提醒。用户提示词（`agent/pre-step`）会重置提交该提示词的 agent 链；对象生命周期会自然限制弱引用条目的寿命，无需 dispose（资源释放）监听器。
- **仅驻留内存。** 从持久化恢复的会话会从一条全新的链开始：guard 是启发式提醒，并非有日志记录的不变量；提醒会延后，这是可接受的代价。

## 提醒传递

提醒通过 post-execute 决策中的 `additionalContexts`（来源为 `{kind: 'plugin', plugin: 'repeat-tool-reminder'}`）传递，绝不替换 `content`；用于审计的 `tool/result` 事件仍保留工具自己的输出。循环会缓冲这段上下文，并在该步骤的工具结果之后将其作为注入的 `user/message` 追加；会话会将它渲染为普通的合成用户消息。因此，提醒对模型可见、带有来源归属，并且无需增加会话事件即可从会话日志重建。guard 始终通过 `next()` 委派，并将自己的提醒放在下游决策的上下文数组之前（两种结果都适用：被阻止的调用也会收到提醒）；每个条目保留自己的来源和元数据。

## 模型体验

### 首个阈值的上下文消息

#### 模型看到的内容

达到第一个配置的连续重复阈值时，对应 agent 会收到以下提醒。系统不会添加工具 schema 或正常调用文本。

##### 首个阈值提醒

```markdown
You are repeating the exact same tool call with identical arguments. Carefully analyze the previous result before calling again: if the task is not complete, try a different approach or different arguments instead of repeating the call.
```

#### Token 影响

达到阈值前为零 token。提醒会作为该 agent 的历史记录保留。

#### KV Cache 影响

仅追加；新出现的内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 首个阈值的按工具名计数上下文消息

#### 模型看到的内容

达到第一个配置阈值时，`countByTool` 链会收到以下忽略参数的提醒。

##### 首个阈值的按工具名计数提醒

```markdown
You have called <toolName> <count> times consecutively. Before calling it again, consolidate all known remaining deterministic work into one call, or finish if enough evidence has been gathered.
```

#### Token 影响

达到阈值前为零 token。提醒会作为该 agent 的历史记录保留。

#### KV Cache 影响

仅追加；新出现的内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 后续阈值的上下文消息

#### 模型看到的内容

达到后续阈值时，agent 会收到以下详细提醒模板。受上限约束的参数预览严格以 `… (+<omitted> more chars)` 结尾。

##### 后续阈值提醒

```markdown
Repeated tool call detected:
- tool: <toolName>
- consecutive_calls: <count>
- arguments: <canonicalArguments>
The repeated calls are not making progress. Do not call this tool with these exact arguments again. Inspect the latest result and choose a different action, different arguments, or finish the task if enough evidence has been gathered.
```

#### Token 影响

每条提醒都会作为历史记录保留；`argumentsPreviewChars` 会限制精确匹配提醒中的参数文本，且各 agent 仍使用独立计数器。

#### KV Cache 影响

仅追加；新出现的内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 后续阈值的按工具名计数上下文消息

#### 模型看到的内容

达到后续 `countByTool` 阈值时，agent 会收到以下忽略参数的提醒模板。

##### 后续阈值的按工具名计数提醒

```markdown
Repeated tool sequence detected:
- tool: <toolName>
- consecutive_calls: <count>
The calls may use different arguments, but the sequence is still fragmented. Consolidate the remaining deterministic work into one call, choose a different approach, or finish if enough evidence has been gathered.
```

#### Token 影响

每条提醒都会作为历史记录保留且不携带参数文本；各 agent 仍使用独立计数器。

#### KV Cache 影响

仅追加；新出现的内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与暂缓事项

- **精确匹配仍是默认行为**：规范化过程会对键进行深度排序，因此近似变体可以绕过普通链。`countByTool` 仅有意扩展已配置的根工具；在没有需求证据前，不采用模糊匹配。
- **压缩（compaction）不会重置链**：跨越压缩检查点的链会继续计数。
- **仅提供建议**：尚未实现达到较高阈值后升级为 `block`，但 `PostToolDecision` 已支持阻止调用。
- **subagent 之间不共享链**：链始终按 agent 隔离；即使父 agent 与其 subagent 重复相同调用，也不会合并计数。
- **合理的幂等轮询超过阈值后仍会收到提醒**：可通过 `thresholds`／`exclude` 配置释放压力。
- **超过最高阈值后链不再提醒**：提醒只在精确达到所配置的次数时触发，超过后不会继续发送。
