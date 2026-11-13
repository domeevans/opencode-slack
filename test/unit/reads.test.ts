// The plugin's two structured reads, mentions_list and dms_list, through setup on a fake host with a fake slack.com.
// They read with the Slack sign-in through src/slack-api.ts and answer in JSON. Every id, name and token below is
// invented.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { DMS_ACTION, DMS_LIST } from "../../src/dms.js"
import { MENTIONS_ACTION, MENTIONS_LIST } from "../../src/mentions.js"
import plugin from "../../src/index.js"
import { fakeHost, type FakeHostInput } from "./fakes.js"

const TOKEN = "xoxe.xoxp-1-INVENTED-token-value"
const SLACK_SIGN_IN = { type: "oauth" as const, methodID: "oauth" as never, access: TOKEN, refresh: "xoxe-1-INVENTED-refresh", expires: Date.now() + 3_600_000 }
const SELF = "U0USER0001"
const AUTH_TEST = { ok: true, team_id: "T0TEAM0001", user_id: SELF }
const SINCE = "2026-11-13T09:00:00Z"
const SINCE_S = Date.parse(SINCE) / 1000

interface Sent {
  readonly method: string
  readonly authorization: string | null
  readonly params: Record<string, string>
}

let sent: Sent[] = []
let answers: Record<string, (params: Record<string, string>) => Response> = {}
const realFetch = globalThis.fetch
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } })

