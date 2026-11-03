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
 *   for this RPC's own calls in flight (their source ids), so no other call is touched.
 * Only known reads become methods. Writes, sends, unknown tools and local-file exports never do.
 *
 * The executor bypasses `execute.before` and `execute.after` hooks, so `shapeResult` applies here whatever those
 * hooks do on the model path.
 *
 * Shared module. Each plugin keeps its own copy, because each bundle is self-contained. Edit only the block between
 * the PLUGIN-SPECIFIC markers; everything else stays identical to the shared copy (`check-copy.mjs` compares).
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
  SERVER_CONFLICT: `Remove your own server with this plugin's server name from your OpenCode config, or set this plugin's "server" option to another name.`,
  AUTH_REQUIRED: "Run /slack-status and follow its next step to sign in to Slack.",
  CONNECTING: "Wait a few seconds, then call the method again.",
  CONNECTION_FAILED: "Run /slack-status and follow its next step.",
  DISABLED: "Enable the Slack server in /mcps, then call the method again.",
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
export type Code =
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

export type NextSteps = Readonly<Record<Exclude<Code, "ACCOUNT_UNKNOWN">, string>> & { readonly ACCOUNT_UNKNOWN?: string }

/** A refusal: the RPC error `failed` with this message and `data: { code, next }`. */
export interface Failure {
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

/**
 * A JSON Schema object with a strict validator attached. OpenCode decodes a plain JSON Schema with Effect, which drops
 * unknown keys of an object that has properties instead of refusing them; it prefers a Standard Schema validator when
 * the schema has one. The validator refuses unknown keys and checks `issues`; it is not enumerable, so the contract
 * still reads and serialises as plain JSON Schema. OpenCode answers a refusal with `rpc.invalid_input`.
 */
function strict(schema: JsonSchema, issues: (value: Record<string, unknown>) => string[]): JsonSchema {
  const keys = Object.keys(schema["properties"] as object)
  const validate = (value: unknown) => {
    if (!plainObject(value)) return { issues: [{ message: "Expected an object" }] }
    const found = [...Object.keys(value).filter((key) => !keys.includes(key)).map((key) => `"${key}" is not allowed`), ...issues(value)]
    return found.length === 0 ? { value } : { issues: found.map((message) => ({ message })) }
  }
  return Object.defineProperty({ ...schema }, "~standard", { value: { version: 1, vendor: "tools-rpc", validate }, enumerable: false })
}

class ScriptError extends Error {
  constructor(readonly failure: Failure) {
    super(`${failure.code}: ${failure.what}. Next step: ${failure.next}`)
  }
}

const fail = (code: Exclude<Code, "ACCOUNT_UNKNOWN">, what: string) => new ScriptError({ code, what, next: NEXT_STEPS[code] })

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

/** True when OpenCode says the thing looked up does not exist: its tagged not-found error, or an HTTP 404. */
function notFound(error: unknown, tags: readonly string[]): boolean {
  if (!record(error)) return false
  const tag = error["_tag"] ?? error["name"]
  return (typeof tag === "string" && tags.includes(tag)) || error["status"] === 404 || error["statusCode"] === 404
}

/** OpenCode's `Tool.Error`. A permission refusal carries its cause in `error`; an upstream failure has none. */
const toolError = (error: unknown): error is { message: string; error?: unknown } => record(error) && error["_tag"] === "Tool.Error"

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
  const names = [...KNOWN_READS, ...owned.map((method) => method.name)]
  const duplicate = names.find((name, index) => name === "describe" || names.indexOf(name) !== index)
  if (duplicate) throw new Error(`registerToolsRpc: the method name "${duplicate}" is taken`)

  // This RPC's calls in flight, by the source id their permission checks carry.
  const live = new Set<string>()

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

  /** Why the server's tool is missing: its connection state, or TOOL_UNAVAILABLE while it is connected. */
  const unavailable = async (server: string, tool: string, connected: Exclude<Code, "ACCOUNT_UNKNOWN">) => {
    const status = (await ctx.mcp.list()).data.find((entry) => entry.name === server)?.status.status
    const code = connection(status) ?? connected
    if (code === "TOOL_UNAVAILABLE") return fail(code, `OpenCode does not list ${tool} on the connected "${server}" server`)
    return fail(code, `the "${server}" server ${STATUS_TEXT[code] ?? "is unavailable"}`)
  }

