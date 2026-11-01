import { describe, expect, test } from "bun:test"
import type { ClientState } from "../../src/connect.js"
import { parseOptions } from "../../src/options.js"
import { defaultRules, type Rule } from "../../src/permissions.js"
import { isStatus, SlackRpc } from "../../src/rpc.js"
import { buildStatus, formatStatus, stateLabel, statusRows, type Status, type StatusInput } from "../../src/status.js"
import { BASE_ALLOW, BASE_RULES } from "./fakes.js"

const OK = parseOptions({ oauth: { client_id: "C1" } })
const SECRET = "zz-client-secret-7c1e"
const C1: ClientState = { client: { id: "C1", source: "options" }, invalid: false }
const CONFIDENTIAL: ClientState = { client: { id: "C1", secret: SECRET, source: "connect" }, invalid: false }
const INVALID = parseOptions({ oauth: { redirect_port: 8765 } })

const guarded = (server = "slack"): Rule[] => [BASE_ALLOW, ...defaultRules(server), ...BASE_RULES.slice(1)]
const deny = (action: string): Rule => ({ action, resource: "*", effect: "deny" })
const allow = (action: string): Rule => ({ action, resource: "*", effect: "allow" })

function input(overrides: Partial<StatusInput> = {}): StatusInput {
  return {
    hostVersion: "2.2.3",
    hostTested: true,
    parsed: OK,
    active: true,
    nameInUse: false,
    client: C1,
    servers: [{ name: "slack", status: { status: "connected" } }],
    tools: [],
    agents: [{ id: "build", permissions: guarded() }],
    ...overrides,
  }
}

const SIGN_IN = "Run /connect and choose Slack, then press o or Enter to open the sign-in page (in a terminal, opencode mcp auth slack opens the browser automatically)."
const NO_CLIENT_NEXT = "Run /connect and choose Slack app, then paste your Slack app's client ID."

// Every state and error code, with the exact message and next step each surface shows.
const STATES: readonly (readonly [string, StatusInput, Pick<Status, "state" | "code" | "message" | "next" | "detail">])[] = [
  ["an untested host", input({ hostVersion: "2.1.0", hostTested: false, active: false }), {
    state: "host_untested",
    code: "HOST_UNTESTED",
    message: "OpenCode 2.1.0 is outside the tested range >=2.2.3 <2.3.0, so Slack is not set up.",
    next: 'Use OpenCode >=2.2.3 <2.3.0, or set "allowUntestedHost": true in this plugin\'s options to run anyway.',
  }],
  ["an untested host with invalid options", input({ hostVersion: "0.0.0-dev-1", hostTested: false, active: false, parsed: INVALID }), {
    state: "config_invalid",
    code: "OPTIONS_INVALID",
    message: "Option oauth.redirect_port: This option is not supported.",
    next: "Use oauth.redirect_uri instead, for example http://localhost:8765/callback.",
  }],
  ["invalid options", input({ parsed: INVALID, active: false }), {
    state: "config_invalid",
    code: "OPTIONS_INVALID",
    message: "Option oauth.redirect_port: This option is not supported.",
    next: "Use oauth.redirect_uri instead, for example http://localhost:8765/callback.",
  }],
  ["no client ID", input({ client: { invalid: false } }), {
    state: "no_client_id",
    code: "CLIENT_ID_MISSING",
    message: "No Slack app client ID is set, so Slack is not added. To create the app, use the manifest at https://github.com/joe-broadhead/opencode-slack/blob/HEAD/docs/slack-app-manifest.json.",
    next: NO_CLIENT_NEXT,
  }],
  ["an unusable saved client ID", input({ client: { invalid: true } }), {
    state: "no_client_id",
    code: "CLIENT_ID_INVALID",
    message: "The client ID saved in the /connect Slack app entry is empty or has spaces, so Slack is not added.",
    next: NO_CLIENT_NEXT,
  }],
  ["a server name in use", input({ nameInUse: true }), {
    state: "not_registered",
    code: "SERVER_NAME_IN_USE",
    message: 'Another MCP server is already named "slack", so Slack was not added.',
    next: 'Remove mcp.servers.slack from your OpenCode config, or set this plugin\'s "server" option to another name.',
  }],
  ["a server the host does not list", input({ servers: [] }), {
    state: "not_registered",
    message: "The slack server is not registered.",
    next: "Run opencode reload, then check again.",
  }],
  ["a pending connection", input({ servers: [{ name: "slack", status: { status: "pending" } }] }), {
    state: "connecting",
    message: "Connecting to Slack.",
    next: "Wait a few seconds, then refresh.",
  }],
  ["a disabled server", input({ servers: [{ name: "slack", status: { status: "disabled" } }] }), {
    state: "disabled",
    code: "SERVER_DISABLED",
    message: "The slack server is disabled.",
    next: "Enable slack in /mcps.",
  }],
  ["no sign-in", input({ servers: [{ name: "slack", status: { status: "needs_auth", error: "Authentication required" } }] }), {
    state: "not_signed_in",
    code: "AUTH_REQUIRED",
    message: "Sign in to Slack to use it in OpenCode.",
    detail: "Authentication required",
    next: SIGN_IN,
  }],
  ["a failed connection", input({ servers: [{ name: "slack", status: { status: "failed", error: "invalid_client_id" } }] }), {
    state: "failed",
    code: "CONNECTION_FAILED",
    message: "Could not connect to Slack.",
    detail: "invalid_client_id",
    next: "Fix the error shown, then reconnect slack in /mcps.",
  }],
  ["a connection", input(), {
    state: "connected",
    message: "Connected. Slack tools available: 0.",
    next: "Nothing to do.",
  }],
]

