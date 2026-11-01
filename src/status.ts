import { appDisplayName, serverDisplayName, type ClientState } from "./connect.js"
import { APP_MANIFEST_URL, DEFAULT_SERVER, SLACK_MCP_URL, TESTED_HOST_RANGE } from "./defaults.js"
import type { ParsedOptions } from "./options.js"
import { defaultRules, type Rule } from "./permissions.js"
import { classify } from "./tools.js"

export type State =
  | "connected"
  | "not_signed_in"
  | "connecting"
  | "disabled"
  | "failed"
  | "not_registered"
  | "no_client_id"
  | "config_invalid"
  | "host_untested"

export type ErrorCode =
  | "OPTIONS_INVALID"
  | "SERVER_NAME_IN_USE"
  | "HOST_UNTESTED"
  | "CLIENT_ID_MISSING"
  | "CLIENT_ID_INVALID"
  | "AUTH_REQUIRED"
  | "CONNECTION_FAILED"
  | "SERVER_DISABLED"

/** What every status surface shows. JSON-safe; never contains a client secret or token. */
export interface Status {
  readonly state: State
  readonly code?: ErrorCode
  readonly message: string
  /** The host's error text for a failed or signed-out connection. */
  readonly detail?: string
  /** Exactly one action for the user. */
  readonly next: string
  readonly server: { readonly name: string; readonly url: string }
  readonly client?: { readonly id: string; readonly mode: "public_pkce" | "confidential"; readonly source: "options" | "connect" }
  readonly callback?: string
  readonly scopes?: readonly string[]
  readonly asksBefore: readonly string[]
  readonly tools: {
    readonly read: number
    readonly private: number
    readonly file: number
    readonly write: number
    readonly unknown: readonly string[]
  }
  /** Agents that would run an unknown Slack tool without asking, such as agents defined only in user config. */
  readonly unguardedAgents: readonly string[]
  readonly host: { readonly version: string; readonly range: string; readonly tested: boolean }
}

export type ServerStatus =
  | { readonly status: "connected" | "pending" | "disabled" }
  | { readonly status: "failed" | "needs_auth"; readonly error: string }

export interface StatusInput {
  readonly hostVersion: string
  readonly hostTested: boolean
  readonly parsed: ParsedOptions
  /** False when the host check or the options stopped the plugin from registering anything. */
  readonly active: boolean
  readonly nameInUse: boolean
  readonly client: ClientState
  readonly servers: readonly { readonly name: string; readonly status: ServerStatus }[]
  readonly tools: readonly { readonly name: string; readonly options?: { readonly namespace?: string } }[]
  readonly agents: readonly { readonly id: string; readonly permissions: readonly Rule[] }[]
}

/** What `/slack-status` and the RPC error say when the host cannot answer. */
export const UNAVAILABLE = "STATUS_UNAVAILABLE: Slack status is unavailable. Next step: Run /slack-status again in a moment."

const ASKS_BEFORE = [
  "searching private channels",
  "reading files",
  "writes: messages, drafts, schedules, reactions, canvases, lists, new conversations and file uploads",
  "Slack tools this plugin does not know yet",
] as const

/** Mirrors OpenCode's permission wildcard: `*` matches any text and `?` one character. */
function matches(value: string, pattern: string): boolean {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp(`^${source}$`, "s").test(value)
}

/** Last matching rule wins, and no match asks, as in OpenCode. MCP tools assert the resource `*`. */
function effect(rules: readonly Rule[], action: string): Rule["effect"] {
  return rules.findLast((rule) => matches(action, rule.action) && matches("*", rule.resource))?.effect ?? "ask"
}

/** An action no Slack tool can have: OpenCode limits tool names to letters, digits, `_` and `-`. */
const unknownAction = (server: string) => `${server}_.`

const NOTHING_TO_DO = "Nothing to do."

const quote = (rule: Rule) => `{ "action": "${rule.action}", "resource": "${rule.resource}", "effect": "${rule.effect}" }`

/**
 * The fix for unguarded agents: the plugin's own default rules in that agent's own permissions. Never the
 * top-level permissions, which apply after every agent's base rules and so would loosen stricter agents.
 */
