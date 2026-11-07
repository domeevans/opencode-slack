// Slack's part of the tools RPC v2: the plugin-specific block of src/host/tools-rpc.ts, and how setup registers it.
// The shared part is tested in tools-rpc.test.ts; the resolve matrix in resolve.test.ts.
import { afterEach, describe, expect, test } from "bun:test"
import { CLASSES, METHODS, NEXT_STEPS, shapeInput, shapeResult, TOOLS_RPC_ID } from "../../src/host/tools-rpc.js"
import plugin from "../../src/index.js"
import { defaultRules, type Rule } from "../../src/permissions.js"
import { classify, KNOWN_TOOLS, READ_TOOLS, SEND_TOOLS } from "../../src/tools.js"
import { FAKE_TOOLS } from "../host/fake-slack-mcp.js"
import { fakeHost, type FakeHostInput, type FakeSession } from "./fakes.js"

const READS = [
  "slack_search_public", "slack_search_channels", "slack_search_users", "slack_read_channel", "slack_read_thread",
  "slack_read_user_profile", "slack_read_canvas", "slack_list_channel_members", "slack_get_reactions",
  "slack_list_user_channels", "slack_read_list", "slack_search_emojis",
]
const ASKING_READS = ["slack_search_public_and_private", "slack_read_file"]
const WRITES = [
  "slack_create_canvas", "slack_update_canvas", "slack_add_reaction", "slack_get_file_upload_url",
  "slack_complete_file_upload", "slack_create_conversation", "slack_create_list", "slack_update_list",
  "slack_add_list_record", "slack_update_list_record",
]
const SENDS = ["slack_send_message", "slack_send_message_draft", "slack_schedule_message"]
const UNKNOWN = "slack_brand_new_tool"