describe("buildStatus states", () => {
  test.each(STATES)("%s", (_label, given, expected) => {
    const status = buildStatus(given)
    expect({ state: status.state, code: status.code, message: status.message, next: status.next, detail: status.detail })
      .toEqual({ code: undefined, detail: undefined, ...expected })
  })

  test("covers every state and error code in the RPC contract", () => {
    const output = SlackRpc.methods.status.output as unknown as { properties: { state: { enum: string[] }; code: { enum: string[] } } }
    const statuses = STATES.map(([, given]) => buildStatus(given))
    expect(new Set<string>(statuses.map((status) => status.state))).toEqual(new Set(output.properties.state.enum))
    expect(new Set<string>(statuses.flatMap((status) => status.code ?? []))).toEqual(new Set(output.properties.code.enum))
  })

  test("an untested host the user allowed proceeds to the connection state and still reports the host", () => {
    const status = buildStatus(input({ hostVersion: "2.3.0-beta.1", hostTested: false }))
    expect(status.state).toBe("connected")
    expect(status.host).toEqual({ version: "2.3.0-beta.1", range: ">=2.2.3 <2.3.0", tested: false })
    expect(formatStatus(status)).toContain("OpenCode: 2.3.0-beta.1 (untested; tested range >=2.2.3 <2.3.0)")
  })

  test("an untested host the user allowed, with invalid options, reports the options, not the allowance", () => {
    const parsed = parseOptions({ allowUntestedHost: true, oauth: { client_id: "C1", redirect_port: 8765 } })
    const status = buildStatus(input({ hostVersion: "2.3.0", hostTested: false, active: false, parsed }))
    expect(status).toMatchObject({
      state: "config_invalid",
      code: "OPTIONS_INVALID",
      message: "Option oauth.redirect_port: This option is not supported.",
      next: "Use oauth.redirect_uri instead, for example http://localhost:8765/callback.",
      host: { version: "2.3.0", range: ">=2.2.3 <2.3.0", tested: false },
    })
    expect(formatStatus(status)).not.toContain("allowUntestedHost")
    expect(formatStatus(status)).toContain("OpenCode: 2.3.0 (untested; tested range >=2.2.3 <2.3.0)")
  })

  test("the connection is read from the configured server name", () => {
    const parsed = parseOptions({ oauth: { client_id: "C1" }, server: "work-slack" })
    const status = buildStatus(input({
      parsed,
      servers: [{ name: "slack", status: { status: "connected" } }, { name: "work-slack", status: { status: "disabled" } }],
      agents: [{ id: "build", permissions: guarded("work-slack") }],
    }))
    expect(status.server).toEqual({ name: "work-slack", url: "https://mcp.slack.com/mcp" })
    expect(status.state).toBe("disabled")
    expect(status.next).toBe("Enable work-slack in /mcps.")
  })
})

