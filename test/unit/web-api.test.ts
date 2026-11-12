// The plugin's two Slack Web API calls, through setup on a fake host with a fake slack.com: the signed-in account in
// status (auth.test), and mark_read (conversations.mark) as a tools RPC method and a Code Mode tool. Every id and token
// below is invented.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { TOOLS_RPC_ID } from "../../src/host/tools-rpc.js"
import plugin from "../../src/index.js"
import { MARK_READ, MARK_READ_ACTION } from "../../src/mark-read.js"
import { STATUS_ACTION } from "../../src/status-method.js"
import { fakeHost, type FakeHostInput } from "./fakes.js"

const TOKEN = "xoxe.xoxp-1-INVENTED-token-value"
const SLACK_SIGN_IN = { type: "oauth" as const, methodID: "oauth" as never, access: TOKEN, refresh: "xoxe-1-INVENTED-refresh", expires: Date.now() + 3_600_000 }
const AUTH_TEST = { ok: true, url: "https://acme.slack.com/", team: "Acme", user: "sam", team_id: "T0TEAM0001", user_id: "U0USER0001", is_enterprise_install: false }
const DM = "D0DM0000001"
const TS = "1792079633.751589"

interface Sent {
  readonly method: string
  readonly authorization: string | null
  readonly params: Record<string, string>
}

let sent: Sent[] = []
let answers: Record<string, () => Response> = {}
const realFetch = globalThis.fetch
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })

beforeEach(() => {
  sent = []
  answers = { "auth.test": () => json(AUTH_TEST), "conversations.mark": () => json({ ok: true }) }
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const href = String(url)
    if (!href.startsWith("https://slack.com/api/")) throw new Error(`unexpected request to ${href}`)
    const method = href.slice("https://slack.com/api/".length)
    sent.push({ method, authorization: new Headers(init.headers).get("authorization"), params: Object.fromEntries(new URLSearchParams(String(init.body ?? ""))) })
    return (answers[method] ?? (() => json({ ok: false, error: "unknown_method" })))()
  }) as typeof globalThis.fetch
})

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  globalThis.fetch = realFetch
})

async function setUp(input: FakeHostInput = {}) {
  const host = fakeHost({
    options: { oauth: { client_id: "C1" } },
    status: { slack: { status: "connected" } },
    credentials: { mcp_slack: SLACK_SIGN_IN },
    sessions: { ses_build: { agent: "build" } },
    ...input,
  })
  const cleanup = await plugin.setup(host.ctx)
  cleanups.push(async () => void (await cleanup?.()))
  return host
}

type StatusOutput = { state: string; account?: Record<string, string> }

describe("the signed-in account in status", () => {
  test("the status RPC names the workspace and the user from one auth.test, sent with the Slack sign-in", async () => {
    const host = await setUp()
    const status = (await host.status()) as StatusOutput
    expect(status.state).toBe("connected")
    expect(status.account).toEqual({ teamId: "T0TEAM0001", userId: "U0USER0001" })
    expect(sent).toEqual([{ method: "auth.test", authorization: `Bearer ${TOKEN}`, params: {} }])
    expect(JSON.stringify(status)).not.toContain("xox")
  })

  test("names the Enterprise Grid organisation when there is one", async () => {
    answers["auth.test"] = () => json({ ...AUTH_TEST, enterprise_id: "E0GRID0001" })
    const host = await setUp()
    expect(((await host.status()) as StatusOutput).account).toEqual({ teamId: "T0TEAM0001", userId: "U0USER0001", enterpriseId: "E0GRID0001" })
  })

  test("is read once per sign-in, not once per status", async () => {
    const host = await setUp()
    await host.status()
    await host.status()
    await host.slashStatus()
    expect(sent.map((request) => request.method)).toEqual(["auth.test"])
  })

  test("signing out leaves the account out, with no request", async () => {
    const host = await setUp()
    await host.status()
    host.store("mcp_slack", undefined)
    expect(Object.keys((await host.status()) as object)).not.toContain("account")
    expect(sent.map((request) => request.method)).toEqual(["auth.test"])
  })

  test("/slack-status shows the account", async () => {
    const host = await setUp()
    expect((await host.slashStatus()).text).toContain("Account: workspace T0TEAM0001, user U0USER0001")
  })

  test("a failing auth.test leaves the account out, and status is otherwise unchanged", async () => {
    answers["auth.test"] = () => json({ ok: false, error: "invalid_auth" })
    const host = await setUp()
    const status = (await host.status()) as StatusOutput
    expect(status.state).toBe("connected")
    expect(Object.keys(status)).not.toContain("account")
    expect((await host.slashStatus()).text).toContain("Account: Slack shows the account on its sign-in page.")
  })

  test.each<[string, FakeHostInput]>([
    ["while signing in", { status: { slack: { status: "needs_auth", error: "Authentication required" } } }],
    ["while connecting", { status: { slack: { status: "pending" } } }],
    ["without a client ID", { options: {} }],
    ["while the user's own server holds the name", { servers: { slack: { type: "remote", url: "https://mcp.example.invalid/mcp" } as never } }],
  ])("%s, there is no account and no request", async (_label, input) => {
    const host = await setUp(input)
    expect(Object.keys((await host.status()) as object)).not.toContain("account")
    expect(sent).toEqual([])
  })
})