  const denied = (action: string, error: unknown) => {
    const reason = record(error) && typeof error["message"] === "string" ? error["message"] : String(error)
    return fail("PERMISSION_DENIED", `${action} was refused for this session's agent: ${upstreamText(reason)}`)
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
        if (!mcp!.managed(server)) throw fail("SERVER_CONFLICT", `the "${server}" server in your config is not the one this plugin manages`)
        const tool = (await ctx.tool.list()).find((entry) => entry.id === action)
        if (!tool) throw await unavailable(server, action, "TOOL_UNAVAILABLE")
        let result: ToolResult
        try {
          // OpenCode asserts `action` on `*` inside the executor, for the call's session and agent.
          result = await tool.execute(envelope.input as never, call as never)
        } catch (error) {
          // OpenCode's fixed message for a call to a server that is not connected.
          if (error instanceof Error && error.message.startsWith(`MCP server "${server}" `)) throw await unavailable(server, action, "CONNECTION_FAILED")
          throw error
        }
        return shapeResult(name, normalise(result))
      },
    }
  }

  const ownedTarget = (spec: OwnedMethod, envelope: Envelope): Target => ({
    action: spec.action,
    mcp: false,
    run: async (call) => (await spec.run(envelope.input, call)) ?? null,
  })

  const invoke = async (target: (envelope: Envelope) => Target, raw: unknown, context: RpcContext) => {
    const envelope = raw as Envelope
    let method: Target | undefined
    try {
      if (context.signal.aborted) throw fail("CANCELLED", "the call was cancelled")
      method = target(envelope)
      const { agent, rules } = await session(envelope.sessionID)
      if (hidden(rules, method.action)) throw fail("PERMISSION_DENIED", `${method.action} is hidden from this session's agent by a deny rule`)
      const call: ToolCall = {
        sessionID: envelope.sessionID,
        agent,
        messageID: MESSAGE_ID,
        id: `script:${randomUUID()}`,
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
      const failure = refusal(error, method, context.signal)
      if (!failure) throw error
      return context.error("failed", new ScriptError(failure).message, { code: failure.code, next: failure.next })
    }
  }

  /** The failure a script reads, or undefined for a host error that propagates unchanged. */
  const refusal = (error: unknown, method: Target | undefined, signal: AbortSignal): Failure | undefined => {
    if (signal.aborted) return fail("CANCELLED", "the call was cancelled").failure
    if (error instanceof ScriptError) return error.failure
    const own = pluginError(error)
    if (own || !method || !toolError(error)) return own
    // A deny, or an ask the hook refused, carries its cause; an upstream failure (MCP `isError`) has none.
    if (error.error !== undefined) return denied(method.action, error).failure
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
        const reason: Code | undefined = !managed ? "SERVER_CONFLICT" : tool ? undefined : (connection(status) ?? "TOOL_UNAVAILABLE")
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
          input,
          output: mcpOutput(output),
        })
      }
    }
    for (const spec of owned)
      methods.push({ name: spec.name, tool: spec.name, kind: "plugin", action: spec.action, description: spec.description, available: true, input: spec.input, output: spec.output })
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
        ...(typeof value["sessionID"] === "string" && value["sessionID"] !== "" ? [] : [`"sessionID" must be a non-empty string`]),
        ...(value["account"] === undefined || (typeof value["account"] === "string" && value["account"] !== "") ? [] : [`"account" must be a non-empty string`]),
        ...(!("input" in value) ? [`"input" is missing`] : objectInput && !plainObject(value["input"]) ? [`"input" must be an object`] : []),
      ],
    )
  const contract = Rpc.define({
    id: TOOLS_RPC_ID,
    methods: {
      describe: { input: NO_INPUT, output: DESCRIPTION },
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
    if (evaluation.effect !== "ask" || evaluation.source === undefined || !live.has(evaluation.source.id)) return
    evaluation.effect = "deny"
    evaluation.message = UNATTENDED
  })

  return async () => {
    await hook.dispose().catch(() => undefined)
    await registration.dispose().catch(() => undefined)
  }
}