describe("buildStatus details", () => {
  test("shows the client, callback and scopes from valid options", () => {
    expect(buildStatus(input())).toMatchObject({
      client: { id: "C1", mode: "public_pkce", source: "options" },
      callback: "http://localhost:8765/callback",
      scopes: ["channels:history", "channels:read", "search:read.public", "users:read"],
      asksBefore: ["searching private channels", "reading files", "writes: messages, drafts, schedules, reactions, canvases, lists, new conversations and file uploads", "Slack tools this plugin does not know yet"],
      host: { version: "2.2.3", range: ">=2.2.3 <2.3.0", tested: true },
    })
  })

  test("invalid options show no client, callback or scopes", () => {
    const status = buildStatus(input({ parsed: INVALID, active: false }))
    expect(Object.keys(status)).not.toContain("client")
    expect(Object.keys(status)).not.toContain("callback")
    expect(Object.keys(status)).not.toContain("scopes")
  })

  test("a confidential client shows its mode and never the secret", () => {
    for (const [, given] of STATES) {
      const status = buildStatus({ ...given, client: given.client.client === undefined ? given.client : CONFIDENTIAL })
      expect(JSON.stringify(status)).not.toContain(SECRET)
      expect(formatStatus(status)).not.toContain(SECRET)
    }
    expect(buildStatus(input({ client: CONFIDENTIAL })).client).toEqual({ id: "C1", mode: "confidential", source: "connect" })
  })

  test("counts the server's tools by class and names unknown ones in order", () => {
    const tool = (name: string, namespace?: string) => (namespace === undefined ? { name } : { name, options: { namespace } })
    const status = buildStatus(input({
      tools: [
        tool("slack_search_public", "slack"),
        tool("slack_read_thread", "slack"),
        tool("slack_read_canvas", "slack"),
        tool("slack_search_public_and_private", "slack"),
        tool("slack_read_file", "slack"),
        tool("slack_send_message", "slack"),
        tool("slack_update_canvas", "slack"),
        tool("slack_zeta_new", "slack"),
        tool("slack_alpha_new", "slack"),
        tool("slack_search_public", "slack_extra"),
        tool("create_issue", "github"),
        tool("read"),
      ],
    }))
    expect(status.tools).toEqual({ read: 3, private: 1, file: 1, write: 2, unknown: ["slack_alpha_new", "slack_zeta_new"] })
    expect(status.message).toBe("Connected. Slack tools available: 9.")
    expect(formatStatus(status)).toContain("Tools: 3 read, 1 private search, 1 file, 2 write; unknown (ask first): slack_alpha_new, slack_zeta_new")
  })
})