const remedy = (server: string) => `[${defaultRules(server).map(quote).join(", ")}]`

function connection(server: string, status: ServerStatus | undefined, unguarded: readonly string[], toolCount: number) {
  if (status === undefined) {
    return { state: "not_registered" as const, message: `The ${server} server is not registered.`, next: "Run opencode reload, then check again." }
  }
  switch (status.status) {
    case "pending":
      return { state: "connecting" as const, message: "Connecting to Slack.", next: "Wait a few seconds, then refresh." }
    case "disabled":
      return { state: "disabled" as const, code: "SERVER_DISABLED" as const, message: `The ${server} server is disabled.`, next: `Enable ${server} in /mcps.` }
    case "needs_auth":
      return {
        state: "not_signed_in" as const, code: "AUTH_REQUIRED" as const, message: "Sign in to Slack to use it in OpenCode.", detail: status.error,
        next: `Run /connect and choose ${serverDisplayName(server)}, then press o or Enter to open the sign-in page (in a terminal, opencode mcp auth ${server} opens the browser automatically).`,
      }
    case "failed":
      return {
        state: "failed" as const, code: "CONNECTION_FAILED" as const, message: "Could not connect to Slack.", detail: status.error,
        next: `Fix the error shown, then reconnect ${server} in /mcps.`,
      }
    case "connected":
      return {
        state: "connected" as const, message: `Connected. Slack tools available: ${toolCount}.`,
        next: unguarded.length > 0
          ? `Put the default Slack rules shown under "Agents without default rules" first in each of these agents' own permissions (agents.<name>.permissions), so they ask before Slack writes: ${unguarded.join(", ")}.`
          : NOTHING_TO_DO,
      }
  }
}

export function buildStatus(input: StatusInput): Status {
  const options = input.parsed.ok ? input.parsed.options : undefined
  const server = options?.server ?? DEFAULT_SERVER
  const host = { version: input.hostVersion, range: TESTED_HOST_RANGE, tested: input.hostTested }
  const names = input.tools.filter((tool) => tool.options?.namespace === server).map((tool) => tool.name)
  const tools = {
    read: names.filter((name) => classify(name) === "read").length,
    private: names.filter((name) => classify(name) === "private").length,
    file: names.filter((name) => classify(name) === "file").length,
    write: names.filter((name) => classify(name) === "write").length,
    unknown: names.filter((name) => classify(name) === "unknown").sort(),
  }
  const unguardedAgents = input.active
    ? input.agents.filter((agent) => effect(agent.permissions, unknownAction(server)) === "allow").map((agent) => agent.id)
    : []
  const client = input.client.client
  const base = {
    server: { name: server, url: SLACK_MCP_URL },
    ...(options === undefined || !input.active ? {} : {
      ...(client === undefined ? {} : {
        client: { id: client.id, mode: client.secret === undefined ? "public_pkce" as const : "confidential" as const, source: client.source },
      }),
      callback: options.redirectUri,
      scopes: options.scopes,
    }),
    asksBefore: ASKS_BEFORE,
    tools,
    unguardedAgents,
    host,
  }
  // Invalid options come first: they need fixing on any host, and an untested host may already be allowed.
  if (!input.parsed.ok) {
    const { error } = input.parsed
    return { ...base, state: "config_invalid", code: error.code, message: `Option ${error.field}: ${error.message}`, next: error.next }
  }
  if (!input.active && !input.hostTested) {
    return {
      ...base, state: "host_untested", code: "HOST_UNTESTED",
      message: `OpenCode ${input.hostVersion} is outside the tested range ${TESTED_HOST_RANGE}, so Slack is not set up.`,
      next: `Use OpenCode ${TESTED_HOST_RANGE}, or set "allowUntestedHost": true in this plugin's options to run anyway.`,
    }
  }
  if (input.nameInUse) {
    return {
      ...base, state: "not_registered", code: "SERVER_NAME_IN_USE",
      message: `Another MCP server is already named "${server}", so Slack was not added.`,
      next: `Remove mcp.servers.${server} from your OpenCode config, or set this plugin's "server" option to another name.`,
    }
  }
  if (client === undefined) {
    const app = appDisplayName(server)
    return {
      ...base,
      state: "no_client_id",
      ...(input.client.invalid
        ? { code: "CLIENT_ID_INVALID" as const, message: `The client ID saved in the /connect ${app} entry is empty or has spaces, so Slack is not added.` }
        : { code: "CLIENT_ID_MISSING" as const, message: `No Slack app client ID is set, so Slack is not added. To create the app, use the manifest at ${APP_MANIFEST_URL}.` }),
      next: `Run /connect and choose ${app}, then paste your Slack app's client ID.`,
    }
  }
  const status = input.servers.find((item) => item.name === server)?.status
  return { ...base, ...connection(server, status, unguardedAgents, names.length) }
}

