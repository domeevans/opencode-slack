import { describe, expect, test } from "bun:test"
import type { ClientState } from "../../src/connect.js"
import { parseOptions } from "../../src/options.js"
import { defaultRules, type Rule } from "../../src/permissions.js"
import { isStatus, SlackRpc } from "../../src/rpc.js"
import { buildStatus, formatStatus, shortReason, stateLabel, statusRows, type Status, type StatusInput } from "../../src/status.js"
import { BASE_ALLOW, BASE_RULES } from "./fakes.js"

const OK = parseOptions({ oauth: { client_id: "C1" } })
const SECRET = "zz-client-secret-7c1e"
const C1: ClientState = { client: { id: "C1", source: "options" }, invalid: false }
const CONFIDENTIAL: ClientState = { client: { id: "C1", secret: SECRET, source: "connect" }, invalid: false }
const INVALID = parseOptions({ oauth: { bogus: 1 } })

const guarded = (): Rule[] => [BASE_ALLOW, ...defaultRules(), ...BASE_RULES.slice(1)]
const deny = (action: string): Rule => ({ action, resource: "*", effect: "deny" })
const allow = (action: string): Rule => ({ action, resource: "*", effect: "allow" })

function input(overrides: Partial<StatusInput> = {}): StatusInput {
  return {
    version: "9.9.9",
    hostVersion: "2.2.3",
    hostSupported: true,
    hostTested: true,
    parsed: OK,
    active: true,
    nameInUse: false,
    client: C1,
    servers: [{ name: "slack", status: { status: "connected" } }],
    tools: [],
    agents: [{ id: "build", permissions: guarded() }],
    shadowedSkills: [],
    ...overrides,
  }
}

const SIGN_IN = "Run /connect and choose Slack, then press o or Enter to open the sign-in page (in a terminal, opencode mcp auth slack opens the browser automatically)."
const NO_CLIENT_NEXT = "Run /connect and choose Slack app client ID, then paste your Slack app's client ID."
const AGENT_FIX = "Put the default rules shown by /slack-status first in each listed agent's own permissions, in opencode.json or the agent's Markdown file, followed by your top-level rules for Slack tools."

// Every state and error code, with the exact message and next step each surface shows.
const STATES: readonly (readonly [string, StatusInput, Pick<Status, "state" | "code" | "message" | "nextStep" | "detail">])[] = [
  ["an untested host", input({ hostVersion: "2.1.0", hostSupported: false, hostTested: false, active: false }), {
    state: "host_untested",
    code: "HOST_UNTESTED",
    message: "OpenCode 2.1.0 is outside the supported range >=2.2.3 <2.3.0, so Slack is not set up.",
    nextStep: 'Use OpenCode >=2.2.3 <2.3.0, or set "allowUntestedHost": true in this plugin\'s options to run anyway.',
  }],
  ["an untested host with invalid options", input({ hostVersion: "0.0.0-dev-1", hostSupported: false, hostTested: false, active: false, parsed: INVALID }), {
    state: "not_configured",
    code: "OPTIONS_INVALID",
    message: "Option oauth.bogus: This option is not supported.",
    nextStep: "Remove it. Supported oauth options: client_id, redirect_uri, callback_port, scopes, client_secret.",
  }],
  ["invalid options", input({ parsed: INVALID, active: false }), {
    state: "not_configured",
    code: "OPTIONS_INVALID",
    message: "Option oauth.bogus: This option is not supported.",
    nextStep: "Remove it. Supported oauth options: client_id, redirect_uri, callback_port, scopes, client_secret.",
  }],
  ["no client ID", input({ client: { invalid: false } }), {
    state: "not_configured",
    code: "CLIENT_ID_MISSING",
    message: "No Slack app client ID is set, so Slack is not added. To create the app, use the manifest at https://github.com/joe-broadhead/opencode-slack/blob/HEAD/docs/slack-app-manifest.json.",
    nextStep: NO_CLIENT_NEXT,
  }],
  ["an unusable saved client ID", input({ client: { invalid: true } }), {
    state: "not_configured",
    code: "CLIENT_ID_INVALID",
    message: "The client ID saved in the /connect Slack app client ID entry is empty or has spaces, so Slack is not added.",
    nextStep: NO_CLIENT_NEXT,
  }],
  ["a server name in use", input({ nameInUse: true }), {
    state: "conflict",
    code: "SERVER_NAME_IN_USE",
    message: 'Another MCP server is already named "slack", so Slack was not added.',
    nextStep: "Remove mcp.servers.slack from your OpenCode config.",
  }],
  ["a server the host does not list", input({ servers: [] }), {
    state: "failed",
    message: "The slack server is not registered.",
    nextStep: "Run opencode reload, then check again.",
  }],
  ["a pending connection", input({ servers: [{ name: "slack", status: { status: "pending" } }] }), {
    state: "connecting",
    message: "Connecting to Slack.",
    nextStep: "Wait a few seconds, then run /slack-status again (or press r in /slack).",
  }],
  ["a disabled server", input({ servers: [{ name: "slack", status: { status: "disabled" } }] }), {
    state: "disabled",
    code: "SERVER_DISABLED",
    message: "The slack server is disabled.",
    nextStep: "Enable slack in /mcps.",
  }],
  ["no sign-in", input({ servers: [{ name: "slack", status: { status: "needs_auth", error: "Authentication required: https://slack.com/oauth/v2/authorize?client_id=C1&state=s3cret" } }] }), {
    state: "sign_in_required",
    code: "AUTH_REQUIRED",
    message: "Sign in to Slack to use it in OpenCode.",
    nextStep: SIGN_IN,
  }],
  ["a failed connection", input({ servers: [{ name: "slack", status: { status: "failed", error: "invalid_client_id" } }] }), {
    state: "failed",
    code: "CONNECTION_FAILED",
    message: "Could not connect to Slack.",
    detail: "invalid_client_id",
    nextStep: "Fix the error shown, then reconnect slack in /mcps.",
  }],
  ["a connection", input(), {
    state: "connected",
    message: "Connected. Slack tools available: 0.",
    nextStep: "Nothing to do.",
  }],
]

