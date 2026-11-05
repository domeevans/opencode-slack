import { APP_NAME, SERVER_DISPLAY_NAME, type ClientState } from "./connect.js"
import { APP_MANIFEST_URL, SERVER, SLACK_MCP_URL, SUPPORTED_HOST_RANGE } from "./defaults.js"
import type { ParsedOptions } from "./options.js"
import { defaultRules, type Rule } from "./permissions.js"
import type { ListedSkill } from "./skills.js"
import { classify } from "./tools.js"

/** The shared status labels in machine form; `/slack-status` shows them as `sign-in required` and so on. */
type State =
  | "connected"
  | "sign_in_required"
  | "connecting"
  | "disabled"
  | "failed"
  | "not_configured"
  | "conflict"
  | "host_untested"

type ErrorCode =
  | "OPTIONS_INVALID"
  | "SERVER_NAME_IN_USE"
  | "HOST_UNTESTED"
  | "CLIENT_ID_MISSING"
  | "CLIENT_ID_INVALID"
  | "AUTH_REQUIRED"
  | "CONNECTION_FAILED"
  | "SERVER_DISABLED"

/** What every status surface shows. JSON-safe; never contains a client secret, a token or a URL's query. */
export interface Status {
  /** The plugin's version. */
  readonly version: string
  readonly state: State
  readonly code?: ErrorCode
  readonly message: string
  /** The host's reason for a failed connection: one line, at most 160 characters, URLs without their query. */
  readonly detail?: string
  /** Exactly one action for the user: the `Next step` row. */
  readonly nextStep: string
  readonly server: { readonly name: string; readonly url: string }
  readonly client?: { readonly id: string; readonly mode: "public_pkce" | "confidential"; readonly source: "options" | "connect" }
  readonly callback?: string
  /** OpenCode's local listener port for an `https:` callback. */
  readonly callbackPort?: number
  readonly scopes?: readonly string[]
  readonly asksBefore: readonly string[]
  readonly tools: {
    readonly read: number
    readonly private: number
    readonly file: number
    readonly write: number
    /** How many tools the plugin does not know. */
    readonly unknown: number
    /** Up to 20 of their names, those that are plain tool names. */
    readonly unknownNames: readonly string[]
  }
  /** Agents that would run an unknown Slack tool without asking, such as agents defined only in user config. */
  readonly unguardedAgents: readonly string[]
  /** `range` is the supported range; `tested` is true only for a release every check runs on. */
  readonly host: { readonly version: string | null; readonly range: string; readonly tested: boolean }
  /** User or project skills with a bundled skill's id, which OpenCode loads instead of the bundled one. */
  readonly shadowedSkills: readonly ListedSkill[]
}

export type ServerStatus =
  | { readonly status: "connected" | "pending" | "disabled" }
  | { readonly status: "failed" | "needs_auth"; readonly error: string }

