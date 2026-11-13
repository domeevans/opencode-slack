// The plugin's one Slack Web API client: it resolves the Slack sign-in through OpenCode's connection API and calls one
// allowed method with it. It never returns the token, and its errors carry Slack's error code only. Every id and token
// below is invented.
import { describe, expect, test } from "bun:test"
import { slackApi, NOT_SIGNED_IN, REQUEST_FAILED, type SlackApiSources } from "../../src/slack-api.js"

const TOKEN = "xoxe.xoxp-1-INVENTED-token-value"
const REFRESH = "xoxe-1-INVENTED-refresh"

interface Sent {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: string
}

/** A fetch that records each request and answers with `answer`. */
function fakeFetch(answer: (sent: Sent) => Response | Promise<Response>) {
  const sent: Sent[] = []
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const request: Sent = {
      url: String(url),
      method: init.method ?? "GET",
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: String(init.body ?? ""),
    }
    sent.push(request)
    return answer(request)
  }) as unknown as typeof globalThis.fetch
  return { fetch, sent }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

interface Setup {
  readonly servers?: readonly { name: string; integrationID?: string }[]
  readonly connection?: unknown
  readonly credential?: unknown
  readonly owned?: boolean
  readonly activeThrows?: boolean
  readonly resolveThrows?: boolean
}

function sources(setup: Setup, fetch: typeof globalThis.fetch): SlackApiSources & { asked: string[] } {
  const asked: string[] = []
  const servers = setup.servers ?? [{ name: "slack", integrationID: "mcp_slack" }]
  return {
    asked,
    mcp: { list: async () => ({ data: servers.map((server) => ({ ...server, status: { status: "connected" } })) }) as never },
    connection: {
      active: async (integrationID: string) => {
        asked.push(integrationID)
        if (setup.activeThrows) throw new Error(`no connection for ${TOKEN}`)
        return (setup.connection === undefined ? { type: "credential", id: "crd_one", label: "Slack", method: "oauth" } : setup.connection) as never
      },
      resolve: async () => {
        if (setup.resolveThrows) throw new Error(`refresh failed for ${REFRESH}`)
        return (setup.credential === undefined ? { type: "oauth", access: TOKEN, refresh: REFRESH, expires: Date.now() + 3_600_000 } : setup.credential) as never
      },
    },
    owned: () => setup.owned ?? true,
    fetch,
  }
}

