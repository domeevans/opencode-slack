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

  test("every method is allowed under the default rules, and the reads under each restricted value", () => {
    const effect = (rules: Rule[]) => (tool: string) =>
      rules.findLast((rule) => rule.resource === "*" && new RegExp(`^${rule.action.replaceAll("*", ".*")}$`).test(`slack_${tool}`))?.effect
    const base: Rule = { action: "*", resource: "*", effect: "allow" }
    expect(METHODS.map((method) => [method.name, effect([base, ...defaultRules()])(method.name)]))
      .toEqual(METHODS.map((method) => [method.name, "allow"]))
    expect(METHODS.map((method) => [method.name, effect([base, ...defaultRules("ask-changes")])(method.name)]))
      .toEqual(METHODS.map((method) => [method.name, READS.includes(method.name) ? "allow" : "ask"]))
    expect(METHODS.map((method) => [method.name, effect([base, ...defaultRules("read-only")])(method.name)]))
      .toEqual(METHODS.map((method) => [method.name, READS.includes(method.name) ? "allow" : "deny"]))
  })

  test("returns Slack's results unchanged and leaves its arguments alone: the model path has no hook either way", () => {
    const result = { output: { messages: [] }, text: "text" }
    const call = { sessionID: "s", agent: "a", action: "slack_slack_read_channel" }
    expect(shapeInput("slack_read_channel", { channel_id: "C1" }, call)).toEqual({ channel_id: "C1" })
    expect(shapeResult("slack_read_channel", result, { ...call })).toBe(result)
  })

  test("has no per-account servers, and its next steps name Slack's own command and the location header", () => {
    expect(NEXT_STEPS.ACCOUNT_UNKNOWN).toBeUndefined()
    expect(NEXT_STEPS.AUTH_REQUIRED).toContain("Run /connect and choose Slack")
    for (const code of ["CONNECTION_FAILED", "NOT_REGISTERED", "TOOL_UNAVAILABLE", "UPSTREAM_ERROR"] as const) expect(NEXT_STEPS[code]).toContain("/slack-status")
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

  test("at the default access a write runs with no allow rule", async () => {
    const host = await setUp()
    expect(await host.script("slack_send_message", "ses_build", { channel_id: "C1", text: "hi" })).toMatchObject({ output: { tool: "slack_slack_send_message" } })
    expect(host.executed.map((call) => call.tool)).toEqual(["slack_slack_send_message"])
  })

  test("under ask-changes a write is refused before dispatch with no server call, and an allow rule opens it", async () => {
    const host = await setUp({
      options: { oauth: { client_id: "C1" }, access: "ask-changes" },
      sessions: { ses_allowed: { agent: "build", permissions: [allow("slack_send_message")] } },
    })
    const refused = await host.script("slack_send_message", "ses_build", { channel_id: "C1", text: "hi" })
    expect(refused).toMatchObject({ error: "failed", data: { code: "PERMISSION_DENIED" }, message: expect.stringContaining("would ask") })
    expect(host.executed).toEqual([])
    expect(await host.script("slack_send_message", "ses_allowed", { channel_id: "C1", text: "hi" })).toMatchObject({ output: { tool: "slack_slack_send_message" } })
    expect(host.executed.map((call) => call.tool)).toEqual(["slack_slack_send_message"])
  })

  test("the private search and the file read are reads-like methods, so ask-changes asks and read-only denies them", async () => {
    const asking = await setUp({ options: { oauth: { client_id: "C1" }, access: "ask-changes" } })
    for (const method of ["slack_search_public_and_private", "slack_read_file"]) {
      expect(await asking.script(method, "ses_build", {})).toMatchObject({ error: "failed", data: { code: "PERMISSION_DENIED" }, message: expect.stringContaining("would ask") })
    }
    expect(asking.executed).toEqual([])

    const denying = await setUp({ options: { oauth: { client_id: "C1" }, access: "read-only" } })
    for (const method of ["slack_search_public_and_private", "slack_read_file"]) {
      expect(await denying.script(method, "ses_build", {})).toMatchObject({ error: "failed", data: { code: "PERMISSION_DENIED" } })
    }
    expect(denying.executed).toEqual([])
  })

  test("describe lists every known tool with its class, and with a session its resolved permission", async () => {
    const host = await setUp()
    const described = (await host.script("describe", "")) as { methods: { name: string; class: string; permission?: string }[] }
    const expected = Object.fromEntries([...METHODS.map((method) => [method.name, method.class]), ["events_list", "read"], ["mark_read", "write"], ["status", "read"], ["mentions_list", "read"], ["dms_list", "read"]])
    expect(Object.fromEntries(described.methods.map((method) => [method.name, method.class]))).toEqual(expected)
    for (const method of described.methods) expect(Object.hasOwn(method, "permission")).toBe(false)
    const withSession = (await host.script("describe", "ses_build")) as { methods: { name: string; permission: string }[] }
    expect(Object.fromEntries(withSession.methods.map((method) => [method.name, method.permission]))).toEqual(Object.fromEntries([...METHODS.map((method) => [method.name, "allow"]), ["events_list", "allow"], ["mark_read", "allow"], ["status", "allow"], ["mentions_list", "allow"], ["dms_list", "allow"]]))

    const restricted = await setUp({ options: { oauth: { client_id: "C1" }, access: "ask-changes" } })
    const resolved = (await restricted.script("describe", "ses_build")) as { methods: { name: string; permission: string }[] }
    expect(Object.fromEntries(resolved.methods.map((method) => [method.name, method.permission])))
      .toEqual(Object.fromEntries([...METHODS.map((method) => [method.name, READS.includes(method.name) ? "allow" : "ask"]), ["events_list", "allow"], ["mark_read", "ask"], ["status", "allow"], ["mentions_list", "ask"], ["dms_list", "ask"]]))
  })

  test("has no method for an unknown tool", async () => {
    const host = await setUp()
    expect(Object.keys(host.rpcs.get(TOOLS_RPC_ID)!).sort()).toEqual(["describe", "events_list", "mark_read", "status", "mentions_list", "dms_list", ...METHODS.map((method) => method.name)].sort())
    expect(() => host.script(UNKNOWN, "ses_build")).toThrow(/no method/)
  })

  test("refuses with SERVER_CONFLICT while the user's own server holds the name, and never calls it", async () => {
    const host = await setUp({ servers: { slack: { type: "remote", url: "https://mcp.example.invalid/mcp" } as never } })
    expect(await host.script("slack_search_public", "ses_build", { query: "q" })).toMatchObject({ error: "failed", data: { code: "SERVER_CONFLICT" } })
    expect(host.executed).toEqual([])
    expect(NEXT_STEPS.SERVER_CONFLICT).toBe("Run /slack-status, then remove mcp.servers.slack from your OpenCode config.")
  })

  test("without a Slack app client ID, refuses with /slack-status's CLIENT_ID_MISSING and its next step, in calls and describe", async () => {
    const host = await setUp({ options: {}, tools: [] })
    const status = (await host.status()) as { code: string; nextStep: string }
    expect(status).toMatchObject({ code: "CLIENT_ID_MISSING", nextStep: "Run /connect and choose Slack app client ID, then paste your Slack app's client ID." })
    const refused = (await host.script("slack_search_public", "ses_build", { query: "q" })) as { message: string }
    expect(refused).toMatchObject({ error: "failed", data: { code: "CLIENT_ID_MISSING", next: status.nextStep } })
    expect(refused.message).toBe(`CLIENT_ID_MISSING: the "slack" server is not registered. Next step: ${status.nextStep}`)
    const described = (await host.script("describe", "")) as { methods: { available: boolean; reason?: string }[] }
    // status is the one method that still answers: it is what explains the missing client ID.
    expect(described.methods.map((method) => [method.available, method.reason])).toEqual([...METHODS.map(() => [false, "CLIENT_ID_MISSING"]), [false, "CLIENT_ID_MISSING"], [false, "CLIENT_ID_MISSING"], [true, undefined], [false, "CLIENT_ID_MISSING"], [false, "CLIENT_ID_MISSING"]])
    expect(await host.script("status", "ses_build", {})).toEqual(status)
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