beforeEach(() => {
  sent = []
  answers = { "auth.test": () => json(AUTH_TEST) }
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const href = String(url)
    if (!href.startsWith("https://slack.com/api/")) throw new Error(`unexpected request to ${href}`)
    const method = href.slice("https://slack.com/api/".length)
    const params = Object.fromEntries(new URLSearchParams(String(init.body ?? "")))
    sent.push({ method, authorization: new Headers(init.headers).get("authorization"), params })
    return (answers[method] ?? (() => json({ ok: false, error: "unknown_method" })))(params)
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

const methods = (method: string) => sent.filter((request) => request.method === method)

/** A search result as Slack's assistant.search.context gives it. */
const hit = (ts: string, extra: Record<string, unknown> = {}) => ({
  author_name: "Riley",
  author_email: "riley@example.invalid",
  author_user_id: "U0OTHER001",
  team_id: "T0TEAM0001",
  channel_id: "C0CHAN00001",
  channel_name: "launch",
  message_ts: ts,
  content: `<@${SELF}|sam> can you look?`,
  is_author_bot: false,
  permalink: `https://acme.slack.com/archives/C0CHAN00001/p${ts.replace(".", "")}`,
  ...extra,
})

const search = (messages: unknown[], next = "") => json({ ok: true, results: { messages, files: [], channels: [], users: [] }, response_metadata: { next_cursor: next } })

describe("mentions_list", () => {
  test("searches for the signed-in user's mention since the time, and answers each as JSON", async () => {
    const ts = String(SINCE_S + 60) + ".000100"
    answers["assistant.search.context"] = () => search([hit(ts)])
    const host = await setUp()
    const output = await host.script(MENTIONS_LIST, "ses_build", { since: SINCE })
    expect(output).toEqual({
      events: [{
        id: `C0CHAN00001:${ts}`,
        channel_id: "C0CHAN00001",
        channel_name: "launch",
        ts,
        user_id: "U0OTHER001",
        user_name: "Riley",
        text: `<@${SELF}|sam> can you look?`,
        permalink: `https://acme.slack.com/archives/C0CHAN00001/p${ts.replace(".", "")}`,
        time: new Date((SINCE_S + 60) * 1000).toISOString(),
      }],
    })
    const [request] = methods("assistant.search.context")
    expect(request).toEqual({
      method: "assistant.search.context",
      authorization: `Bearer ${TOKEN}`,
      params: {
        query: `<@${SELF}>`,
        channel_types: "public_channel,private_channel,mpim,im",
        content_types: "messages",
        sort: "timestamp",
        sort_dir: "desc",
        after: String(SINCE_S),
        limit: "20",
      },
    })
    // No email, no token: only the fields the output names.
    expect(JSON.stringify(output)).not.toContain("example.invalid")
    expect(JSON.stringify(output)).not.toContain("xox")
  })

  test("names the thread a reply belongs to, from Slack's permalink", async () => {
    const ts = `${SINCE_S + 5}.000200`
    const parent = `${SINCE_S - 50}.000100`
    answers["assistant.search.context"] = () => search([hit(ts, { permalink: `https://acme.slack.com/archives/C0CHAN00001/p1?thread_ts=${parent}&cid=C0CHAN00001` })])
    const host = await setUp()
    const { events } = (await host.script(MENTIONS_LIST, "ses_build", { since: SINCE })) as { events: { thread_ts?: string }[] }
    expect(events[0]!.thread_ts).toBe(parent)
  })

  test("leaves out the user's own messages, older messages and results it cannot read, and bounds the text", async () => {
    const long = "x".repeat(5_000)
    answers["assistant.search.context"] = () => search([
      hit(`${SINCE_S + 30}.000001`, { content: long }),
      hit(`${SINCE_S + 20}.000001`, { author_user_id: SELF }),
      hit(`${SINCE_S + 10}.000001`, { channel_id: "not a channel" }),
      hit(`${SINCE_S + 9}.000001`, { permalink: "javascript:alert(1)" }),
      hit(`${SINCE_S - 10}.000001`),
    ])
    const host = await setUp()
    const { events } = (await host.script(MENTIONS_LIST, "ses_build", { since: SINCE })) as { events: { ts: string; text: string }[] }
    expect(events.map((event) => event.ts)).toEqual([`${SINCE_S + 30}.000001`])
    expect(Array.from(events[0]!.text)).toHaveLength(4_096)
  })

  test("reads further pages until it has the limit, and stops after five", async () => {
    let page = 0
    answers["assistant.search.context"] = () => {
      page += 1
      return search([hit(`${SINCE_S + 1000 - page}.000001`)], `page${page}`)
    }
    const host = await setUp()
    const { events } = (await host.script(MENTIONS_LIST, "ses_build", { since: SINCE, limit: 3 })) as { events: unknown[] }
    expect(events).toHaveLength(3)
    expect(methods("assistant.search.context").map((request) => request.params["cursor"])).toEqual([undefined, "page1", "page2"])

    sent = []
    page = 0
    await host.script(MENTIONS_LIST, "ses_build", { since: SINCE, limit: 100 })
    expect(methods("assistant.search.context")).toHaveLength(5)
  })

  test.each([
    ["no input", undefined],
    ["no since", {}],
    ["a since without a zone", { since: "2026-11-13T09:00:00" }],
    ["a since that is not a time", { since: "yesterday" }],
    ["a limit of 0", { since: SINCE, limit: 0 }],
    ["a limit over 100", { since: SINCE, limit: 101 }],
    ["an extra field", { since: SINCE, query: "x" }],
  ])("refuses %s with INPUT_INVALID and no search", async (_label, input) => {
    const host = await setUp()
    expect(await host.script(MENTIONS_LIST, "ses_build", input)).toMatchObject({ error: "failed", data: { code: "INPUT_INVALID" } })
    expect(methods("assistant.search.context")).toEqual([])
  })

  test("a missing search scope is SCOPE_MISSING, naming the scope", async () => {
    answers["assistant.search.context"] = () => json({ ok: false, error: "missing_scope", needed: "search:read.im" })
    const host = await setUp()
    const refused = (await host.script(MENTIONS_LIST, "ses_build", { since: SINCE })) as { message: string; data: { code: string } }
    expect(refused).toMatchObject({ error: "failed", data: { code: "SCOPE_MISSING" } })
    expect(refused.message).toContain("search:read.im")
  })

  test("waits out Slack's rate limit and tries again, then gives up with UPSTREAM_ERROR", async () => {
    let tries = 0
    answers["assistant.search.context"] = () => (tries++ === 0 ? new Response("", { status: 429, headers: { "retry-after": "0" } }) : search([]))
    const host = await setUp()
    expect(await host.script(MENTIONS_LIST, "ses_build", { since: SINCE })).toEqual({ events: [] })
    expect(tries).toBe(2)

    answers["assistant.search.context"] = () => new Response("", { status: 429, headers: { "retry-after": "0" } })
    sent = []
    const refused = (await host.script(MENTIONS_LIST, "ses_build", { since: SINCE })) as { message: string }
    expect(refused).toMatchObject({ error: "failed", data: { code: "UPSTREAM_ERROR" } })
    expect(refused.message).toContain("ratelimited")
    expect(methods("assistant.search.context")).toHaveLength(3)
  })

  test("a rate limit that asks for a long wait is UPSTREAM_ERROR at once", async () => {
    answers["assistant.search.context"] = () => new Response("", { status: 429, headers: { "retry-after": "120" } })
    const host = await setUp()
    expect(await host.script(MENTIONS_LIST, "ses_build", { since: SINCE })).toMatchObject({ error: "failed", data: { code: "UPSTREAM_ERROR" } })
    expect(methods("assistant.search.context")).toHaveLength(1)
  })

  test("without a Slack sign-in it gives status's code and next step, with no request", async () => {
    const host = await setUp({ credentials: {}, status: { slack: { status: "needs_auth", error: "Authentication required" } } })
    expect(await host.script(MENTIONS_LIST, "ses_build", { since: SINCE })).toMatchObject({ error: "failed", data: { code: "AUTH_REQUIRED" } })
    expect(sent).toEqual([])
  })

  test("when Slack does not say who is signed in, it is UPSTREAM_ERROR and searches nothing", async () => {
    answers["auth.test"] = () => json({ ok: false, error: "invalid_auth" })
    const host = await setUp()
    expect(await host.script(MENTIONS_LIST, "ses_build", { since: SINCE })).toMatchObject({ error: "failed", data: { code: "UPSTREAM_ERROR" } })
    expect(methods("assistant.search.context")).toEqual([])
  })
})

/** A conversation as users.conversations lists it. */
const im = (id: string, user: string, extra: Record<string, unknown> = {}) => ({ id, is_im: true, is_archived: false, user, is_user_deleted: false, updated: 1, ...extra })
const mpim = (id: string, extra: Record<string, unknown> = {}) => ({ id, is_mpim: true, is_archived: false, updated: 1, ...extra })
/** conversations.info for a conversation with its latest message. */
const info = (latest: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) =>
  json({ ok: true, channel: { last_read: "0000000000.000000", unread_count: 0, unread_count_display: 0, ...(latest === undefined ? {} : { latest: { type: "message", ...latest } }), ...extra } })

describe("dms_list", () => {
  const T1 = `${SINCE_S + 300}.000001`
  const T2 = `${SINCE_S + 200}.000001`
  const T3 = `${SINCE_S - 100}.000001`

  beforeEach(() => {
    answers["users.conversations"] = () => json({
      ok: true,
      channels: [
        im("D0DM0000001", "U0ALEX0001"),
        mpim("G0GROUP0001"),
        im("D0DM0000002", "U0OLD00001"),
        im("D0SELF00001", SELF),
        im("D0GONE00001", "U0GONE0001", { is_user_deleted: true }),
      ],
      response_metadata: { next_cursor: "" },
    })
    const infos: Record<string, () => Response> = {
      D0DM0000001: () => info({ ts: T2, user: "U0ALEX0001", text: "lunch?" }, { last_read: T3, unread_count_display: 1 }),
      G0GROUP0001: () => info({ ts: T1, user: SELF, text: "shipped" }, { last_read: T1 }),
      D0DM0000002: () => info({ ts: T3, user: "U0OLD00001", text: "old news" }),
    }
    answers["conversations.info"] = (params) => (infos[params["channel"]!] ?? (() => json({ ok: false, error: "channel_not_found" })))()
    answers["conversations.members"] = () => json({ ok: true, members: [SELF, "U0ALEX0001", "U0BLAKE001"], response_metadata: { next_cursor: "" } })
    const users: Record<string, unknown> = {
      U0ALEX0001: { id: "U0ALEX0001", name: "alex", real_name: "Alex Doe", profile: { display_name: "Alex" } },
      U0BLAKE001: { id: "U0BLAKE001", name: "blake", real_name: "Blake Roe", profile: { display_name: "" } },
      U0OLD00001: { id: "U0OLD00001", name: "olde", profile: {} },
    }
    answers["users.info"] = (params) => (users[params["user"]!] === undefined ? json({ ok: false, error: "user_not_found" }) : json({ ok: true, user: users[params["user"]!] }))
  })

  test("lists direct and group messages with the latest message and unread state, newest first", async () => {
    const host = await setUp()
    const output = await host.script(DMS_LIST, "ses_build", {})
    expect(output).toEqual({
      conversations: [
        {
          channel_id: "G0GROUP0001",
          kind: "group-dm",
          members: [{ id: "U0ALEX0001", name: "Alex" }, { id: "U0BLAKE001", name: "Blake Roe" }],
          latest: { ts: T1, user_id: SELF, text: "shipped", time: new Date((SINCE_S + 300) * 1000).toISOString() },
          unread: false,
        },
        {
          channel_id: "D0DM0000001",
          kind: "dm",
          members: [{ id: "U0ALEX0001", name: "Alex" }],
          latest: { ts: T2, user_id: "U0ALEX0001", text: "lunch?", time: new Date((SINCE_S + 200) * 1000).toISOString() },
          unread: true,
        },
        {
          channel_id: "D0DM0000002",
          kind: "dm",
          members: [{ id: "U0OLD00001", name: "olde" }],
          latest: { ts: T3, user_id: "U0OLD00001", text: "old news", time: new Date((SINCE_S - 100) * 1000).toISOString() },
          unread: false,
        },
      ],
    })
    expect(methods("users.conversations")[0]!.params).toEqual({ types: "im,mpim", exclude_archived: "true", limit: "200" })
    // The note to oneself and the deleted user's conversation are never read.
    expect(methods("conversations.info").map((request) => request.params["channel"]).sort()).toEqual(["D0DM0000001", "D0DM0000002", "G0GROUP0001"])
    // Each person is named once per call.
    expect(methods("users.info").filter((request) => request.params["user"] === "U0ALEX0001")).toHaveLength(1)
    expect(sent.every((request) => request.authorization === `Bearer ${TOKEN}`)).toBe(true)
  })

  test("since leaves out conversations whose latest message is older, and limit keeps the newest", async () => {
    const host = await setUp()
    const { conversations } = (await host.script(DMS_LIST, "ses_build", { since: SINCE, limit: 1 })) as { conversations: { channel_id: string }[] }
    expect(conversations.map((item) => item.channel_id)).toEqual(["G0GROUP0001"])
    const all = (await host.script(DMS_LIST, "ses_build", { since: SINCE })) as { conversations: { channel_id: string }[] }
    expect(all.conversations.map((item) => item.channel_id)).toEqual(["G0GROUP0001", "D0DM0000001"])
  })

  test("without Slack's unread count, a message from someone else after the read mark is unread", async () => {
    answers["conversations.info"] = () => json({ ok: true, channel: { last_read: T3, latest: { ts: T2, user: "U0ALEX0001", text: "hi" } } })
    answers["users.conversations"] = () => json({ ok: true, channels: [im("D0DM0000001", "U0ALEX0001")] })
    const host = await setUp()
    const { conversations } = (await host.script(DMS_LIST, "ses_build", {})) as { conversations: { unread: boolean }[] }
    expect(conversations[0]!.unread).toBe(true)
  })

  test("a conversation with no message is left out, and a name Slack does not give is the id", async () => {
    answers["users.conversations"] = () => json({ ok: true, channels: [im("D0DM0000001", "U0ALEX0001"), im("D0DM0000003", "U0NONAME01")] })
    answers["conversations.info"] = (params) => params["channel"] === "D0DM0000001" ? info(undefined) : info({ ts: T2, user: "U0NONAME01", text: "hey" })
    const host = await setUp()
    const { conversations } = (await host.script(DMS_LIST, "ses_build", {})) as { conversations: { channel_id: string; members: unknown[] }[] }
    expect(conversations.map((item) => item.channel_id)).toEqual(["D0DM0000003"])
    expect(conversations[0]!.members).toEqual([{ id: "U0NONAME01", name: "U0NONAME01" }])
  })

  test("a listed conversation Slack will not open is left out, and any other refusal fails the call", async () => {
    answers["conversations.info"] = (params) => params["channel"] === "D0DM0000002"
      ? json({ ok: false, error: "channel_not_found" })
      : info({ ts: T2, user: "U0ALEX0001", text: "hi" })
    const host = await setUp()
    const { conversations } = (await host.script(DMS_LIST, "ses_build", {})) as { conversations: { channel_id: string }[] }
    expect(conversations.map((item) => item.channel_id).sort()).toEqual(["D0DM0000001", "G0GROUP0001"])

    answers["conversations.info"] = () => json({ ok: false, error: "invalid_auth" })
    expect(await host.script(DMS_LIST, "ses_build", {})).toMatchObject({ error: "failed", data: { code: "UPSTREAM_ERROR" } })
  })

  test("reads at most 100 conversations, the ones Slack marks dormant last", async () => {
    const many = Array.from({ length: 150 }, (_, index) => im(`D0MANY${String(index).padStart(5, "0")}`, "U0ALEX0001", index < 60 ? { properties: { is_dormant: true } } : { updated: index }))
    answers["users.conversations"] = () => json({ ok: true, channels: many })
    answers["conversations.info"] = () => info({ ts: T2, user: "U0ALEX0001", text: "x" })
    const host = await setUp()
    await host.script(DMS_LIST, "ses_build", { limit: 50 })
    const read = methods("conversations.info").map((request) => request.params["channel"]!)
    expect(read).toHaveLength(100)
    expect(read.filter((id) => Number(id.slice(6)) >= 60)).toHaveLength(90)
  })

  test("follows users.conversations' cursor for at most five pages", async () => {
    let page = 0
    answers["users.conversations"] = () => json({ ok: true, channels: [], response_metadata: { next_cursor: `c${++page}` } })
    const host = await setUp()
    expect(await host.script(DMS_LIST, "ses_build", {})).toEqual({ conversations: [] })
    expect(methods("users.conversations").map((request) => request.params["cursor"])).toEqual([undefined, "c1", "c2", "c3", "c4"])
  })

  test.each([
    ["a since that is not a time", { since: "today" }],
    ["a limit over 50", { limit: 51 }],
    ["an extra field", { types: "im" }],
    ["an input that is not an object", ["im"]],
  ])("refuses %s with INPUT_INVALID and no request", async (_label, input) => {
    const host = await setUp()
    expect(await host.script(DMS_LIST, "ses_build", input)).toMatchObject({ error: "failed", data: { code: "INPUT_INVALID" } })
    expect(methods("users.conversations")).toEqual([])
  })

  test("a missing scope is SCOPE_MISSING, naming the scope", async () => {
    answers["users.conversations"] = () => json({ ok: false, error: "missing_scope", needed: "mpim:read" })
    const host = await setUp()
    const refused = (await host.script(DMS_LIST, "ses_build", {})) as { message: string }
    expect(refused).toMatchObject({ error: "failed", data: { code: "SCOPE_MISSING" } })
    expect(refused.message).toContain("mpim:read")
  })
})

describe("the structured reads as methods and tools", () => {
  test("are reads with their own permission actions, listed by describe, and Code Mode tools in the slack namespace", async () => {
    const host = await setUp()
    const described = (await host.script("describe", "ses_build")) as { methods: { name: string; class: string; action: string; permission: string; available: boolean }[] }
    expect(described.methods.find((method) => method.name === MENTIONS_LIST)).toMatchObject({ class: "read", action: MENTIONS_ACTION, permission: "allow", available: true })
    expect(described.methods.find((method) => method.name === DMS_LIST)).toMatchObject({ class: "read", action: DMS_ACTION, permission: "allow", available: true })
    expect([MENTIONS_ACTION, DMS_ACTION]).toEqual(["slack_mentions_list", "slack_dms_list"])
    for (const name of [MENTIONS_LIST, DMS_LIST]) expect(host.tools.find((tool) => tool.name === name)?.options).toEqual({ namespace: "slack" })
  })

  test("the Code Mode tool asserts its own action, then reads", async () => {
    answers["assistant.search.context"] = () => search([])
    const host = await setUp()
    const tool = host.tools.find((item) => item.name === MENTIONS_LIST)!
    const result = (await tool.execute({ since: SINCE }, { sessionID: "ses_build", agent: "build", messageID: "msg_1", id: "call_1", signal: new AbortController().signal })) as { output: unknown; content: string }
    expect(host.asserted).toEqual([{ sessionID: "ses_build", agent: "build", action: MENTIONS_ACTION, resources: ["*"], source: { type: "tool", messageID: "msg_1", id: "call_1" } }])
    expect(result).toEqual({ output: { events: [] }, content: "0 Slack mentions." })
  })

  test("like the private search, they run at all, and are refused under ask-changes and read-only", async () => {
    for (const access of ["ask-changes", "read-only"]) {
      const host = await setUp({ options: { oauth: { client_id: "C1" }, access } })
      expect(await host.script(MENTIONS_LIST, "ses_build", { since: SINCE })).toMatchObject({ error: "failed", data: { code: "PERMISSION_DENIED" } })
      expect(await host.script(DMS_LIST, "ses_build", {})).toMatchObject({ error: "failed", data: { code: "PERMISSION_DENIED" } })
    }
    expect(sent.filter((request) => request.method !== "auth.test")).toEqual([])
  })
})