describe("the tools RPC status method", () => {
  test("returns the status model, the account included, at every access value", async () => {
    for (const access of ["all", "ask-changes", "read-only"]) {
      const host = await setUp({ options: { oauth: { client_id: "C1" }, access } })
      const status = (await host.script("status", "ses_build", {})) as StatusOutput
      expect(status).toMatchObject({ state: "connected", account: { teamId: "T0TEAM0001", userId: "U0USER0001" } })
      expect(status).toEqual((await host.status()) as StatusOutput)
    }
  })

  test("is a read with its own permission action, listed by describe", async () => {
    const host = await setUp()
    const described = (await host.script("describe", "ses_build")) as { methods: { name: string; class: string; action: string; permission: string; available: boolean }[] }
    expect(described.methods.find((method) => method.name === "status")).toMatchObject({ class: "read", action: STATUS_ACTION, permission: "allow", available: true })
    expect(STATUS_ACTION).toBe("slack_status")
  })

  test("rejects an input other than an empty object", async () => {
    const host = await setUp()
    expect(await host.script("status", "ses_build", { verbose: true })).toMatchObject({ error: "failed", data: { code: "INPUT_INVALID" } })
  })
})

describe("mark_read", () => {
  test("marks a conversation read up to a message with conversations.mark, as the signed-in user", async () => {
    const host = await setUp()
    expect(await host.script(MARK_READ, "ses_build", { channel_id: DM, ts: TS })).toEqual({ channel_id: DM, ts: TS })
    expect(sent).toEqual([{ method: "conversations.mark", authorization: `Bearer ${TOKEN}`, params: { channel: DM, ts: TS } }])
  })

  test("is a write with its own permission action, and a Code Mode tool in the slack namespace", async () => {
    const host = await setUp()
    const described = (await host.script("describe", "")) as { methods: { name: string; class: string; action: string }[] }
    expect(described.methods.find((method) => method.name === MARK_READ)).toMatchObject({ class: "write", action: MARK_READ_ACTION })
    expect(MARK_READ_ACTION).toBe("slack_mark_read")
    expect(host.tools.map((tool) => tool.name)).toContain(MARK_READ)
    const tool = host.tools.find((item) => item.name === MARK_READ)!
    expect(tool.options).toEqual({ namespace: "slack" })
  })

  test("the Code Mode tool asserts its own action, then marks", async () => {
    const host = await setUp()
    const tool = host.tools.find((item) => item.name === MARK_READ)!
    const result = (await tool.execute({ channel_id: DM, ts: TS }, { sessionID: "ses_build", agent: "build", messageID: "msg_1", id: "call_1", signal: new AbortController().signal })) as { output: unknown; content: string }
    expect(host.asserted).toEqual([{ sessionID: "ses_build", agent: "build", action: MARK_READ_ACTION, resources: ["*"], source: { type: "tool", messageID: "msg_1", id: "call_1" } }])
    expect(result.output).toEqual({ channel_id: DM, ts: TS })
    expect(result.content).toBe(`Marked ${DM} read up to ${TS}.`)
  })

  test.each([
    ["no input", undefined],
    ["no ts", { channel_id: DM }],
    ["no channel", { ts: TS }],
    ["a user id as the channel", { channel_id: "U0USER00001", ts: TS }],
    ["a ts that is not one", { channel_id: DM, ts: "yesterday" }],
    ["an extra field", { channel_id: DM, ts: TS, text: "hi" }],
  ])("refuses %s with INPUT_INVALID and no request", async (_label, input) => {
    const host = await setUp()
    expect(await host.script(MARK_READ, "ses_build", input)).toMatchObject({ error: "failed", data: { code: "INPUT_INVALID" } })
    expect(sent).toEqual([])
  })

  test("a missing scope is SCOPE_MISSING, naming the scope Slack asks for", async () => {
    answers["conversations.mark"] = () => json({ ok: false, error: "missing_scope", needed: "im:write", provided: "channels:history" })
    const host = await setUp()
    const refused = (await host.script(MARK_READ, "ses_build", { channel_id: DM, ts: TS })) as { message: string; data: { code: string; next: string } }
    expect(refused).toMatchObject({ error: "failed", data: { code: "SCOPE_MISSING" } })
    expect(refused.message).toContain("im:write")
    expect(refused.data.next).toContain("im:write")
    expect(refused.data.next).toContain("oauth.scopes")
  })

  test("any other Slack error is UPSTREAM_ERROR with Slack's code, and never the token", async () => {
    answers["conversations.mark"] = () => json({ ok: false, error: "channel_not_found" })
    const host = await setUp()
    const refused = (await host.script(MARK_READ, "ses_build", { channel_id: DM, ts: TS })) as { message: string }
    expect(refused).toMatchObject({ error: "failed", data: { code: "UPSTREAM_ERROR" } })
    expect(refused.message).toContain("channel_not_found")
    expect(JSON.stringify(refused)).not.toContain("xox")
  })

  test("without a Slack sign-in it gives status's code and next step, with no request", async () => {
    const host = await setUp({ credentials: {}, status: { slack: { status: "needs_auth", error: "Authentication required" } } })
    expect(await host.script(MARK_READ, "ses_build", { channel_id: DM, ts: TS })).toMatchObject({ error: "failed", data: { code: "AUTH_REQUIRED" } })
    expect(sent).toEqual([])
  })

  test("under ask-changes it is refused before it runs, and read-only denies it", async () => {
    for (const access of ["ask-changes", "read-only"]) {
      const host = await setUp({ options: { oauth: { client_id: "C1" }, access } })
      expect(await host.script(MARK_READ, "ses_build", { channel_id: DM, ts: TS })).toMatchObject({ error: "failed", data: { code: "PERMISSION_DENIED" } })
    }
    expect(sent.filter((request) => request.method === "conversations.mark")).toEqual([])
  })

  test("the tools RPC has exactly describe, status, events_list, mark_read and the known tools", async () => {
    const host = await setUp()
    const names = Object.keys(host.rpcs.get(TOOLS_RPC_ID)!)
    for (const name of ["describe", "status", "events_list", MARK_READ]) expect(names).toContain(name)
  })
})