describe("Slack's tools RPC", () => {
  test("is slack.workspace.tools, with every known tool a method, by exact name and with its class", () => {
    expect(TOOLS_RPC_ID).toBe("slack.workspace.tools")
    expect(METHODS.map((method) => method.name)).toEqual(Object.keys(KNOWN_TOOLS))
    expect(METHODS.map((method) => method.class).filter((class_) => class_ === "read")).toHaveLength(14)
    expect(METHODS.filter((method) => method.class === "read").map((method) => method.name)).toEqual([...READS, ...ASKING_READS])
    expect(METHODS.filter((method) => method.class === "write").map((method) => method.name)).toEqual(WRITES)
    expect(METHODS.filter((method) => method.class === "send").map((method) => method.name)).toEqual([...SENDS])
    for (const method of METHODS) expect(CLASSES).toContain(method.class)
    expect(READS).toEqual([...READ_TOOLS])
    expect(SENDS).toEqual([...SEND_TOOLS])
  })

  test("a tool Slack adds later is not a method, and no class is outside the five", () => {
    expect(METHODS.some((method) => method.name === UNKNOWN)).toBe(false)
    expect(classify(UNKNOWN)).toBe("unknown")
    expect(classify("slack_send_message")).toBe("write")
  })

  test("the private search, the file read and the writes ask under the default rules, so a script needs an allow rule", () => {
    const rules: Rule[] = [{ action: "*", resource: "*", effect: "allow" }, ...defaultRules()]
    const effect = (tool: string) => rules.findLast((rule) => new RegExp(`^${rule.action.replaceAll("*", ".*")}$`).test(`slack_${tool}`))?.effect
    expect(METHODS.map((method) => [method.name, effect(method.name)])).toEqual(METHODS.map((method) => [method.name, READS.includes(method.name) ? "allow" : "ask"]))
  })

  test("returns Slack's results unchanged and leaves its arguments alone: the model path has no hook either way", () => {
    const result = { output: { messages: [] }, text: "text" }
    const call = { sessionID: "s", agent: "a", action: "slack_slack_read_channel" }
    expect(shapeInput("slack_read_channel", { channel_id: "C1" }, call)).toEqual({ channel_id: "C1" })
    expect(shapeResult("slack_read_channel", result, { ...call })).toBe(result)
  })

  test("has no per-account servers, and its next steps name Slack's own command and the location header", () => {
    expect(NEXT_STEPS.ACCOUNT_UNKNOWN).toBeUndefined()
    for (const code of ["AUTH_REQUIRED", "CONNECTION_FAILED", "NOT_REGISTERED", "TOOL_UNAVAILABLE", "UPSTREAM_ERROR"] as const) expect(NEXT_STEPS[code]).toContain("/slack-status")
    expect(NEXT_STEPS.SESSION_UNKNOWN).toContain("x-opencode-directory")
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

const allow = (tool: string): Rule => ({ action: `slack_${tool}`, resource: "*", effect: "allow" })

describe("the tools RPC in setup", () => {
  test("runs a read on the plugin's server as the session's agent", async () => {
    const host = await setUp()
    expect(await host.script("slack_read_channel", "ses_build", { channel_id: "C1" })).toEqual({ output: { tool: "slack_slack_read_channel" }, text: "ran slack_slack_read_channel" })
    expect(host.executed).toEqual([{ tool: "slack_slack_read_channel", input: { channel_id: "C1" } }])
  })

  test("a write is a method: refused before dispatch without an allow, and it runs with one", async () => {
    const host = await setUp({ sessions: { ses_allowed: { agent: "build", permissions: [allow("slack_send_message")] } } })
    const refused = await host.script("slack_send_message", "ses_build", { channel_id: "C1", text: "hi" })
    expect(refused).toMatchObject({ error: "failed", data: { code: "PERMISSION_DENIED" }, message: expect.stringContaining("would ask") })
    expect(host.executed).toEqual([])
    expect(await host.script("slack_send_message", "ses_allowed", { channel_id: "C1", text: "hi" })).toMatchObject({ output: { tool: "slack_slack_send_message" } })
    expect(host.executed.map((call) => call.tool)).toEqual(["slack_slack_send_message"])
  })

  test("refuses the private search and the file read under the default rules, at once, and runs them with an allow rule", async () => {
    const host = await setUp({ sessions: { ses_allowed: { agent: "build", permissions: [allow("slack_search_public_and_private"), allow("slack_read_file")] } } })
    for (const method of ["slack_search_public_and_private", "slack_read_file"]) {
      const refused = await host.script(method, "ses_build", {})
      expect(refused).toMatchObject({ error: "failed", data: { code: "PERMISSION_DENIED" }, message: expect.stringContaining("would ask") })
      expect(await host.script(method, "ses_allowed", {})).toMatchObject({ output: { tool: `slack_${method}` } })
    }
    expect(host.executed.map((call) => call.tool)).toEqual(["slack_slack_search_public_and_private", "slack_slack_read_file"])
  })

  test("describe lists every known tool with its class, and with a session its resolved permission", async () => {
    const host = await setUp()
    const described = (await host.script("describe", "")) as { methods: { name: string; class: string; permission?: string }[] }
    const expected = Object.fromEntries(METHODS.map((method) => [method.name, method.class]))
    expect(Object.fromEntries(described.methods.map((method) => [method.name, method.class]))).toEqual(expected)
    for (const method of described.methods) expect(Object.hasOwn(method, "permission")).toBe(false)
    const withSession = (await host.script("describe", "ses_build")) as { methods: { name: string; permission: string }[] }
    expect(Object.fromEntries(withSession.methods.map((method) => [method.name, method.permission]))).toEqual(Object.fromEntries(METHODS.map((method) => [method.name, READS.includes(method.name) ? "allow" : "ask"])))
  })

  test("has no method for an unknown tool", async () => {
    const host = await setUp()
    expect(Object.keys(host.rpcs.get(TOOLS_RPC_ID)!).sort()).toEqual(["describe", ...METHODS.map((method) => method.name)].sort())
    expect(() => host.script(UNKNOWN, "ses_build")).toThrow(/no method/)
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
    expect(described.methods.map((method) => [method.available, method.reason])).toEqual(METHODS.map(() => [false, "CLIENT_ID_MISSING"]))
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