describe("unguarded agents", () => {
  const agents = [
    { id: "build", permissions: guarded() },
    { id: "explore", permissions: [...guarded(), deny("*"), allow("read")] },
    { id: "locked", permissions: [deny("*")] },
    { id: "asks", permissions: [] },
    { id: "custom", permissions: [...BASE_RULES] },
    { id: "loose", permissions: [...guarded(), allow("slack_*")] },
    { id: "reopened", permissions: [...guarded(), BASE_ALLOW] },
    { id: "fixed", permissions: [...BASE_RULES, deny("slack_slack_search_public"), ...defaultRules("slack"), deny("slack_slack_search_public")] },
  ]

  test("names agents that would run an unknown Slack tool without asking", () => {
    expect(buildStatus(input({ agents })).unguardedAgents).toEqual(["custom", "loose", "reopened"])
  })

  test("checks against the configured server name", () => {
    const parsed = parseOptions({ oauth: { client_id: "C1" }, server: "work-slack" })
    const status = buildStatus(input({ parsed, servers: [{ name: "work-slack", status: { status: "connected" } }], agents }))
    expect(status.unguardedAgents).toEqual(["build", "custom", "loose", "reopened", "fixed"])
  })

  test("is empty when the plugin registered nothing", () => {
    expect(buildStatus(input({ agents, parsed: INVALID, active: false })).unguardedAgents).toEqual([])
    expect(buildStatus(input({ agents, hostTested: false, active: false })).unguardedAgents).toEqual([])
  })

  test("the next step names them once connected", () => {
    expect(buildStatus(input({ agents })).next).toBe(
      'Put the default Slack rules shown under "Agents without default rules" first in each of these agents\' own permissions (agents.<name>.permissions), so they ask before Slack writes: custom, loose, reopened.',
    )
  })

  test("the fix puts the plugin's block in each agent's own permissions, never the top level", () => {
    const rows = statusRows(buildStatus(input({ agents: [{ id: "custom", permissions: [...BASE_RULES] }] })))
    const row = rows.find((item) => item.label === "Agents without default rules")
    expect(row?.value).toStartWith("These agents run Slack writes and unknown tools without asking: custom. ")
    expect(row?.value).toContain(`put these rules first in each agent's own "permissions" list (agents.<name>.permissions): `)
    expect(row?.value).toContain("Follow them with your top-level rules for slack_ actions, so yours keep winning.")
    expect(row?.value).toEndWith('Do not add them to the top-level "permissions": there they would loosen stricter agents such as explore.')
    const block = /: (\[.*\])\. Follow/.exec(row?.value ?? "")?.[1]
    expect(JSON.parse(block ?? "null")).toEqual(defaultRules("slack"))
  })

  test("following the fix guards the agent", () => {
    // The user's own top-level rule for a Slack tool, then the plugin's block, then that rule repeated, as the fix says.
    const fixed = [...BASE_RULES, deny("slack_slack_search_public"), ...defaultRules("slack"), deny("slack_slack_search_public")]
    expect(buildStatus(input({ agents: [{ id: "custom", permissions: fixed }] })).unguardedAgents).toEqual([])
  })

  test("no unguarded agents, no row", () => {
    expect(statusRows(buildStatus(input())).map((row) => row.label)).not.toContain("Agents without default rules")
  })
})

describe("stateLabel", () => {
  test.each([
    ["no sign-in", "sign-in required"],
    ["a pending connection", "connecting"],
    ["a disabled server", "disabled"],
    ["a failed connection", "failed"],
    ["a server name in use", "conflict"],
    ["a server the host does not list", "failed"],
    ["no client ID", "not configured"],
    ["invalid options", "not configured"],
    ["an untested host", "host untested"],
    ["a connection", "connected"],
  ])("%s reads %s", (label, expected) => {
    expect(stateLabel(buildStatus(STATES.find(([name]) => name === label)![1]))).toBe(expected)
  })
})

