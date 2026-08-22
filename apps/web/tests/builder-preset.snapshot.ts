import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { assertFixtureInventory, launchWebScaffold, type WebScaffold } from './scaffold.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/builder-preset', import.meta.url))
const FIXTURE = fileURLToPath(new URL('./snapshots/builder-preset/session.jsonl', import.meta.url))
const PROMPT = 'Reply exactly BUILDER_PRESET_REQUEST_OK and stop.'

describe('builder agent preset', () => {
  let scaffold: WebScaffold
  let agentHandle: AgentHandle

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ replayFixture: FIXTURE })
    agentHandle = await scaffold.ctx.agents.create({
      sessionId: SessionId('builder-preset-smoke'),
      meta: { cwd: scaffold.workspaceCwd, agentPreset: 'builder' },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      setup: agentCtx => scaffold.ctx.agentPresets.mount(agentCtx, 'builder').then(() => undefined),
    })
  })

  afterAll(async () => {
    const failures: unknown[] = []
    await agentHandle?.dispose().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'builder preset smoke teardown failed')
  })

  it('sends only the focused builder tool set and its corpus guidance', async () => {
    agentHandle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: PROMPT }],
      source: { kind: 'user' },
    }))
    await agentHandle.agent.whenIdle()

    const requestHeader = agentHandle.agent.session.requestHeader()
    if (requestHeader === undefined) throw new Error('the builder agent issued no model request')
    expect(requestHeader.system).toContain('Use corpus_query for WARC listing')
    expect(requestHeader.system).not.toContain('web_search')
    expect(requestHeader.tools?.map(tool => tool.name)).toMatchInlineSnapshot(`
      [
        "bash",
        "corpus_query",
        "edit",
        "glob",
        "grep",
        "job_kill",
        "job_list",
        "job_output",
        "read",
        "read_image",
        "validate_builder_package",
        "write",
      ]
    `)
    expect(scaffold.ctx.agentPresets.serviceFor(agentHandle.agent, 'compaction')).toBeDefined()
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.jsonl'])
  })
})
