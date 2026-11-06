/**
 * The tools RPC: a plugin's known read tools as RPC methods, so a script can call them with no model.
 *
 *   POST /api/rpc/<plugin id>.tools/<method>
 *   { "input": { "sessionID": "<session>", "input": <the tool's input> } }
 *
 * A script runs as a session and the agent it names, with exactly the access that agent's model would have:
 * - a tool the agent's or the session's rules hide from the model (the last rule for the tool on `*` is a deny)
 *   is refused with PERMISSION_DENIED before it runs;
 * - an MCP tool runs through OpenCode's own executor from `ctx.tool.list()`, which checks `<server>_<tool>` against
 *   the agent's rules, the session's rules and saved approvals, and sends OpenCode's own credential;
 * - a plugin-owned tool runs its own spec, with its own `ctx.permission.assert` calls;
 * - an `ask` is refused at once, because no one is there to answer it: an `evaluate` hook turns it into a deny, only
 *   for this RPC's own calls in flight (their source ids), so no other call is touched;
 * - a deny names the refused action, the method's own or an inner one, and says to change the rule: a rule deny never
 *   reaches `evaluate` hooks, so its action comes from OpenCode's own `Permission denied: <action>` text.
 * Only known reads become methods. Writes, sends, unknown tools and local-file exports never do.
 *
 * The executor bypasses `execute.before` and `execute.after` hooks, so `shapeResult` applies here whatever those
 * hooks do on the model path.
 *
 * Shared module. Each plugin keeps its own copy, because each bundle is self-contained. Edit only the block between
 * the PLUGIN-SPECIFIC markers. Everything else is identical in every plugin: the plugin's `check-copies.mjs` fails
 * its check when it is not, so change it in every plugin at once.
 */
import { randomUUID } from "node:crypto"
import type { Plugin } from "@opencode/plugin"
import { Rpc } from "@opencode/plugin/rpc"

// >>> PLUGIN-SPECIFIC >>>

import { SCRIPTABLE_TOOLS } from "../tools.js"

/** The plugin's id. The RPC id is `<PLUGIN_ID>.tools`. */
export const PLUGIN_ID = "slack.workspace"

/**
 * The MCP tools that become methods, by their upstream name (the tool id without the `<server>_` prefix). Only known
 * reads belong here: an allowlist, so a tool the server adds later is never a method. Slack's are the twelve reads,
 * the private search and the file read from `src/tools.ts`; the last two ask by default, so a script is refused them
 * until an allow rule exists.
 */
export const KNOWN_READS: readonly string[] = SCRIPTABLE_TOOLS

/** What the model path's `execute.after` hooks do to a result, which the executor skips. Slack has no such hook. */
export function shapeResult(_method: string, result: McpResult): McpResult {
  return result
}

/** The next step for each code. Each is one sentence that ends with a full stop. */
export const NEXT_STEPS: NextSteps = {
  SESSION_UNKNOWN: `Create a session that names an agent, such as POST /api/session with {"agent":"build"}, and pass its id.`,
  SESSION_AGENT_REQUIRED: `Create a session that names an agent, such as POST /api/session with {"agent":"build"}, and pass its id.`,
  PERMISSION_DENIED: "Add an allow rule for the tool to the session's agent or to the session, or use a session whose agent allows it.",
  SERVER_CONFLICT: "Remove mcp.servers.slack from your OpenCode config.",
  AUTH_REQUIRED: "Run /slack-status and follow its next step to sign in to Slack.",
  CONNECTING: "Wait a few seconds, then call the method again.",
  CONNECTION_FAILED: "Run /slack-status and follow its next step.",
  DISABLED: "Enable slack in /mcps, then call the method again.",
  // Without a client ID, setup's notRegistered hook gives CLIENT_ID_MISSING or CLIENT_ID_INVALID and /connect instead.
  NOT_REGISTERED: "Run /slack-status and follow its next step.",
  TOOL_UNAVAILABLE: "Call describe to see which methods OpenCode lists now, and run /slack-status.",
  UPSTREAM_ERROR: "Check the input against the method's schema from describe, and run /slack-status if it keeps failing.",
  CANCELLED: "Call the method again if you still need the result.",
}

