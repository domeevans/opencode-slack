// Slack's part of the tools RPC: the plugin-specific block of src/host/tools-rpc.ts, and how setup registers it. The
// shared part is tested in tools-rpc.test.ts.
import { afterEach, describe, expect, test } from "bun:test"
import { KNOWN_READS, NEXT_STEPS, shapeResult, TOOLS_RPC_ID } from "../../src/host/tools-rpc.js"
import plugin from "../../src/index.js"
import { defaultRules, type Rule } from "../../src/permissions.js"
import { classify, READ_TOOLS } from "../../src/tools.js"
import { FAKE_TOOLS } from "../host/fake-slack-mcp.js"
import { fakeHost, type FakeHostInput, type FakeSession } from "./fakes.js"

const READS = [
  "slack_search_public", "slack_search_channels", "slack_search_users", "slack_read_channel", "slack_read_thread",
  "slack_read_user_profile", "slack_read_canvas", "slack_list_channel_members", "slack_get_reactions",
  "slack_list_user_channels", "slack_read_list", "slack_search_emojis",
]
const WRITES = [
  "slack_send_message", "slack_send_message_draft", "slack_schedule_message", "slack_create_canvas", "slack_update_canvas",
  "slack_add_reaction", "slack_get_file_upload_url", "slack_complete_file_upload", "slack_create_conversation",
  "slack_create_list", "slack_update_list", "slack_add_list_record", "slack_update_list_record",
]
const UNKNOWN = "slack_brand_new_tool"

describe("Slack's tools RPC", () => {
  test("is slack.workspace.tools, with the twelve reads, the private search and the file read as methods", () => {
    expect(TOOLS_RPC_ID).toBe("slack.workspace.tools")
    expect([...KNOWN_READS]).toEqual([...READS, "slack_search_public_and_private", "slack_read_file"])
    expect(READS).toEqual([...READ_TOOLS])
  })

  test("no write, send or unknown tool is a method, and every known tool that only reads is", () => {
    expect(WRITES.map(classify)).toEqual(WRITES.map(() => "write"))
    for (const tool of [...WRITES, UNKNOWN]) expect({ tool, method: KNOWN_READS.includes(tool) }).toEqual({ tool, method: false })
    // The fake server lists every known tool and one unknown: exactly the non-writes are methods.
    expect(FAKE_TOOLS.filter((tool) => KNOWN_READS.includes(tool))).toEqual(FAKE_TOOLS.filter((tool) => !["write", "unknown"].includes(classify(tool))))
    expect(FAKE_TOOLS).toEqual(expect.arrayContaining([...KNOWN_READS, ...WRITES, UNKNOWN]))
  })

  test("the private search and the file read ask under the default rules, so a script needs an allow rule for them", () => {
    const rules: Rule[] = [{ action: "*", resource: "*", effect: "allow" }, ...defaultRules()]
    const effect = (tool: string) => rules.findLast((rule) => new RegExp(`^${rule.action.replaceAll("*", ".*")}$`).test(`slack_${tool}`))?.effect
    expect(KNOWN_READS.map((tool) => [tool, effect(tool)])).toEqual(KNOWN_READS.map((tool) => [tool, READS.includes(tool) ? "allow" : "ask"]))
  })

  test("returns Slack's results unchanged: the model path has no hook that changes them", () => {
    const result = { output: { messages: [] }, text: "text" }
    expect(shapeResult("slack_read_channel", result)).toBe(result)
  })

  test("has no per-account servers, and its next steps name Slack's own command", () => {
    expect(NEXT_STEPS.ACCOUNT_UNKNOWN).toBeUndefined()
    for (const code of ["AUTH_REQUIRED", "CONNECTION_FAILED", "NOT_REGISTERED", "TOOL_UNAVAILABLE", "UPSTREAM_ERROR"] as const) expect(NEXT_STEPS[code]).toContain("/slack-status")
  })
})

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

type Evaluation = { action: string; effect: string; message?: string; source?: { type: "tool"; messageID: string; id: string } }

/**
 * Sets the plugin up on a fake host whose server lists every fake tool, each with an executor that checks the
 * agent's and the session's rules and runs the evaluate hooks, as OpenCode's does.
 */
async function setUp(input: FakeHostInput = {}) {
  const server = "slack"
  const executed: { tool: string; input: unknown }[] = []
  const sessions: Record<string, FakeSession> = { ses_build: { agent: "build" }, ...input.sessions }
  const host = fakeHost({
    options: { oauth: { client_id: "C1" } },
    status: { [server]: { status: "connected" } },
    ...input,
    sessions,
    tools: input.tools ?? FAKE_TOOLS.map((name) => {
      const id = `${server}_${name}`
      return {
        id,
        name,
        options: { namespace: server },
        input: { type: "object", properties: {} },
        execute: async (toolInput: unknown, call: { sessionID: string; agent: string; id: string }) => {
          const rules = [...(host.agents.find((agent) => agent.id === call.agent)?.permissions ?? []), ...(sessions[call.sessionID]?.permissions ?? [])]
          const effect = rules.findLast((rule) => new RegExp(`^${rule.action.replaceAll("*", ".*")}$`).test(id) && rule.resource === "*")?.effect ?? "ask"
          const evaluation: Evaluation = { action: id, effect, source: { type: "tool", messageID: "msg_script", id: call.id } }
          for (const hook of host.hooks) (hook as (event: Evaluation) => void)(evaluation)
          if (evaluation.effect !== "allow")
            throw Object.assign(new Error(evaluation.message ?? `Permission denied: ${id}`), { _tag: "Tool.Error", error: new Error(evaluation.effect) })
          executed.push({ tool: id, input: toolInput })
          return { output: { tool: id }, content: [{ type: "text", text: `ran ${id}` }] }
        },
      }
    }),
  })
  const cleanup = await plugin.setup(host.ctx)
  cleanups.push(async () => void (await cleanup?.()))
  return { ...host, executed, cleanup: async () => void (await cleanup?.()) }
}