describe("formatStatus", () => {
  test("not signed in, as /slack-status posts it", () => {
    const status = buildStatus(input({ servers: [{ name: "slack", status: { status: "needs_auth", error: "Authentication required" } }] }))
    expect(formatStatus(status)).toBe([
      "Slack",
      "Connection: sign-in required. AUTH_REQUIRED: Sign in to Slack to use it in OpenCode. Authentication required",
      "Account: Slack shows the account on its sign-in page; OpenCode does not store it.",
      'Access: Reads run without asking. Asks before searching private channels; reading files; writes: messages, drafts, schedules, reactions, canvases, lists, new conversations and file uploads; Slack tools this plugin does not know yet. To allow one, choose "Always allow" when asked, or add a permissions rule such as { "action": "slack_slack_read_file", "resource": "*", "effect": "allow" }.',
      "Server: slack at https://mcp.slack.com/mcp",
      "Client: C1 (public, PKCE; set in plugin options)",
      "Callback: http://localhost:8765/callback (register exactly this URL in the Slack app)",
      "Scopes: channels:history channels:read search:read.public users:read",
      "Tools: 0 read, 0 private search, 0 file, 0 write",
      "OpenCode: 2.2.3 (tested; tested range >=2.2.3 <2.3.0)",
      `Next step: ${SIGN_IN}`,
    ].join("\n"))
  })

  test.each(STATES)("%s: the connection label and code first, the rows in order, and one next step last", (_label, given) => {
    const status = buildStatus(given)
    const lines = formatStatus(status).split("\n")
    expect(lines[0]).toBe("Slack")
    expect(lines[1]).toBe(`Connection: ${stateLabel(status)}. ${status.code === undefined ? "" : `${status.code}: `}${status.message}${status.detail === undefined ? "" : ` ${status.detail}`}`)
    const labels = lines.slice(1).map((line) => line.slice(0, line.indexOf(":")))
    const order = ["Connection", "Account", "Access", "Server", "Client", "Callback", "Scopes", "Tools", "Agents without default rules", "OpenCode", "Next step"]
    expect(labels).toEqual(order.filter((label) => labels.includes(label)))
    expect(lines.filter((line) => line.startsWith("Next step: "))).toEqual([`Next step: ${status.next}`])
    expect(lines.at(-1)).toBe(`Next step: ${status.next}`)
    expect(lines.filter((line) => line.startsWith("Client: ")).length).toBe(given.parsed.ok && given.active && given.client.client !== undefined ? 1 : 0)
  })

  test("a confidential client from /connect says a secret is set and where it was saved", () => {
    expect(formatStatus(buildStatus(input({ client: CONFIDENTIAL })))).toContain("Client: C1 (confidential, secret set; saved in /connect)")
  })

  test("the allow example uses the configured server name", () => {
    const parsed = parseOptions({ oauth: { client_id: "C1" }, server: "work-slack" })
    expect(formatStatus(buildStatus(input({ parsed })))).toContain('{ "action": "work-slack_slack_read_file", "resource": "*", "effect": "allow" }')
  })
})

describe("the status RPC contract", () => {
  type Schema = { type?: string; enum?: readonly string[]; properties?: Record<string, Schema>; required?: readonly string[]; additionalProperties?: boolean; items?: Schema }

  // The subset of JSON Schema the contract uses. A field that is present but undefined fails, as on the host.
  function problems(value: unknown, schema: Schema, path = "$"): string[] {
    if (value === undefined) return [`${path} is undefined`]
    if (schema.enum !== undefined) return schema.enum.includes(value as string) ? [] : [`${path} is not one of ${schema.enum.join(", ")}`]
    switch (schema.type) {
      case "string": return typeof value === "string" ? [] : [`${path} is not a string`]
      case "integer": return Number.isInteger(value) ? [] : [`${path} is not an integer`]
      case "boolean": return typeof value === "boolean" ? [] : [`${path} is not a boolean`]
      case "array": return Array.isArray(value) ? value.flatMap((item, index) => problems(item, schema.items ?? {}, `${path}[${index}]`)) : [`${path} is not an array`]
      case "object": {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return [`${path} is not an object`]
        const record = value as Record<string, unknown>
        const properties = schema.properties ?? {}
        return [
          ...(schema.required ?? []).filter((key) => !(key in record)).map((key) => `${path}.${key} is missing`),
          ...Object.keys(record).flatMap((key) => properties[key] === undefined
            ? (schema.additionalProperties === false ? [`${path}.${key} is not allowed`] : [])
            : problems(record[key], properties[key], `${path}.${key}`)),
        ]
      }
      default: return [`${path} has an unsupported schema`]
    }
  }

  const output = SlackRpc.methods.status.output as Schema

  test.each(STATES)("%s matches the output schema and survives JSON", (_label, given) => {
    for (const client of [given.client, CONFIDENTIAL]) {
      const status = buildStatus({ ...given, client, agents: [{ id: "custom", permissions: [...BASE_RULES] }] })
      expect(problems(status, output)).toEqual([])
      expect(JSON.parse(JSON.stringify(status))).toEqual(status)
      expect(isStatus(status)).toBe(true)
    }
  })

  test.each([
    ["null", null],
    ["a string", "connected"],
    ["an empty object", {}],
    ["a status without next", (({ next: _next, ...rest }: Status) => rest)(buildStatus(input()))],
    ["a status with a numeric state", { ...buildStatus(input()), state: 1 }],
  ])("isStatus rejects %s", (_label, value) => {
    expect(isStatus(value)).toBe(false)
  })
})