describe("the Slack Web API client", () => {
  test("posts the method to slack.com with the Slack sign-in's token as a bearer header, and returns Slack's answer and the credential's id", async () => {
    const { fetch, sent } = fakeFetch(() => json({ ok: true, team_id: "T0TEAM0001", user_id: "U0USER0001" }))
    const deps = sources({}, fetch)
    const result = await slackApi(deps).call("conversations.mark", { channel: "D0DM000001", ts: "1700000000.000100" })
    expect(result).toEqual({ ok: true, credential: "crd_one", body: { ok: true, team_id: "T0TEAM0001", user_id: "U0USER0001" } })
    expect(deps.asked).toEqual(["mcp_slack"])
    expect(sent).toHaveLength(1)
    expect(sent[0]!.url).toBe("https://slack.com/api/conversations.mark")
    expect(sent[0]!.method).toBe("POST")
    expect(sent[0]!.headers["authorization"]).toBe(`Bearer ${TOKEN}`)
    expect(sent[0]!.headers["content-type"]).toBe("application/x-www-form-urlencoded")
    expect(new URLSearchParams(sent[0]!.body).get("channel")).toBe("D0DM000001")
    expect(new URLSearchParams(sent[0]!.body).get("ts")).toBe("1700000000.000100")
    // The token travels only in the header.
    expect(sent[0]!.url).not.toContain(TOKEN)
    expect(sent[0]!.body).not.toContain(TOKEN)
  })

  test("never returns the token, even when Slack echoes it", async () => {
    const { fetch } = fakeFetch(() => json({ ok: false, error: "invalid_auth", token: TOKEN, detail: TOKEN }))
    const result = await slackApi(sources({}, fetch)).call("auth.test", {})
    expect(result).toEqual({ ok: false, error: "invalid_auth" })
    expect(JSON.stringify(result)).not.toContain("xox")
  })

  test("a successful answer drops anything that looks like a token", async () => {
    const { fetch } = fakeFetch(() => json({ ok: true, team_id: "T0TEAM0001", echoed: TOKEN, nested: { access: TOKEN } }))
    const result = await slackApi(sources({}, fetch)).call("auth.test", {})
    expect(JSON.stringify(result)).not.toContain("xox")
    expect(result).toMatchObject({ ok: true, body: { team_id: "T0TEAM0001" } })
  })

  test("reports Slack's missing_scope with the scope Slack names, and nothing else of Slack's answer", async () => {
    const { fetch } = fakeFetch(() => json({ ok: false, error: "missing_scope", needed: "im:write", provided: "channels:history,users:read" }))
    expect(await slackApi(sources({}, fetch)).call("conversations.mark", { channel: "D0DM000001", ts: "1700000000.000100" }))
      .toEqual({ ok: false, error: "missing_scope", needed: "im:write" })
  })

  test("a needed scope that is not a plain scope name is left out", async () => {
    const { fetch } = fakeFetch(() => json({ ok: false, error: "missing_scope", needed: "im:write <script>" }))
    expect(await slackApi(sources({}, fetch)).call("auth.test", {})).toEqual({ ok: false, error: "missing_scope" })
  })

  test.each([
    ["an error that is not a plain code", json({ ok: false, error: `bad token ${TOKEN}` })],
    ["an answer that is not JSON", new Response("<html>gateway</html>", { status: 502 })],
    ["an answer that is not an object", json(["ok"])],
    ["an answer without ok", json({ team_id: "T0TEAM0001" })],
  ])("%s is request_failed", async (_label, response) => {
    const { fetch } = fakeFetch(() => response)
    const result = await slackApi(sources({}, fetch)).call("auth.test", {})
    expect(result).toEqual({ ok: false, error: REQUEST_FAILED })
  })

  test("a rate limit is Slack's ratelimited, with the seconds Slack's Retry-After asks for", async () => {
    const { fetch } = fakeFetch(() => new Response("", { status: 429, headers: { "retry-after": "30" } }))
    expect(await slackApi(sources({}, fetch)).call("auth.test", {})).toEqual({ ok: false, error: "ratelimited", retryAfter: 30 })
  })

  test.each([["no Retry-After", {}], ["a Retry-After that is not whole seconds", { "retry-after": "soon" }]])("a rate limit with %s has no wait", async (_label, headers) => {
    const { fetch } = fakeFetch(() => new Response("", { status: 429, headers }))
    expect(await slackApi(sources({}, fetch)).call("auth.test", {})).toEqual({ ok: false, error: "ratelimited" })
  })

  test("a network failure is request_failed, and its message is never returned", async () => {
    const { fetch } = fakeFetch(() => {
      throw new Error(`connect failed with ${TOKEN}`)
    })
    const result = await slackApi(sources({}, fetch)).call("auth.test", {})
    expect(result).toEqual({ ok: false, error: REQUEST_FAILED })
  })

  test.each<[string, Setup]>([
    ["no slack server", { servers: [] }],
    ["a slack server without an integration", { servers: [{ name: "slack" }] }],
    ["a slack server that is the user's own", { owned: false }],
    ["no active connection", { connection: null }],
    ["an environment connection", { connection: { type: "env", name: "SLACK_TOKEN" } }],
    ["a failing connection lookup", { activeThrows: true }],
    ["no credential", { credential: null }],
    ["a credential that is not OAuth", { credential: { type: "key", key: TOKEN } }],
    ["an OAuth credential without a token", { credential: { type: "oauth", access: "" } }],
    ["a failing refresh", { resolveThrows: true }],
  ])("%s is not_signed_in, with no request", async (_label, setup) => {
    const { fetch, sent } = fakeFetch(() => json({ ok: true }))
    const result = await slackApi(sources(setup, fetch)).call("auth.test", {})
    expect(result).toEqual({ ok: false, error: NOT_SIGNED_IN })
    expect(sent).toEqual([])
  })

  test("credential() names the active sign-in's id and sends nothing", async () => {
    const { fetch, sent } = fakeFetch(() => json({ ok: true }))
    expect(await slackApi(sources({}, fetch)).credential()).toBe("crd_one")
    expect(await slackApi(sources({ connection: null }, fetch)).credential()).toBeUndefined()
    expect(await slackApi(sources({ owned: false }, fetch)).credential()).toBeUndefined()
    expect(sent).toEqual([])
  })

  test("a call that outlasts its signal is request_failed", async () => {
    const { fetch } = fakeFetch((request) => new Promise(() => void request))
    const aborted = new AbortController()
    const pending = slackApi(sources({}, fetch)).call("auth.test", {}, aborted.signal)
    aborted.abort()
    expect(await pending).toEqual({ ok: false, error: REQUEST_FAILED })
  })
})
