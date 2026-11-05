import { describe, expect, test } from "bun:test"
import type { Client } from "../../src/connect.js"
import { parseOptions, type Options } from "../../src/options.js"
import { registerServer, serverConfig } from "../../src/server.js"
import { mcpEditor } from "./fakes.js"

function options(input: unknown): Options {
  const parsed = parseOptions(input)
  if (!parsed.ok) throw new Error(parsed.error.message)
  return parsed.options
}

const PUBLIC = options({})
const C1: Client = { id: "C1", source: "connect" }

describe("serverConfig", () => {
  test("public PKCE: exactly type, url and oauth with the client, callback and scopes", () => {
    expect(serverConfig(PUBLIC, C1)).toStrictEqual({
      type: "remote",
      url: "https://mcp.slack.com/mcp",
      oauth: {
        client_id: "C1",
        redirect_uri: "http://localhost:8765/callback",
        scope: "channels:history channels:read search:read.public users:read",
      },
    })
  })

  test("confidential: adds the client secret and nothing else", () => {
    expect(serverConfig(PUBLIC, { ...C1, secret: "shh" })).toStrictEqual({
      type: "remote",
      url: "https://mcp.slack.com/mcp",
      oauth: {
        client_id: "C1",
        redirect_uri: "http://localhost:8765/callback",
        scope: "channels:history channels:read search:read.public users:read",
        client_secret: "shh",
      },
    })
  })

  test("custom scopes and callback are passed through", () => {
    const config = serverConfig(options({
      oauth: { redirect_uri: "http://127.0.0.1:9000/oauth", scopes: ["search:read.public", "search:read.private", "files:read"] },
    }), C1)
    expect(config).toMatchObject({ oauth: { redirect_uri: "http://127.0.0.1:9000/oauth", scope: "search:read.public search:read.private files:read" } })
  })

  test("an https redirect with a callback port gives both, and nothing else changes", () => {
    const hosted = options({ oauth: { redirect_uri: "https://host.example/oauth/return", callback_port: 49200 } })
    expect(serverConfig(hosted, C1)).toStrictEqual({
      type: "remote",
      url: "https://mcp.slack.com/mcp",
      oauth: {
        client_id: "C1",
        redirect_uri: "https://host.example/oauth/return",
        callback_port: 49200,
        scope: "channels:history channels:read search:read.public users:read",
      },
    })
  })

  test("a loopback redirect sets no callback port, so OpenCode listens on the redirect's own port", () => {
    const oauthKeys = (config: ReturnType<typeof serverConfig>) => Object.keys((config as { oauth: object }).oauth)
    expect(oauthKeys(serverConfig(options({ oauth: { redirect_uri: "http://127.0.0.1:9000/oauth" } }), C1))).not.toContain("callback_port")
    expect(oauthKeys(serverConfig(PUBLIC, C1))).not.toContain("callback_port")
  })

  test("leaves protocol, timeouts, headers and Code Mode to the host", () => {
    expect(Object.keys(serverConfig(PUBLIC, { ...C1, secret: "s" })).sort()).toEqual(["oauth", "type", "url"])
  })
})

describe("registerServer", () => {
  test("adds the server under the default name", () => {
    const { editor, servers } = mcpEditor()
    expect(registerServer(editor, PUBLIC, C1)).toBe(true)
    expect([...servers.keys()]).toEqual(["slack"])
    expect(servers.get("slack")).toStrictEqual(serverConfig(PUBLIC, C1))
  })

  test("adds nothing without a client, and reports the name as free", () => {
    const { editor, servers } = mcpEditor()
    expect(registerServer(editor, PUBLIC, undefined)).toBe(true)
    expect(servers.size).toBe(0)
  })

  test("never overwrites a server the user already named the same", () => {
    const mine = { type: "remote", url: "https://mcp.example.test/mcp", oauth: false } as const
    const { editor, servers } = mcpEditor({ slack: mine })
    expect(registerServer(editor, PUBLIC, C1)).toBe(false)
    expect(servers.get("slack")).toStrictEqual(mine)
  })
})