export interface StatusInput {
  readonly version: string
  readonly hostVersion: string
  /** Inside the supported range. */
  readonly hostSupported: boolean
  /** One of the tested releases. */
  readonly hostTested: boolean
  readonly parsed: ParsedOptions
  /** False when the host check or the options stopped the plugin from registering anything. */
  readonly active: boolean
  readonly nameInUse: boolean
  readonly client: ClientState
  readonly servers: readonly { readonly name: string; readonly status: ServerStatus }[]
  readonly tools: readonly { readonly name: string; readonly options?: { readonly namespace?: string } }[]
  readonly agents: readonly { readonly id: string; readonly permissions: readonly Rule[] }[]
  readonly shadowedSkills: readonly ListedSkill[]
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
const UNKNOWN_ACTION = `${SERVER}_.`

const NOTHING_TO_DO = "Nothing to do."
const LISTED_UNKNOWN = 20
// A tool name comes from the server; list only plain names.
const SAFE_NAME = /^[a-z][a-z0-9_]{0,63}$/
const DETAIL_LIMIT = 160

/** The host's failure text as a short reason: one line, URLs without their query or fragment, at most 160 characters. */
export function shortReason(text: string): string | undefined {
  const reason = text
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (url) => url.replace(/[?#].*$/s, ""))
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/, "")
  if (reason === "") return undefined
  return reason.length > DETAIL_LIMIT ? `${reason.slice(0, DETAIL_LIMIT - 1)}…` : reason
}

const quote = (rule: Rule) => `{ "action": "${rule.action}", "resource": "${rule.resource}", "effect": "${rule.effect}" }`

/**
 * The fix for unguarded agents, the same sentence in every plugin of this family: the plugin's own default rules in
 * each agent's own permissions. Never the top-level permissions, which apply after every agent's base rules and so
 * would loosen stricter agents.
 */
const AGENT_FIX = "Put the default rules shown by /slack-status first in each listed agent's own permissions, in opencode.json or the agent's Markdown file, followed by your top-level rules for Slack tools."

/** The block to paste, as a JSON list with one rule per line. */
const REMEDY = `[\n${defaultRules().map((rule) => `  ${quote(rule)}`).join(",\n")}\n]`

/** The next step once connected: unguarded agents first, because they run Slack writes without asking. */
function connectedNextStep(unguarded: readonly string[], shadowed: readonly ListedSkill[]): string {
  if (unguarded.length > 0) return AGENT_FIX
  const [skill] = shadowed
  if (skill !== undefined) return `Move or rename the skill at ${skill.path}, so that this plugin's ${skill.id} skill loads, then run opencode reload.`
  return NOTHING_TO_DO
}

function connection(status: ServerStatus | undefined, unguarded: readonly string[], shadowed: readonly ListedSkill[], toolCount: number) {
  if (status === undefined) {
    return { state: "failed" as const, message: `The ${SERVER} server is not registered.`, nextStep: "Run opencode reload, then check again." }
  }
  switch (status.status) {
    case "pending":
      return { state: "connecting" as const, message: "Connecting to Slack.", nextStep: "Wait a few seconds, then run /slack-status again (or press r in /slack)." }
    case "disabled":
      return { state: "disabled" as const, code: "SERVER_DISABLED" as const, message: `The ${SERVER} server is disabled.`, nextStep: `Enable ${SERVER} in /mcps.` }
    case "needs_auth":
      // The host's text for a needed sign-in can carry an authorization URL, so it is never shown.
      return {
        state: "sign_in_required" as const, code: "AUTH_REQUIRED" as const, message: "Sign in to Slack to use it in OpenCode.",
        nextStep: `Run /connect and choose ${SERVER_DISPLAY_NAME}, then press o or Enter to open the sign-in page (in a terminal, opencode mcp auth ${SERVER} opens the browser automatically).`,
      }
    case "failed": {
      const detail = shortReason(status.error)
      return {
        state: "failed" as const, code: "CONNECTION_FAILED" as const, message: "Could not connect to Slack.", ...(detail === undefined ? {} : { detail }),
        nextStep: `Fix the error shown, then reconnect ${SERVER} in /mcps.`,
      }
    }
    case "connected":
      return {
        state: "connected" as const, message: `Connected. Slack tools available: ${toolCount}.`,
        nextStep: connectedNextStep(unguarded, shadowed),
      }
  }
}

export function buildStatus(input: StatusInput): Status {
  const options = input.parsed.ok ? input.parsed.options : undefined
  const host = { version: input.hostVersion === "" ? null : input.hostVersion, range: SUPPORTED_HOST_RANGE, tested: input.hostTested }
  const names = input.tools.filter((tool) => tool.options?.namespace === SERVER).map((tool) => tool.name)
  const unknown = names.filter((name) => classify(name) === "unknown").sort()
  const tools = {
    read: names.filter((name) => classify(name) === "read").length,
    private: names.filter((name) => classify(name) === "private").length,
    file: names.filter((name) => classify(name) === "file").length,
    write: names.filter((name) => classify(name) === "write").length,
    unknown: unknown.length,
    unknownNames: unknown.filter((name) => SAFE_NAME.test(name)).slice(0, LISTED_UNKNOWN),
  }
  const unguardedAgents = input.active
    ? input.agents.filter((agent) => effect(agent.permissions, UNKNOWN_ACTION) === "allow").map((agent) => agent.id)
    : []
  const client = input.client.client
  const base = {
    version: input.version,
    server: { name: SERVER, url: SLACK_MCP_URL },
    ...(options === undefined || !input.active ? {} : {
      ...(client === undefined ? {} : {
        client: { id: client.id, mode: client.secret === undefined ? "public_pkce" as const : "confidential" as const, source: client.source },
      }),
      callback: options.redirectUri,
      ...(options.callbackPort === undefined ? {} : { callbackPort: options.callbackPort }),
      scopes: options.scopes,
    }),
    asksBefore: ASKS_BEFORE,
    tools,
    unguardedAgents,
    host,
    shadowedSkills: input.active ? input.shadowedSkills.map((skill) => ({ id: skill.id, path: skill.path })) : [],
  }
  // Invalid options come first: they need fixing on any host, and an untested host may already be allowed.
  if (!input.parsed.ok) {
    const { error } = input.parsed
    return { ...base, state: "not_configured", code: error.code, message: `Option ${error.field}: ${error.message}`, nextStep: error.next }
  }
  if (!input.active && !input.hostSupported) {
    return {
      ...base, state: "host_untested", code: "HOST_UNTESTED",
      message: `OpenCode ${input.hostVersion || "of an unknown version"} is outside the supported range ${SUPPORTED_HOST_RANGE}, so Slack is not set up.`,
      nextStep: `Use OpenCode ${SUPPORTED_HOST_RANGE}, or set "allowUntestedHost": true in this plugin's options to run anyway.`,
    }
  }
  if (input.nameInUse) {
    return {
      ...base, state: "conflict", code: "SERVER_NAME_IN_USE",
      message: `Another MCP server is already named "${SERVER}", so Slack was not added.`,
      nextStep: `Remove mcp.servers.${SERVER} from your OpenCode config.`,
    }
  }
  if (client === undefined) {
    return {
      ...base,
      state: "not_configured",
      ...(input.client.invalid
        ? { code: "CLIENT_ID_INVALID" as const, message: `The client ID saved in the /connect ${APP_NAME} entry is empty or has spaces, so Slack is not added.` }
        : { code: "CLIENT_ID_MISSING" as const, message: `No Slack app client ID is set, so Slack is not added. To create the app, use the manifest at ${APP_MANIFEST_URL}.` }),
      nextStep: clientNextStep(),
    }
  }
  const status = input.servers.find((item) => item.name === SERVER)?.status
  return { ...base, ...connection(status, unguardedAgents, input.shadowedSkills, names.length) }
}

/** The next step while no usable Slack app client ID is set: status's, and the tools RPC's for CLIENT_ID_MISSING. */
export function clientNextStep(): string {
  return `Run /connect and choose ${APP_NAME}, then paste your Slack app's client ID.`
}

/** The callback to register, and for an `https:` one where its proxy forwards it: OpenCode's listener, same path. */
function callbackRow(callback: string, port: number | undefined): string {
  const register = "register exactly this URL in the app's Redirect URLs"
  if (port === undefined) return `${callback} (${register})`
  return `${callback} (${register}, and forward it to http://127.0.0.1:${port}${new URL(callback).pathname}, where OpenCode listens)`
}

/** The unknown tools: their count, and the names status may show. */
function unknownTools(tools: Status["tools"]): string {
  if (tools.unknown === 0) return ""
  const more = tools.unknown - tools.unknownNames.length
  if (tools.unknownNames.length === 0) return `; ${tools.unknown} unknown (ask first)`
  return `; ${tools.unknown} unknown (ask first): ${tools.unknownNames.join(", ")}${more > 0 ? ` and ${more} more` : ""}`
}

const CLIENT_SOURCE = { options: "set in plugin options", connect: "saved in /connect" } as const

/** The connection label people see: the shared label, from the machine state. */
export function stateLabel(status: Status): string {
  switch (status.state) {
    case "sign_in_required": return "sign-in required"
    case "not_configured": return "not configured"
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
  if (status.callback !== undefined) rows.push({ label: "Callback", value: callbackRow(status.callback, status.callbackPort) })
  if (status.scopes !== undefined) rows.push({ label: "Scopes", value: status.scopes.join(" ") })
  if (status.shadowedSkills.length > 0) {
    rows.push({
      label: "Skills",
      value: status.shadowedSkills.map((skill) => `${skill.id} is shadowed by ${skill.path}, so agents load that file instead of this plugin's skill`).join("; "),
    })
  }
  rows.push({
    label: "Tools",
    value: `${tools.read} read, ${tools.private} private search, ${tools.file} file, ${tools.write} write${unknownTools(tools)}`,
  })
  rows.push({
    label: "Agents without default rules",
    value: status.unguardedAgents.length === 0 ? "none" : `${status.unguardedAgents.join(", ")}\n${REMEDY}`,
  })
  rows.push(
    { label: "OpenCode", value: `${status.host.version ?? "unknown version"} (${status.host.tested ? "tested" : "untested"}; supported range ${status.host.range})` },
    { label: "Next step", value: status.nextStep },
  )
  return rows
}

export function formatStatus(status: Status): string {
  return ["Slack", ...statusRows(status).map((row) => `${row.label}: ${row.value}`)].join("\n")
}