const CLIENT_SOURCE = { options: "set in plugin options", connect: "saved in /connect" } as const

/** The connection label people see. The RPC keeps the `state` ids. */
export function stateLabel(status: Status): string {
  switch (status.state) {
    case "not_signed_in": return "sign-in required"
    case "not_registered": return status.code === "SERVER_NAME_IN_USE" ? "conflict" : "failed"
    case "no_client_id":
    case "config_invalid": return "not configured"
    case "host_untested": return "host untested"
    default: return status.state
  }
}

/**
 * Labelled rows shared by `/slack-status` and the TUI dialog: Connection, Account, Access, the Slack app
 * settings, Tools, Agents without default rules, OpenCode, and exactly one Next step last.
 */
export function statusRows(status: Status): { readonly label: string; readonly value: string }[] {
  const { tools } = status
  const rows = [
    {
      label: "Connection",
      value: `${stateLabel(status)}. ${status.code === undefined ? "" : `${status.code}: `}${status.message}${status.detail === undefined ? "" : ` ${status.detail}`}`,
    },
    { label: "Account", value: "Slack shows the account on its sign-in page; OpenCode does not store it." },
    {
      label: "Access",
      value: `Reads run without asking. Asks before ${status.asksBefore.join("; ")}. To allow one, choose "Always allow" when asked, `
        + `or add a permissions rule such as ${quote({ action: `${status.server.name}_slack_read_file`, resource: "*", effect: "allow" })}.`,
    },
    { label: "Server", value: `${status.server.name} at ${status.server.url}` },
  ]
  if (status.client !== undefined) {
    const mode = status.client.mode === "public_pkce" ? "public, PKCE" : "confidential, secret set"
    rows.push({ label: "Client", value: `${status.client.id} (${mode}; ${CLIENT_SOURCE[status.client.source]})` })
  }
  if (status.callback !== undefined) rows.push({ label: "Callback", value: `${status.callback} (register exactly this URL in the Slack app)` })
  if (status.scopes !== undefined) rows.push({ label: "Scopes", value: status.scopes.join(" ") })
  rows.push({
    label: "Tools",
    value: `${tools.read} read, ${tools.private} private search, ${tools.file} file, ${tools.write} write`
      + (tools.unknown.length > 0 ? `; unknown (ask first): ${tools.unknown.join(", ")}` : ""),
  })
  if (status.unguardedAgents.length > 0) {
    rows.push({
      label: "Agents without default rules",
      value: `These agents run Slack writes and unknown tools without asking: ${status.unguardedAgents.join(", ")}. `
        + `In your OpenCode config, put these rules first in each agent's own "permissions" list (agents.<name>.permissions): ${remedy(status.server.name)}. `
        + `Follow them with your top-level rules for ${status.server.name}_ actions, so yours keep winning. `
        + "Do not add them to the top-level \"permissions\": there they would loosen stricter agents such as explore.",
    })
  }
  rows.push(
    { label: "OpenCode", value: `${status.host.version} (${status.host.tested ? "tested" : "untested"}; tested range ${status.host.range})` },
    { label: "Next step", value: status.next },
  )
  return rows
}

export function formatStatus(status: Status): string {
  return ["Slack", ...statusRows(status).map((row) => `${row.label}: ${row.value}`)].join("\n")
}