describe("the tools RPC in setup", () => {
  test("runs a read on the plugin's server as the session's agent", async () => {
    const host = await setUp()
    expect(await host.script("slack_read_channel", "ses_build", { channel_id: "C1" })).toEqual({ output: { tool: "slack_slack_read_channel" }, text: "ran slack_slack_read_channel" })
    expect(host.executed).toEqual([{ tool: "slack_slack_read_channel", input: { channel_id: "C1" } }])
  })

  test("refuses the private search and the file read under the default rules, at once, and runs them with an allow rule", async () => {
    const allow = (tool: string): Rule => ({ action: `slack_${tool}`, resource: "*", effect: "allow" })
    const host = await setUp({ sessions: { ses_allowed: { agent: "build", permissions: [allow("slack_search_public_and_private"), allow("slack_read_file")] } } })
    for (const method of ["slack_search_public_and_private", "slack_read_file"]) {
      expect(await host.script(method, "ses_build", {})).toMatchObject({ error: "failed", data: { code: "PERMISSION_DENIED" }, message: expect.stringContaining("cannot answer an approval prompt") })
      expect(await host.script(method, "ses_allowed", {})).toMatchObject({ output: { tool: `slack_${method}` } })
    }
    expect(host.executed.map((call) => call.tool)).toEqual(["slack_slack_search_public_and_private", "slack_slack_read_file"])
  })

  test("has no method for a write, a send or an unknown tool, and one owned method, events_list", async () => {
    const host = await setUp()
    const methods = Object.keys(host.rpcs.get(TOOLS_RPC_ID)!)
    expect(methods.sort()).toEqual(["describe", "events_list", ...KNOWN_READS].sort())
    for (const tool of [...WRITES, UNKNOWN]) expect(() => host.script(tool, "ses_build")).toThrow(/no method/)
  })

  test("refuses with SERVER_CONFLICT while the user's own server holds the name, and never calls it", async () => {
    const host = await setUp({ servers: { slack: { type: "remote", url: "https://mcp.example.invalid/mcp" } as never } })
    expect(await host.script("slack_search_public", "ses_build", { query: "q" })).toMatchObject({ error: "failed", data: { code: "SERVER_CONFLICT" } })
    expect(host.executed).toEqual([])
    expect(NEXT_STEPS.SERVER_CONFLICT).toBe("Remove mcp.servers.slack from your OpenCode config.")
  })

  test("without a Slack app client ID, refuses with /slack-status's CLIENT_ID_MISSING and its next step, in calls and describe", async () => {
    const host = await setUp({ options: {}, tools: [] })
    const status = (await host.status()) as { code: string; nextStep: string }
    expect(status).toMatchObject({ code: "CLIENT_ID_MISSING", nextStep: "Run /connect and choose Slack app client ID, then paste your Slack app's client ID." })
    const refused = (await host.script("slack_search_public", "ses_build", { query: "q" })) as { message: string }
    expect(refused).toMatchObject({ error: "failed", data: { code: "CLIENT_ID_MISSING", next: status.nextStep } })
    expect(refused.message).toBe(`CLIENT_ID_MISSING: the "slack" server is not registered. Next step: ${status.nextStep}`)
    const described = (await host.script("describe", "")) as { methods: { available: boolean; reason?: string }[] }
    expect(described.methods.map((method) => [method.available, method.reason])).toEqual([...KNOWN_READS, "events_list"].map(() => [false, "CLIENT_ID_MISSING"]))
    expect(host.executed).toEqual([])
  })

  test("with a client ID in /connect that is empty or has spaces, refuses with CLIENT_ID_INVALID and the same next step", async () => {
    const host = await setUp({ options: {}, tools: [], credentials: { "slack-app": { type: "key", key: "C2 C3" } } })
    const status = (await host.status()) as { code: string; nextStep: string }
    expect(status.code).toBe("CLIENT_ID_INVALID")
    expect(await host.script("slack_search_public", "ses_build", { query: "q" })).toMatchObject({ error: "failed", data: { code: "CLIENT_ID_INVALID", next: status.nextStep } })
  })

  test("is disposed with its hook by the plugin's cleanup", async () => {
    const host = await setUp()
    expect(host.hooks.size).toBe(1)
    await host.cleanup()
    expect(host.hooks.size).toBe(0)
    expect(host.rpcs.has(TOOLS_RPC_ID)).toBe(false)
  })
})