/** The plugin's own errors, thrown by plugin-owned specs, as a code, what happened and the next step. Slack has none. */
export function pluginError(_error: unknown): Failure | undefined {
  return undefined
}

// <<< PLUGIN-SPECIFIC <<<

export const TOOLS_RPC_ID = `${PLUGIN_ID}.tools`

export type JsonSchema = Readonly<Record<string, unknown>>

/** An MCP method's result: the tool's structured content, when it has any, and its text parts joined by newlines. */
export interface McpResult {
  readonly output?: unknown
  readonly text: string
}

/** Every code the module itself returns. ACCOUNT_UNKNOWN only with per-account servers. */
type Code =
  | "SESSION_UNKNOWN"
  | "SESSION_AGENT_REQUIRED"
  | "PERMISSION_DENIED"
  | "SERVER_CONFLICT"
  | "AUTH_REQUIRED"
  | "CONNECTING"
  | "CONNECTION_FAILED"
  | "DISABLED"
  | "NOT_REGISTERED"
  | "TOOL_UNAVAILABLE"
  | "UPSTREAM_ERROR"
  | "CANCELLED"
  | "ACCOUNT_UNKNOWN"

/** The codes only an MCP method raises. A block without MCP methods may omit their next steps. */
const MCP_ONLY = ["SERVER_CONFLICT", "AUTH_REQUIRED", "CONNECTING", "CONNECTION_FAILED", "DISABLED", "NOT_REGISTERED", "TOOL_UNAVAILABLE", "UPSTREAM_ERROR"] as const
type McpCode = (typeof MCP_ONLY)[number]

/**
 * One next step per code. The MCP-only steps are required, at registration, only for a block with MCP methods, and
 * SERVER_CONFLICT not even then: the shared default names the server. ACCOUNT_UNKNOWN only with per-account servers.
 */
type NextSteps = Readonly<Record<Exclude<Code, McpCode | "ACCOUNT_UNKNOWN">, string>> & { readonly [code in McpCode | "ACCOUNT_UNKNOWN"]?: string }

/** A refusal: the RPC error `failed` with this message and `data: { code, next }`. */
interface Failure {
  readonly code: string
  /** What happened, without the code or a final full stop. */
  readonly what: string
  readonly next: string
}

/** A plugin-owned read tool, run through its own spec. */
export interface OwnedMethod {
  readonly name: string
  /** The tool's permission action (its `options.permission`, or its id): the hidden-tool check uses it. */
  readonly action: string
  readonly description: string
  /** The input's JSON Schema, for the contract and describe. OpenCode does not check it: `run` checks its own input. */
  readonly input: JsonSchema
  readonly output: JsonSchema
  /**
   * Runs the tool's own spec. Its asserts must pass `source: { type: "tool", messageID: call.messageID, id: call.id }`,
   * as a tool does with its own context, so that the `evaluate` hook can tell this call's ask apart.
   */
  run(input: unknown, call: ToolCall): Promise<unknown>
  /**
   * Whether the method can run now, for describe only: undefined when it can, otherwise the plugin's own code for why
   * not, such as a module that is turned off or has no build for this platform. Without it, describe reports the method
   * as available. A call never consults it: `run` reports the same state as its own error.
   */
  available?(): string | undefined | Promise<string | undefined>
}

export interface ToolsRpcOptions {
  /** The MCP server whose known reads are methods. */
  readonly mcp?: {
    /**
     * The server name. A function makes `account` part of the envelope and maps it to that account's server, or to
     * undefined for an account that does not exist.
     */
    readonly server: string | ((account: string | undefined) => string | undefined)
    /** False while the name belongs to a server the plugin does not manage, such as the user's own. */
    readonly managed: (server: string) => boolean
    /**
     * Optional. For a known read that OpenCode does not list, `describe` adds the text this returns as `detail`
     * beside the code in `reason`, such as the toolset and option that turn the method on. Called with the method
     * name and that code; undefined adds nothing. Without it, describe is unchanged.
     */
    readonly unavailableDetail?: (method: string, code: Code) => string | undefined
    /**
     * Optional. The code and next step used instead of NOT_REGISTERED while the server is not registered, such as a
     * missing client ID that keeps the plugin from registering it; undefined keeps NOT_REGISTERED. Read at each call
     * and each describe. Without it, NOT_REGISTERED stays.
     */
    readonly notRegistered?: (server: string) => { readonly code: string; readonly next: string } | undefined
  }
  /** Plugin-owned read tools. */
  readonly owned?: readonly OwnedMethod[]
}