describe("buildStatus states", () => {
  test.each(STATES)("%s", (_label, given, expected) => {
    const status = buildStatus(given)
    expect({ state: status.state, code: status.code, message: status.message, nextStep: status.nextStep, detail: status.detail })
      .toEqual({ code: undefined, detail: undefined, ...expected })
  })

  test("covers every state and error code in the RPC contract", () => {
    const output = SlackRpc.methods.status.output as unknown as { properties: { state: { enum: string[] }; code: { enum: string[] } } }
    const statuses = STATES.map(([, given]) => buildStatus(given))
    expect(new Set<string>(statuses.map((status) => status.state))).toEqual(new Set(output.properties.state.enum))
    expect(new Set<string>(statuses.flatMap((status) => status.code ?? []))).toEqual(new Set(output.properties.code.enum))
  })

  test("an untested host the user allowed proceeds to the connection state and still reports the host", () => {
    const status = buildStatus(input({ hostVersion: "2.3.0-beta.1", hostSupported: false, hostTested: false }))
    expect(status.state).toBe("connected")
    expect(status.host).toEqual({ version: "2.3.0-beta.1", range: ">=2.2.3 <2.3.0", tested: false })
    expect(formatStatus(status)).toContain("OpenCode: 2.3.0-beta.1 (untested; supported range >=2.2.3 <2.3.0)")
  })

  test("an untested host the user allowed, with invalid options, reports the options, not the allowance", () => {
    const parsed = parseOptions({ allowUntestedHost: true, oauth: { client_id: "C1", bogus: 1 } })
    const status = buildStatus(input({ hostVersion: "2.3.0", hostSupported: false, hostTested: false, active: false, parsed }))
    expect(status).toMatchObject({
      state: "not_configured",
      code: "OPTIONS_INVALID",
      message: "Option oauth.bogus: This option is not supported.",
      nextStep: "Remove it. Supported oauth options: client_id, redirect_uri, callback_port, scopes, client_secret.",
      host: { version: "2.3.0", range: ">=2.2.3 <2.3.0", tested: false },
    })
    expect(formatStatus(status)).not.toContain("allowUntestedHost")
    expect(formatStatus(status)).toContain("OpenCode: 2.3.0 (untested; supported range >=2.2.3 <2.3.0)")
  })

  test("a release inside the supported range that the checks do not run on proceeds, and says it is untested", () => {
    const status = buildStatus(input({ hostVersion: "2.2.99", hostSupported: true, hostTested: false }))
    expect(status).toMatchObject({ state: "connected", nextStep: "Nothing to do.", host: { version: "2.2.99", range: ">=2.2.3 <2.3.0", tested: false } })
    expect(formatStatus(status)).toContain("OpenCode: 2.2.99 (untested; supported range >=2.2.3 <2.3.0)")
  })

  test("each tested release reads tested, with the supported range", () => {
    for (const version of ["2.2.3", "2.2.4", "2.2.5", "2.2.6"])
      expect(formatStatus(buildStatus(input({ hostVersion: version })))).toContain(`OpenCode: ${version} (tested; supported range >=2.2.3 <2.3.0)`)
  })

  test("carries the plugin's version, and a host that reports no version as null", () => {
    expect(buildStatus(input()).version).toBe("9.9.9")
    const status = buildStatus(input({ hostVersion: "", hostSupported: false, hostTested: false, active: false }))
    expect(status).toMatchObject({ state: "host_untested", host: { version: null } })
    expect(status.message).toBe("OpenCode of an unknown version is outside the supported range >=2.2.3 <2.3.0, so Slack is not set up.")
    expect(formatStatus(status)).toContain("OpenCode: unknown version (untested; supported range >=2.2.3 <2.3.0)")
  })

  test("never shows the host's text for a needed sign-in, which can carry an authorization URL", () => {
    const status = buildStatus(input({ servers: [{ name: "slack", status: { status: "needs_auth", error: "Visit https://slack.com/oauth/v2/authorize?client_id=C1&state=s3cret" } }] }))
    expect(Object.keys(status)).not.toContain("detail")
    expect(formatStatus(status)).not.toContain("slack.com/oauth")
  })

  test("shows a failure as one short line, with URLs cut before their query", () => {
    const error = `invalid_client\n  at https://mcp.slack.com/mcp?token=xoxp-secret&sig=abc ${"x".repeat(300)}`
    const status = buildStatus(input({ servers: [{ name: "slack", status: { status: "failed", error } }] }))
    expect(status.detail).toStartWith("invalid_client at https://mcp.slack.com/mcp ")
    expect(status.detail).toHaveLength(160)
    expect(status.detail).toEndWith("…")
    expect(status.detail).not.toContain("\n")
    for (const hidden of ["xoxp-secret", "sig=abc"]) expect(formatStatus(status)).not.toContain(hidden)
    expect(shortReason("  \n ")).toBeUndefined()
    expect(shortReason("ECONNREFUSED: Unable to connect.")).toBe("ECONNREFUSED: Unable to connect")
    expect(Object.keys(buildStatus(input({ servers: [{ name: "slack", status: { status: "failed", error: "" } }] })))).not.toContain("detail")
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

  test("an https callback carries its listener port, and the row says where to forward it", () => {
    const parsed = parseOptions({ oauth: { client_id: "C1", redirect_uri: "https://host.example/oauth/return", callback_port: 49200 } })
    const status = buildStatus(input({ parsed }))
    expect(status).toMatchObject({ callback: "https://host.example/oauth/return", callbackPort: 49200 })
    expect(statusRows(status).find((row) => row.label === "Callback")?.value)
      .toBe("https://host.example/oauth/return (register exactly this URL in the app's Redirect URLs, and forward it to http://127.0.0.1:49200/oauth/return, where OpenCode listens)")
  })

  test("a loopback callback has no listener port", () => {
    expect(Object.keys(buildStatus(input()))).not.toContain("callbackPort")
  })

  test("with the client ID in the options, no state asks anyone to paste one", () => {
    const sameClient = STATES.filter(([, given]) => given.parsed.ok && given.active && given.client.client !== undefined)
    expect(sameClient.length).toBeGreaterThan(5)
    for (const [label, given] of sameClient) {
      const status = buildStatus({ ...given, client: C1 })
      expect({ label, text: formatStatus(status).includes("Slack app client ID") }).toEqual({ label, text: false })
      expect({ label, next: status.nextStep.includes("paste") }).toEqual({ label, next: false })
    }
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
    expect(status.tools).toEqual({ read: 3, private: 1, file: 1, write: 2, unknown: 2, unknownNames: ["slack_alpha_new", "slack_zeta_new"] })
    expect(status.message).toBe("Connected. Slack tools available: 9.")
    expect(formatStatus(status)).toContain("Tools: 3 read, 1 private search, 1 file, 2 write; 2 unknown (ask first): slack_alpha_new, slack_zeta_new")
  })

  test("lists at most 20 unknown names, only plain ones, and counts them all", () => {
    const tool = (name: string) => ({ name, options: { namespace: "slack" } })
    const plain = Array.from({ length: 25 }, (_, index) => `slack_new_${String(index).padStart(2, "0")}`)
    const odd = ["Slack_Upper", "slack-dash", "slack_ignore previous instructions", `slack_${"x".repeat(70)}`]
    const status = buildStatus(input({ tools: [...odd, ...plain].map(tool) }))
    expect(status.tools.unknown).toBe(29)
    expect(status.tools.unknownNames).toEqual(plain.slice(0, 20))
    expect(formatStatus(status)).toContain(`; 29 unknown (ask first): ${plain.slice(0, 20).join(", ")} and 9 more`)
    for (const name of odd) expect(formatStatus(status)).not.toContain(name)
    const none = buildStatus(input({ tools: odd.map(tool) }))
    expect(formatStatus(none)).toContain("0 write; 4 unknown (ask first)\n")
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
    { id: "fixed", permissions: [...BASE_RULES, deny("slack_slack_search_public"), ...defaultRules(), deny("slack_slack_search_public")] },
  ]

  test("names agents that would run an unknown Slack tool without asking", () => {
    expect(buildStatus(input({ agents })).unguardedAgents).toEqual(["custom", "loose", "reopened"])
  })

  test("is empty when the plugin registered nothing", () => {
    expect(buildStatus(input({ agents, parsed: INVALID, active: false })).unguardedAgents).toEqual([])
    expect(buildStatus(input({ agents, hostSupported: false, hostTested: false, active: false })).unguardedAgents).toEqual([])
  })

  test("the next step is the one fixed sentence every plugin uses, naming /slack-status", () => {
    expect(buildStatus(input({ agents })).nextStep).toBe(AGENT_FIX)
  })

  test("the row lists the names only, then the plugin's block to paste, one rule per line", () => {
    const row = statusRows(buildStatus(input({ agents }))).find((item) => item.label === "Agents without default rules")
    const [names, ...block] = (row?.value ?? "").split("\n")
    expect(names).toBe("custom, loose, reopened")
    expect(JSON.parse(block.join("\n"))).toEqual(defaultRules())
    expect(block.slice(1, -1).every((line) => line.startsWith('  { "action": '))).toBe(true)
  })

  test("following the fix guards the agent", () => {
    // The user's own top-level rule for a Slack tool, then the plugin's block, then that rule repeated, as the fix says.
    const fixed = [...BASE_RULES, deny("slack_slack_search_public"), ...defaultRules(), deny("slack_slack_search_public")]
    expect(buildStatus(input({ agents: [{ id: "custom", permissions: fixed }] })).unguardedAgents).toEqual([])
  })

  test("no unguarded agents: the row says none", () => {
    for (const [label, given] of STATES)
      expect({ label, row: statusRows(buildStatus(given)).find((row) => row.label === "Agents without default rules")?.value }).toEqual({ label, row: "none" })
  })

  test("an agent whose own rules already ask or deny for every Slack tool is not listed", () => {
    const asks = [BASE_ALLOW, { action: "*", resource: "*", effect: "ask" } as Rule]
    const denies = [BASE_ALLOW, deny("slack_*")]
    expect(buildStatus(input({ agents: [{ id: "probe", permissions: asks }, { id: "quiet", permissions: denies }] })).unguardedAgents).toEqual([])
  })
})

describe("a shadowed skill", () => {
  const shadowed = [{ id: "slack-search", path: "/home/u/.config/opencode/skills/slack-search/SKILL.md" }]
  const MOVE = "Move or rename the skill at /home/u/.config/opencode/skills/slack-search/SKILL.md, so that this plugin's slack-search skill loads, then run opencode reload."

  test("connected: the Skills row names the file, and the next step moves it", () => {
    const status = buildStatus(input({ shadowedSkills: shadowed }))
    expect(status).toMatchObject({ state: "connected", shadowedSkills: shadowed, nextStep: MOVE })
    expect(statusRows(status).find((row) => row.label === "Skills")?.value)
      .toBe("slack-search is shadowed by /home/u/.config/opencode/skills/slack-search/SKILL.md, so agents load that file instead of this plugin's skill")
  })

  test("unguarded agents come first, and a connection problem before both", () => {
    expect(buildStatus(input({ shadowedSkills: shadowed, agents: [{ id: "custom", permissions: [...BASE_RULES] }] })).nextStep).toBe(AGENT_FIX)
    expect(buildStatus(input({ shadowedSkills: shadowed, servers: [] })).nextStep).toBe("Run opencode reload, then check again.")
  })

  test("no Skills row when nothing is shadowed", () => {
    expect(statusRows(buildStatus(input())).map((row) => row.label)).not.toContain("Skills")
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
      "Connection: sign-in required. AUTH_REQUIRED: Sign in to Slack to use it in OpenCode.",
      "Account: Slack shows the account on its sign-in page; OpenCode does not store it.",
      'Access: Reads run without asking. Asks before searching private channels; reading files; writes: messages, drafts, schedules, reactions, canvases, lists, new conversations and file uploads; Slack tools this plugin does not know yet. To allow one, choose "Always allow" when asked, or add a permissions rule such as { "action": "slack_slack_read_file", "resource": "*", "effect": "allow" }.',
      "Server: slack at https://mcp.slack.com/mcp",
      "Client: C1 (public, PKCE; set in plugin options)",
      "Callback: http://localhost:8765/callback (register exactly this URL in the app's Redirect URLs)",
      "Scopes: channels:history channels:read search:read.public users:read",
      "Tools: 0 read, 0 private search, 0 file, 0 write",
      "Agents without default rules: none",
      "OpenCode: 2.2.3 (tested; supported range >=2.2.3 <2.3.0)",
      `Next step: ${SIGN_IN}`,
    ].join("\n"))
  })

  test.each(STATES)("%s: the connection label and code first, the rows in order, and one next step last", (_label, given) => {
    const status = buildStatus(given)
    const lines = formatStatus(status).split("\n")
    expect(lines[0]).toBe("Slack")
    expect(lines[1]).toBe(`Connection: ${stateLabel(status)}. ${status.code === undefined ? "" : `${status.code}: `}${status.message}${status.detail === undefined ? "" : ` ${status.detail}`}`)
    const labels = lines.slice(1).map((line) => line.slice(0, line.indexOf(":")))
    const order = ["Connection", "Account", "Access", "Server", "Client", "Callback", "Scopes", "Skills", "Tools", "Agents without default rules", "OpenCode", "Next step"]
    expect(labels).toEqual(order.filter((label) => labels.includes(label)))
    // The shared rows are always there, with "none" where there is nothing to show.
    for (const label of ["Connection", "Account", "Access", "Tools", "Agents without default rules", "OpenCode", "Next step"]) expect(labels).toContain(label)
    expect(lines.filter((line) => line.startsWith("Next step: "))).toEqual([`Next step: ${status.nextStep}`])
    expect(lines.at(-1)).toBe(`Next step: ${status.nextStep}`)
    expect(lines.filter((line) => line.startsWith("Client: ")).length).toBe(given.parsed.ok && given.active && given.client.client !== undefined ? 1 : 0)
  })

  test("a confidential client from /connect says a secret is set and where it was saved", () => {
    expect(formatStatus(buildStatus(input({ client: CONFIDENTIAL })))).toContain("Client: C1 (confidential, secret set; saved in /connect)")
  })
})

describe("the status RPC contract", () => {
  type Schema = { type?: string | readonly string[]; enum?: readonly string[]; properties?: Record<string, Schema>; required?: readonly string[]; additionalProperties?: boolean; items?: Schema }

  // The subset of JSON Schema the contract uses. A field that is present but undefined fails, as on the host.
  function problems(value: unknown, schema: Schema, path = "$"): string[] {
    if (value === undefined) return [`${path} is undefined`]
    if (schema.enum !== undefined) return schema.enum.includes(value as string) ? [] : [`${path} is not one of ${schema.enum.join(", ")}`]
    if (Array.isArray(schema.type)) {
      const options = schema.type.map((type) => (type === "null" ? (value === null ? [] : [`${path} is not null`]) : problems(value, { ...schema, type }, path)))
      return options.some((found) => found.length === 0) ? [] : options.flat()
    }
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

  test("an https callback with its listener port matches the output schema", () => {
    const parsed = parseOptions({ oauth: { client_id: "C1", redirect_uri: "https://host.example/oauth/return", callback_port: 49200 } })
    const status = buildStatus(input({ parsed }))
    expect(status.callbackPort).toBe(49200)
    expect(problems(status, output)).toEqual([])
  })

  test.each([
    ["null", null],
    ["a string", "connected"],
    ["an empty object", {}],
    ["a status without nextStep", (({ nextStep: _next, ...rest }: Status) => rest)(buildStatus(input()))],
    ["a status with the old next instead of nextStep", (({ nextStep, ...rest }: Status) => ({ ...rest, next: nextStep }))(buildStatus(input()))],
    ["a status with a numeric state", { ...buildStatus(input()), state: 1 }],
  ])("isStatus rejects %s", (_label, value) => {
    expect(isStatus(value)).toBe(false)
  })
})