export type ToolsRpcContext = Pick<Plugin.Context, "rpc" | "permission" | "session" | "agent" | "tool" | "mcp" | "location">

/** The executor context a script's call runs with. */
export interface ToolCall {
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly id: string
  readonly signal: AbortSignal
  readonly progress: () => Promise<void>
  /**
   * A plugin-owned method's call only, with per-account servers: the envelope's `account`, already known to the
   * `mcp.server` function. Absent when the envelope has none (the default account).
   */
  readonly account?: string
}

type Rule = { readonly action: string; readonly resource: string; readonly effect: "allow" | "deny" | "ask" }
type Envelope = { readonly sessionID: string; readonly account?: string; readonly input: unknown }
type RpcContext = { readonly signal: AbortSignal; readonly error: (type: "failed", message: string, data: { code: string; next: string }) => unknown }
type Tool = Awaited<ReturnType<ToolsRpcContext["tool"]["list"]>>[number]
type ToolResult = Awaited<ReturnType<Tool["execute"]>>

const UNATTENDED = "A script cannot answer an approval prompt; this needs an allow rule for the session's agent."
const MESSAGE_ID = "msg_script"
const UPSTREAM_LIMIT = 300

const object = (properties: Record<string, JsonSchema>, required: readonly string[]): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
})
const STRING = { type: "string" } as const
const ANY_OBJECT = { type: "object" } as const
const NO_INPUT = object({}, [])
const FAILED = object({ code: STRING, next: STRING }, ["code", "next"])
const mcpOutput = (output: JsonSchema = {}) => object({ output, text: STRING }, ["text"])
const DESCRIBED = object(
  {
    name: STRING,
    tool: STRING,
    kind: { type: "string", enum: ["mcp", "plugin"] },
    action: STRING,
    description: STRING,
    available: { type: "boolean" },
    reason: STRING,
    detail: STRING,
    input: ANY_OBJECT,
    output: ANY_OBJECT,
  },
  ["name", "tool", "kind", "action", "description", "available", "input", "output"],
)
const DESCRIPTION = object({ id: STRING, call: STRING, location: STRING, methods: { type: "array", items: DESCRIBED } }, [
  "id",
  "call",
  "location",
  "methods",
])

const plainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** The envelope's messages, one wording for every plugin (README, "Envelope errors"). */
const ENVELOPE_MESSAGES = {
  notObject: `the envelope must be an object, such as {"sessionID":"<session>","input":<the tool's input>}`,
  unknownKey: (key: string) => `"${key}" is not allowed`,
  sessionID: `"sessionID" must be a non-empty string`,
  account: `"account" must be a non-empty string`,
  inputMissing: `"input" is missing`,
  inputNotObject: `"input" must be an object`,
  describe: "describe takes no input",
} as const

const standard = (schema: JsonSchema, validate: (value: unknown) => unknown): JsonSchema =>
  Object.defineProperty({ ...schema }, "~standard", { value: { version: 1, vendor: "tools-rpc", validate }, enumerable: false })

/** describe's input: nothing, or an empty object. Anything else gets one plain message. */
const DESCRIBE_INPUT = standard(NO_INPUT, (value) =>
  value === undefined || value === null || (plainObject(value) && Object.keys(value).length === 0) ? { value } : { issues: [{ message: ENVELOPE_MESSAGES.describe }] },
)

/**
 * A JSON Schema object with a strict validator attached. OpenCode decodes a plain JSON Schema with Effect, which drops
 * unknown keys of an object that has properties instead of refusing them; it prefers a Standard Schema validator when
 * the schema has one. The validator refuses unknown keys and checks `issues`; it is not enumerable, so the contract
 * still reads and serialises as plain JSON Schema. OpenCode answers a refusal with `rpc.invalid_input`.
 */
function strict(schema: JsonSchema, issues: (value: Record<string, unknown>) => string[]): JsonSchema {
  const keys = Object.keys(schema["properties"] as object)
  return standard(schema, (value) => {
    if (!plainObject(value)) return { issues: [{ message: ENVELOPE_MESSAGES.notObject }] }
    const found = [...Object.keys(value).filter((key) => !keys.includes(key)).map(ENVELOPE_MESSAGES.unknownKey), ...issues(value)]
    return found.length === 0 ? { value } : { issues: found.map((message) => ({ message })) }
  })
}

class ScriptError extends Error {
  readonly failure: Failure
  constructor(failure: Failure) {
    // `what` may end with its own full stop (a refused ask's reason, an upstream first line); keep exactly one.
    super(`${failure.code}: ${failure.what.replace(/[.\s]+$/, "")}. Next step: ${failure.next}`)
    this.failure = failure
  }
}

const fail = (code: Exclude<Code, "ACCOUNT_UNKNOWN">, what: string) => {
  const next = NEXT_STEPS[code]
  // registerToolsRpc checks the MCP-only steps for a block with MCP methods, so this is a bug in the module.
  if (next === undefined) throw new Error(`tools-rpc: NEXT_STEPS.${code} is missing`)
  return new ScriptError({ code, what, next })
}

/** SERVER_CONFLICT's next step: the block's own, or the shared default that names the server. */
const conflictNext = (server: string) =>
  NEXT_STEPS.SERVER_CONFLICT ?? `Remove your own "${server}" server from opencode.json so that the plugin manages it, then run "opencode reload".`

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

/** True when OpenCode says the thing looked up does not exist: its tagged not-found error, or an HTTP 404. */
function notFound(error: unknown, tags: readonly string[]): boolean {
  if (!record(error)) return false
  const tag = error["_tag"] ?? error["name"]
  return (typeof tag === "string" && tags.includes(tag)) || error["status"] === 404 || error["statusCode"] === 404
}

/** OpenCode's `Tool.Error`. A permission refusal carries its cause in `error`; an upstream failure has none. */
const toolError = (error: unknown): error is { message: string; error?: unknown } => record(error) && error["_tag"] === "Tool.Error"

/** The action of the permission request a refusal's cause carries (OpenCode's `Permission.Request`), if any. */
const requestAction = (cause: unknown): string | undefined => {
  const request = record(cause) ? cause["request"] : undefined
  return record(request) && typeof request["action"] === "string" && request["action"] !== "" ? request["action"] : undefined
}

/**
 * The action in OpenCode's fixed text for a rule deny, `Permission denied: <action>`. A rule deny never reaches
 * `evaluate` hooks and its cause carries no request, so this text is how the refusal can name the action.
 */
const deniedAction = (message: string): string | undefined => /^Permission denied: ([\w.:-]*[\w-])\.?\s*$/.exec(message.split(/\r?\n/, 1)[0] ?? "")?.[1]

/** Host wildcards: `*` matches any run of characters and `?` one character, over the whole string. */
const wildcard = (pattern: string, value: string) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`).test(value)

/** OpenCode hides a tool from the model when the last rule matching its action on `*` is a deny. */
export const hidden = (rules: readonly Rule[], action: string) =>
  rules.findLast((rule) => wildcard(rule.action, action) && wildcard(rule.resource, "*"))?.effect === "deny"

/** Token shapes, replaced in order. URLs are handled first, by `withoutQuery`. */
const SECRETS: readonly [RegExp, string][] = [
  [/\b(bearer|basic|token)\s+[\w.~+/=-]{8,}/gi, "$1 [redacted]"],
  [/\b([\w-]*(?:api[_-]?key|access[_-]?key|private[_-]?key|token|secret|password|signature|credential)["']?\s*[:=]\s*)["']?[^\s"'&,;]+["']?/gi, "$1[redacted]"],
  [/\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]{4,}/g, "[redacted]"],
  [/\b(?:tvly|sk|pk|rk|ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[abposr]|lin_api|lin_oauth)[-_][\w-]{8,}/gi, "[redacted]"],
  [/[\w+=-]{40,}/g, "[redacted]"],
]

/** A URL keeps its origin and path; its query and fragment, where signatures and tokens travel, go. */
const withoutQuery = (text: string) =>
  text.replace(/\bhttps?:\/\/[^\s"'<>()]+/gi, (url) => {
    const cut = url.search(/[?#]/)
    return cut === -1 ? url : `${url.slice(0, cut)}?[redacted]`
  })

/** Upstream text for an error message: its first line, with tokens and signed URLs redacted, at most 300 characters. */
export function upstreamText(text: string): string {
  const line = text.split(/\r?\n/).find((part) => part.trim() !== "")?.trim() ?? "no message"
  const redacted = SECRETS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), withoutQuery(line))
  return redacted.length <= UPSTREAM_LIMIT ? redacted : `${redacted.slice(0, UPSTREAM_LIMIT - 1)}…`
}

/** A tool's schema when it is plain JSON Schema, as an MCP tool's is; an Effect or Standard Schema is not. */
const jsonSchema = (schema: unknown): JsonSchema | undefined =>
  record(schema) && !("ast" in schema) && !("~standard" in schema) ? schema : undefined

function normalise(result: ToolResult): McpResult {
  const text = typeof result.content === "string" ? result.content : (result.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
  return result.output === undefined ? { text } : { output: result.output, text }
}

/** The code for a server that is not connected, from OpenCode's MCP status; undefined when it is connected. */
function connection(status: string | undefined): Exclude<Code, "ACCOUNT_UNKNOWN"> | undefined {
  switch (status) {
    case "connected":
      return undefined
    case "pending":
      return "CONNECTING"
    case "needs_auth":
      return "AUTH_REQUIRED"
    case "failed":
      return "CONNECTION_FAILED"
    case "disabled":
      return "DISABLED"
    default:
      return "NOT_REGISTERED"
  }
}

const STATUS_TEXT: Record<string, string> = {
  CONNECTING: "is still connecting",
  AUTH_REQUIRED: "needs a sign-in",
  CONNECTION_FAILED: "could not connect",
  DISABLED: "is disabled",
  NOT_REGISTERED: "is not registered",
}

export async function registerToolsRpc(ctx: ToolsRpcContext, options: ToolsRpcOptions): Promise<() => Promise<void>> {
  const { mcp, owned = [] } = options
  const accounts = typeof mcp?.server === "function"
  if (KNOWN_READS.length > 0 && !mcp) throw new Error("registerToolsRpc: KNOWN_READS needs the mcp option")
  if (accounts && NEXT_STEPS.ACCOUNT_UNKNOWN === undefined) throw new Error("registerToolsRpc: per-account servers need NEXT_STEPS.ACCOUNT_UNKNOWN")
  const missing = KNOWN_READS.length > 0 ? MCP_ONLY.find((code) => code !== "SERVER_CONFLICT" && NEXT_STEPS[code] === undefined) : undefined
  if (missing) throw new Error(`registerToolsRpc: MCP methods need NEXT_STEPS.${missing}`)
  const names = [...KNOWN_READS, ...owned.map((method) => method.name)]
  const duplicate = names.find((name, index) => name === "describe" || names.indexOf(name) !== index)
  if (duplicate) throw new Error(`registerToolsRpc: the method name "${duplicate}" is taken`)

  // This RPC's calls in flight, by the source id their permission checks carry.
  const live = new Set<string>()
  // Each live call's last refused check the hook saw, by source id: its action, which may not be the method's, and its
  // effect. A rule deny never reaches the hook, so only asks (and other hooks' denies) are recorded here.
  const refused = new Map<string, { readonly action: string; readonly effect: "ask" | "deny" }>()

  const serverOf = (account: string | undefined): string => {
    const server = typeof mcp!.server === "function" ? mcp!.server(account) : mcp!.server
    if (server !== undefined) return server
    throw new ScriptError({ code: "ACCOUNT_UNKNOWN", what: `there is no account '${account}'`, next: NEXT_STEPS.ACCOUNT_UNKNOWN! })
  }

  /** The session's agent and the rules that decide what its model sees: the agent's, then the session's. */
  const session = async (sessionID: string) => {
    let info: Awaited<ReturnType<ToolsRpcContext["session"]["get"]>>
    try {
      info = await ctx.session.get({ sessionID: sessionID as never })
    } catch (error) {
      // Only OpenCode's "no such session" is SESSION_UNKNOWN; any other failure propagates as it is.
      if (notFound(error, ["Session.NotFoundError", "SessionNotFoundError"])) throw fail("SESSION_UNKNOWN", `there is no session '${sessionID}'`)
      throw error
    }
    if (!info.agent) throw fail("SESSION_AGENT_REQUIRED", `session '${sessionID}' names no agent`)
    let agent: Awaited<ReturnType<ToolsRpcContext["agent"]["get"]>>
    try {
      agent = await ctx.agent.get({ agentID: info.agent, location: info.location })
    } catch (error) {
      if (notFound(error, ["Agent.NotFoundError", "AgentNotFoundError"])) throw fail("SESSION_AGENT_REQUIRED", `session '${sessionID}' names the agent '${info.agent}', which does not exist`)
      throw error
    }
    const rules: Rule[] = [...agent.data.permissions, ...(info.permissions ?? [])]
    return { agent: info.agent as string, rules }
  }

  /** The plugin's own code and next step for a server that is not registered, if its `notRegistered` hook gives one. */
  const notRegistered = (server: string) => mcp?.notRegistered?.(server)

  /** Why the server's tool is missing: its connection state, or TOOL_UNAVAILABLE while it is connected. */
  const unavailable = async (server: string, tool: string, connected: Exclude<Code, "ACCOUNT_UNKNOWN">) => {
    const status = (await ctx.mcp.list()).data.find((entry) => entry.name === server)?.status.status
    const code = connection(status) ?? connected
    if (code === "TOOL_UNAVAILABLE") return fail(code, `OpenCode does not list ${tool} on the connected "${server}" server`)
    // The call found the server not connected, and it reads connected now: it reconnected meanwhile.
    if (status === "connected") return fail(code, `the "${server}" server was reconnecting when ${tool} ran`)
    const what = `the "${server}" server ${STATUS_TEXT[code] ?? "is unavailable"}`
    const own = code === "NOT_REGISTERED" ? notRegistered(server) : undefined
    return own ? new ScriptError({ code: own.code, what, next: own.next }) : fail(code, what)
  }

  /** The next step for a deny rule: no prompt can be answered, so the rule itself must change. */
  const denyNext = (action: string, agent: string) =>
    `Remove or narrow the deny rule for ${action} in the agent "${agent}" or in the session, or add a later allow rule for ${action} to the session, or use a session whose agent allows it.`

  /**
   * A refused ask (the hook turned it into a deny). `asked` is the action whose check was refused, when that is known
   * and is not the method's own, such as a speech download that a transcription asks for: the message and the next
   * step name it.
   */
  const denied = (action: string, error: unknown, asked = action) => {
    const reason = upstreamText(record(error) && typeof error["message"] === "string" ? error["message"] : String(error))
    if (asked === action) return fail("PERMISSION_DENIED", `${action} was refused for this session's agent: ${reason}`)
    return new ScriptError({
      code: "PERMISSION_DENIED",
      what: `${action} needs ${asked}, which was refused for this session's agent: ${reason}`,
      next: `Add an allow rule for ${asked} to the session's agent or to the session, or use a session whose agent allows it.`,
    })
  }

  /**
   * A check a deny rule refused, the method's own or an inner one such as the read Plaud's recent makes: the message
   * names the action as for an ask, and the next step says to change the rule, naming the session's agent.
   */
  const ruleDenied = (action: string, error: unknown, agent: string, inner = action) => {
    const reason = upstreamText(record(error) && typeof error["message"] === "string" ? error["message"] : String(error))
    const what = inner === action ? `${action} was refused by a deny rule for this session's agent: ${reason}` : `${action} needs ${inner}, which a deny rule refuses for this session's agent: ${reason}`
    return new ScriptError({ code: "PERMISSION_DENIED", what, next: denyNext(inner, agent) })
  }

  /** A method's call: the permission action the hidden-tool check uses, and how it runs as the session. */
  interface Target {
    readonly action: string
    readonly mcp: boolean
    run(call: ToolCall): Promise<unknown>
  }

  const mcpTarget = (name: string, envelope: Envelope): Target => {
    const server = serverOf(envelope.account)
    const action = `${server}_${name}`
    return {
      action,
      mcp: true,
      async run(call) {
        if (!mcp!.managed(server)) {
          throw new ScriptError({ code: "SERVER_CONFLICT", what: `the "${server}" server in your config is not the one this plugin manages`, next: conflictNext(server) })
        }
        const tool = (await ctx.tool.list()).find((entry) => entry.id === action)
        if (!tool) throw await unavailable(server, action, "TOOL_UNAVAILABLE")
        let result: ToolResult
        try {
          // OpenCode asserts `action` on `*` inside the executor, for the call's session and agent.
          result = await tool.execute(envelope.input as never, call as never)
        } catch (error) {
          // OpenCode's fixed message for a call to a server that is not connected.
          if (error instanceof Error && error.message.startsWith(`MCP server "${server}" `)) throw await unavailable(server, action, "CONNECTING")
          throw error
        }
        return shapeResult(name, normalise(result))
      },
    }
  }

  const ownedTarget = (spec: OwnedMethod, envelope: Envelope): Target => {
    // With per-account servers, an unknown account is ACCOUNT_UNKNOWN before the spec runs, as for an MCP method.
    if (accounts) serverOf(envelope.account)
    const account = accounts && envelope.account !== undefined ? { account: envelope.account } : {}
    return {
      action: spec.action,
      mcp: false,
      run: async (call) => (await spec.run(envelope.input, { ...call, ...account })) ?? null,
    }
  }

  const invoke = async (target: (envelope: Envelope) => Target, raw: unknown, context: RpcContext) => {
    const envelope = raw as Envelope
    let method: Target | undefined
    let id: string | undefined
    let agent: string | undefined
    try {
      if (context.signal.aborted) throw fail("CANCELLED", "the call was cancelled")
      method = target(envelope)
      const resolved = await session(envelope.sessionID)
      agent = resolved.agent
      if (hidden(resolved.rules, method.action)) {
        throw new ScriptError({ code: "PERMISSION_DENIED", what: `${method.action} is hidden from this session's agent by a deny rule`, next: denyNext(method.action, agent) })
      }
      id = `script:${randomUUID()}`
      const call: ToolCall = {
        sessionID: envelope.sessionID,
        agent,
        messageID: MESSAGE_ID,
        id,
        signal: context.signal,
        progress: async () => {},
      }
      live.add(call.id)
      try {
        // RPC output must be a JSON value.
        return JSON.parse(JSON.stringify(await method.run(call)))
      } finally {
        live.delete(call.id)
      }
    } catch (error) {
      const failure = refusal(error, method, context.signal, agent, id === undefined ? undefined : refused.get(id))
      if (!failure) throw error
      return context.error("failed", new ScriptError(failure).message, { code: failure.code, next: failure.next })
    } finally {
      if (id !== undefined) refused.delete(id)
    }
  }

  /** The failure a script reads, or undefined for a host error that propagates unchanged. */
  const refusal = (
    error: unknown,
    method: Target | undefined,
    signal: AbortSignal,
    agent: string | undefined,
    seen?: { readonly action: string; readonly effect: "ask" | "deny" },
  ): Failure | undefined => {
    if (signal.aborted) return fail("CANCELLED", "the call was cancelled").failure
    if (error instanceof ScriptError) return error.failure
    const own = pluginError(error)
    if (own || !method || !toolError(error)) return own
    // A deny, or an ask the hook refused, carries its cause; an upstream failure (MCP `isError`) has none.
    if (error.error !== undefined) {
      const request = requestAction(error.error)
      // An ask: the hook refused it, or the cause carries its request (only an ask has one). As before.
      if (seen?.effect === "ask" || request !== undefined || agent === undefined) return denied(method.action, error, request ?? seen?.action).failure
      // A deny: a rule deny reaches no hook and carries no request, so OpenCode's own text names its action.
      return ruleDenied(method.action, error, agent, seen?.action ?? deniedAction(error.message) ?? method.action).failure
    }
    if (method.mcp) return fail("UPSTREAM_ERROR", `${method.action} failed: ${upstreamText(error.message)}`).failure
    return undefined
  }

  const describe = async () => {
    const tools = mcp ? await ctx.tool.list() : []
    const methods: Record<string, unknown>[] = []
    if (mcp) {
      const server = serverOf(undefined)
      const managed = mcp.managed(server)
      const status = managed ? (await ctx.mcp.list()).data.find((entry) => entry.name === server)?.status.status : undefined
      for (const name of KNOWN_READS) {
        const id = `${server}_${name}`
        const tool = managed ? tools.find((entry) => entry.id === id) : undefined
        const code: Code | undefined = !managed ? "SERVER_CONFLICT" : tool ? undefined : (connection(status) ?? "TOOL_UNAVAILABLE")
        const reason = code === "NOT_REGISTERED" ? (notRegistered(server)?.code ?? code) : code
        const detail = code === undefined ? undefined : mcp.unavailableDetail?.(name, code)
        const input = jsonSchema(tool?.input) ?? ANY_OBJECT
        const output = jsonSchema(tool?.output)
        methods.push({
          name,
          tool: id,
          kind: "mcp",
          action: id,
          description: tool?.description ?? "",
          available: reason === undefined,
          ...(reason ? { reason } : {}),
          ...(detail === undefined ? {} : { detail }),
          input,
          output: mcpOutput(output),
        })
      }
    }
    for (const spec of owned) {
      const reason = await spec.available?.()
      methods.push({
        name: spec.name,
        tool: spec.name,
        kind: "plugin",
        action: spec.action,
        description: spec.description,
        available: reason === undefined,
        ...(reason === undefined ? {} : { reason }),
        input: spec.input,
        output: spec.output,
      })
    }
    return JSON.parse(
      JSON.stringify({
        id: TOOLS_RPC_ID,
        call: `POST /api/rpc/${TOOLS_RPC_ID}/<method> with {"input":{"sessionID":"<session>",${accounts ? `"account":"<account>",` : ""}"input":<the tool's input>}}`,
        location: ctx.location.directory,
        methods,
      }),
    )
  }

  const envelope = (input: JsonSchema, objectInput: boolean) =>
    strict(
      object({ sessionID: { type: "string", minLength: 1 }, ...(accounts ? { account: { type: "string", minLength: 1 } } : {}), input }, ["sessionID", "input"]),
      (value) => [
        ...(typeof value["sessionID"] === "string" && value["sessionID"] !== "" ? [] : [ENVELOPE_MESSAGES.sessionID]),
        ...(value["account"] === undefined || (typeof value["account"] === "string" && value["account"] !== "") ? [] : [ENVELOPE_MESSAGES.account]),
        ...(!("input" in value) ? [ENVELOPE_MESSAGES.inputMissing] : objectInput && !plainObject(value["input"]) ? [ENVELOPE_MESSAGES.inputNotObject] : []),
      ],
    )
  const contract = Rpc.define({
    id: TOOLS_RPC_ID,
    methods: {
      describe: { input: DESCRIBE_INPUT, output: DESCRIPTION },
      ...Object.fromEntries(KNOWN_READS.map((name) => [name, { input: envelope(ANY_OBJECT, true), output: mcpOutput(), errors: { failed: FAILED } }])),
      ...Object.fromEntries(owned.map((spec) => [spec.name, { input: envelope(spec.input, false), output: spec.output, errors: { failed: FAILED } }])),
    },
    events: {},
  } as never)
  const handlers = {
    describe: () => describe(),
    ...Object.fromEntries(KNOWN_READS.map((name) => [name, (raw: unknown, context: RpcContext) => invoke((envelope) => mcpTarget(name, envelope), raw, context)])),
    ...Object.fromEntries(owned.map((spec) => [spec.name, (raw: unknown, context: RpcContext) => invoke((envelope) => ownedTarget(spec, envelope), raw, context)])),
  }
  const registration = await ctx.rpc.register(contract, handlers as never)

  // A script's ask has no one to answer it: refuse it now instead of leaving a prompt that waits. Only this RPC's own
  // calls in flight match, so the model's calls and other plugins' calls are never touched. The hook only tightens.
  const hook = await ctx.permission.hook("evaluate", (evaluation) => {
    if (evaluation.source === undefined || !live.has(evaluation.source.id) || evaluation.effect === "allow") return
    // Remember which check was refused and how, so the refusal names it; an allow or a deny is never changed.
    refused.set(evaluation.source.id, { action: evaluation.action, effect: evaluation.effect === "ask" ? "ask" : "deny" })
    if (evaluation.effect !== "ask") return
    evaluation.effect = "deny"
    evaluation.message = UNATTENDED
  })

  return async () => {
    await hook.dispose().catch(() => undefined)
    await registration.dispose().catch(() => undefined)
  }
}
