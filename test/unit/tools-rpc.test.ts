// Unit tests for the shared tools RPC module, against narrow fakes of the public plugin context. A copy in a plugin
// repository changes only the two imports below: its test runner, and the path of its copy of the module.
import { describe, expect, test } from "bun:test"
import {
  hidden,
  KNOWN_READS,
  NEXT_STEPS,
  PLUGIN_ID,
  pluginError,
  registerToolsRpc,
  shapeResult,
  TOOLS_RPC_ID,
  upstreamText,
  type OwnedMethod,
  type ToolCall,
  type ToolsRpcOptions,
} from "../../src/host/tools-rpc.js"

type Effect = "allow" | "deny" | "ask"
type Rule = { action: string; resource: string; effect: Effect }
type Evaluation = { sessionID: string; agent?: string; action: string; resources: string[]; source?: { type: "tool"; messageID: string; id: string }; effect: Effect; message?: string }
type RpcContext = { signal: AbortSignal; error: (type: string, message: string, data?: unknown) => unknown }
type Handler = (input: unknown, context: RpcContext) => Promise<any>
type Result = { output?: unknown; content?: string | { type: "text"; text: string }[] }
type Execute = (input: unknown, call: ToolCall) => Promise<Result>

const SERVER = "srv"
const hostMatch = (pattern: string, value: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(value)
const LOCATION = "/tmp/tools-rpc-test"
const rule = (action: string, effect: Effect, resource = "*"): Rule => ({ action, resource, effect })
const READ = KNOWN_READS[0]!
const ID = `${SERVER}_${READ}`
/**
 * The MCP path needs a known read. A plugin whose tools are all its own (Utilities) has none: there the MCP tests do
 * not apply, and the plugin-owned tests below cover sessions, permissions, the hook and cancellation on their own.
 */
const MCP = KNOWN_READS.length > 0
/** Registers an MCP-only test, or nothing when the plugin has no known reads. A plain if: some repos' scans ban skip calls. */
const mcpTest = (name: string, body: () => unknown): void => {
  if (MCP) test(name, body as () => Promise<void>)
}
/** Registers a block made only of MCP tests, or nothing: vitest fails a suite with no tests. */
const mcpDescribe = (name: string, body: () => void): void => {
  if (MCP) describe(name, body)
}
/** A prefix check that bun:test and vitest both run (toStartWith is bun's alone). */
const expectStartsWith = (actual: string, prefix: string): void => {
  expect(actual.slice(0, prefix.length)).toBe(prefix)
}

/** A Tool.Error as OpenCode's executor rejects with it: a permission refusal carries a cause, an upstream failure none. */
const toolError = (message: string, cause?: unknown) => Object.assign(new Error(message), { _tag: "Tool.Error", ...(cause === undefined ? {} : { error: cause }) })

interface Setup {
  /** Sessions the host knows: agent and the session's own rules. */
  sessions?: Record<string, { agent?: string; permissions?: Rule[] }>
  /** Agents and their rules; a missing agent is OpenCode's Agent.NotFoundError. */
  agents?: Record<string, Rule[]>
  /** The executor of each listed MCP tool. By default every tool on `srv` succeeds. */
  tools?: Record<string, Execute | undefined>
  /** The `srv` server's MCP status; "connected" by default. */
  status?: string
  managed?: boolean
  server?: ToolsRpcOptions["mcp"] extends infer M ? (M extends { server: infer S } ? S : never) : never
  owned?: OwnedMethod[]
  mcp?: false
  lookup?: (sessionID: string) => Promise<unknown>
  unavailableDetail?: NonNullable<ToolsRpcOptions["mcp"]>["unavailableDetail"]
  notRegistered?: NonNullable<ToolsRpcOptions["mcp"]>["notRegistered"]
}

interface Harness {
  contract: { id: string; methods: Record<string, { input: any; output: any; errors?: Record<string, any> }> }
  handlers: Record<string, Handler>
  hook: (evaluation: Evaluation) => void
  calls: { tool: string; input: unknown; call: ToolCall }[]
  evaluations: Evaluation[]
  disposed: string[]
  stop: () => Promise<void>
}

const echo: Execute = async (input) => ({ output: { echoed: input }, content: [{ type: "text", text: "line one" }, { type: "text", text: "line two" }] })

async function setup(options: Setup = {}): Promise<Harness> {
  const sessions = options.sessions ?? { ses_1: { agent: "build" } }
  const agents = options.agents ?? { build: [rule("*", "allow")] }
  const tools = options.tools ?? Object.fromEntries(KNOWN_READS.map((name) => [`${SERVER}_${name}`, echo]))
  const calls: Harness["calls"] = []
  const evaluations: Evaluation[] = []
  const disposed: string[] = []
  let contract: Harness["contract"] | undefined
  let handlers: Record<string, Handler> = {}
  let hook: Harness["hook"] = () => {}
  /** The host's check inside the executor: the agent's rules, then the session's, then the evaluate hook. */
  const check = (call: ToolCall, action: string) => {
    const rules = [...(agents[call.agent] ?? []), ...(sessions[call.sessionID]?.permissions ?? [])]
    const effect = rules.findLast((entry) => hostMatch(entry.action, action) && hostMatch(entry.resource, "*"))?.effect ?? "ask"
    const evaluation: Evaluation = { sessionID: call.sessionID, agent: call.agent, action, resources: ["*"], source: { type: "tool", messageID: call.messageID, id: call.id }, effect }
    hook(evaluation)
    evaluations.push(evaluation)
    if (evaluation.effect === "deny") throw toolError(evaluation.message ?? `Permission denied: ${action}`, new Error("denied"))
    if (evaluation.effect === "ask") throw new Error("the test host has no one to answer a prompt")
  }
  const ctx = {
    location: { directory: LOCATION },
    rpc: {
      register: async (definition: Harness["contract"], registered: Record<string, Handler>) => {
        contract = definition
        handlers = registered
        return { dispose: async () => void disposed.push("rpc"), events: { emit: async () => {} } }
      },
    },
    permission: {
      hook: async (name: string, callback: Harness["hook"]) => {
        expect(name).toBe("evaluate")
        hook = callback
        return { dispose: async () => void disposed.push("hook") }
      },
      assert: async () => {},
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        if (options.lookup) return options.lookup(sessionID)
        const session = sessions[sessionID]
        if (!session) throw Object.assign(new Error(`Session not found: ${sessionID}`), { _tag: "Session.NotFoundError" })
        return { id: sessionID, location: { directory: LOCATION }, ...session }
      },
    },
    agent: {
      get: async ({ agentID, location }: { agentID: string; location: { directory: string } }) => {
        expect(location).toEqual({ directory: LOCATION })
        const permissions = agents[agentID]
        if (!permissions) throw Object.assign(new Error(`Agent not found: ${agentID}`), { _tag: "Agent.NotFoundError" })
        return { location, data: { id: agentID, permissions } }
      },
    },
    tool: {
      list: async () =>
        Object.entries(tools).map(([id, execute]) => ({
          id,
          name: id,
          description: `${id} (test)`,
          input: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
          execute: async (input: unknown, call: ToolCall) => {
            calls.push({ tool: id, input, call })
            check(call, id)
            return (execute ?? echo)(input, call)
          },
        })),
    },
    mcp: { list: async () => ({ data: [{ name: SERVER, status: { status: options.status ?? "connected" } }] }) },
  }
  const stop = await registerToolsRpc(ctx as never, {
    ...(options.mcp === false
      ? {}
      : {
          mcp: {
            server: options.server ?? SERVER,
            managed: () => options.managed ?? true,
            ...(options.unavailableDetail ? { unavailableDetail: options.unavailableDetail } : {}),
            ...(options.notRegistered ? { notRegistered: options.notRegistered } : {}),
          },
        }),
    ...(options.owned ? { owned: options.owned } : {}),
  })
  return { contract: contract!, handlers, hook: (evaluation) => hook(evaluation), calls, evaluations, disposed, stop }
}

function rpcContext(signal = new AbortController().signal): RpcContext {
  return { signal, error: (type, message, data) => ({ type, message, data, handlerError: true }) }
}

const call = (h: Harness, method: string, input: unknown = { query: "q" }, sessionID = "ses_1", context = rpcContext()) =>
  h.handlers[method]!({ sessionID, input }, context)

/** Matches a refusal. Bun's toMatchObject writes its matchers into the value it checks, so it checks a copy. */
const refusedWith = (value: unknown, code: string) => expect(structuredClone(value)).toMatchObject(failure(code))

const failure = (code: string) => ({
  type: "failed",
  handlerError: true,
  // Exactly one full stop before "Next step", even when the reason or upstream line ends with its own.
  message: expect.stringMatching(new RegExp(`^${code}: [^]*[^.\\s]\\. Next step: [^]+\\.$`)),
  data: { code, next: expect.stringMatching(/\.$/) },
})

describe("the contract", () => {
  test("is <plugin id>.tools with describe and one method per known read, nothing else", async () => {
    const h = await setup()
    expect(h.contract.id).toBe(TOOLS_RPC_ID)
    expect(TOOLS_RPC_ID).toBe(`${PLUGIN_ID}.tools`)
    expect(Object.keys(h.contract.methods).sort()).toEqual(["describe", ...KNOWN_READS].sort())
  })

  test("never makes an unknown or write tool a method, even when OpenCode lists it and a rule allows it", async () => {
    const h = await setup({ tools: { [ID]: echo, [`${SERVER}_delete_everything`]: echo, [`${SERVER}_new_tool`]: echo } })
    expect(Object.keys(h.contract.methods)).not.toContain("delete_everything")
    expect(Object.keys(h.contract.methods)).not.toContain("new_tool")
    expect(h.handlers["delete_everything"]).toBeUndefined()
  })

  mcpTest("takes the strict envelope {sessionID, input} and declares one error, failed: {code, next}, as plain JSON Schema", async () => {
    const h = await setup()
    const method = h.contract.methods[READ]!
    expect(method.input).toEqual({
      type: "object",
      properties: { sessionID: { type: "string", minLength: 1 }, input: { type: "object" } },
      required: ["sessionID", "input"],
      additionalProperties: false,
    })
    expect(method.output).toMatchObject({ type: "object", required: ["text"], additionalProperties: false })
    expect(method.errors).toEqual({ failed: { type: "object", properties: { code: { type: "string" }, next: { type: "string" } }, required: ["code", "next"], additionalProperties: false } })
    expect(JSON.parse(JSON.stringify(h.contract))).toEqual(h.contract)
    expect(JSON.parse(JSON.stringify(method.input))).toEqual(method.input)
  })

  mcpTest("refuses an envelope with an unknown key, a missing or empty sessionID, or an input that is not an object", async () => {
    const h = await setup()
    const validate = (value: unknown) => h.contract.methods[READ]!.input["~standard"].validate(value)
    expect(validate({ sessionID: "ses_1", input: { query: "q" } })).toEqual({ value: { sessionID: "ses_1", input: { query: "q" } } })
    const messages = (value: unknown) => validate(value).issues?.map((issue: { message: string }) => issue.message)
    expect(messages({ sessionID: "ses_1", input: {}, extra: true })).toEqual([`"extra" is not allowed`])
    expect(messages({ input: {} })).toEqual([`"sessionID" must be a non-empty string`])
    expect(messages({ sessionID: "", input: {} })).toEqual([`"sessionID" must be a non-empty string`])
    expect(messages({ sessionID: "ses_1" })).toEqual([`"input" is missing`])
    expect(messages({ sessionID: "ses_1", input: ["q"] })).toEqual([`"input" must be an object`])
    expect(messages({ sessionID: "ses_1", account: "work", input: {} })).toEqual([`"account" is not allowed`])
    expect(messages("text")).toEqual([`the envelope must be an object, such as {"sessionID":"<session>","input":<the tool's input>}`])
  })

  test("describe takes nothing or an empty object; any other input gets one plain message", async () => {
    const h = await setup()
    const input = h.contract.methods.describe!.input
    expect(input).toEqual({ type: "object", properties: {}, required: [], additionalProperties: false })
    for (const value of [undefined, null, {}]) expect(input["~standard"].validate(value)).toEqual({ value })
    for (const value of [{ sessionID: "ses_1" }, { sessionID: "ses_1", input: {} }, "text", []]) {
      expect(input["~standard"].validate(value)).toEqual({ issues: [{ message: "describe takes no input" }] })
    }
  })

  test("gives every code one next step that ends with a full stop", () => {
    for (const [code, next] of Object.entries(NEXT_STEPS)) expect({ code, next }).toEqual({ code, next: expect.stringMatching(/^[A-Z].*\.$/) })
  })
})

mcpDescribe("describe", () => {
  mcpTest("lists each known read with its live JSON Schema, its permission action and whether it is available", async () => {
    const h = await setup({ tools: { [ID]: echo } })
    const description = await h.handlers.describe!({}, rpcContext())
    expect(JSON.parse(JSON.stringify(description))).toEqual(description)
    expect(structuredClone(description)).toMatchObject({ id: TOOLS_RPC_ID, location: LOCATION, call: expect.stringContaining(`/api/rpc/${TOOLS_RPC_ID}/<method>`) })
    expect(description.methods.map((method: { name: string }) => method.name)).toEqual([...KNOWN_READS])
    expect(description.methods[0]).toEqual({
      name: READ,
      tool: ID,
      kind: "mcp",
      action: ID,
      description: `${ID} (test)`,
      available: true,
      input: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      output: { type: "object", properties: { output: {}, text: { type: "string" } }, required: ["text"], additionalProperties: false },
    })
    for (const method of description.methods.slice(1)) expect(method).toMatchObject({ available: false, reason: "TOOL_UNAVAILABLE" })
  })

  mcpTest("gives the connection state as the reason while the server is not connected, and SERVER_CONFLICT for a server it does not manage", async () => {
    const auth = await setup({ tools: {}, status: "needs_auth" })
    for (const method of (await auth.handlers.describe!({}, rpcContext())).methods) expect(method).toMatchObject({ available: false, reason: "AUTH_REQUIRED" })
    const conflict = await setup({ managed: false })
    for (const method of (await conflict.handlers.describe!({}, rpcContext())).methods) expect(method).toMatchObject({ available: false, reason: "SERVER_CONFLICT" })
  })

  mcpTest("adds the unavailableDetail hook's text as detail beside the reason code; without the hook, no detail", async () => {
    const seen: [string, string][] = []
    const detail = (method: string, code: string) => (seen.push([method, code]), method === READ ? `Turn on ${method}'s toolset with the toolsets option.` : undefined)
    const h = await setup({ tools: {}, unavailableDetail: detail })
    const methods = (await h.handlers.describe!({}, rpcContext())).methods
    expect(methods[0]).toMatchObject({ name: READ, available: false, reason: "TOOL_UNAVAILABLE", detail: `Turn on ${READ}'s toolset with the toolsets option.` })
    for (const method of methods.slice(1)) expect(Object.hasOwn(method, "detail")).toBe(false)
    expect(seen).toEqual(KNOWN_READS.map((name) => [name, "TOOL_UNAVAILABLE"]))
    expect(h.contract.methods.describe!.output.properties.methods.items.properties.detail).toEqual({ type: "string" })
    // A listed method never asks the hook; the code it gets is the reason, such as a connection state.
    seen.length = 0
    const listed = await setup({ unavailableDetail: detail })
    expect((await listed.handlers.describe!({}, rpcContext())).methods.every((method: object) => !Object.hasOwn(method, "detail"))).toBe(true)
    expect(seen).toEqual([])
    await (await setup({ tools: {}, status: "needs_auth", unavailableDetail: detail })).handlers.describe!({}, rpcContext())
    expect(seen[0]).toEqual([READ, "AUTH_REQUIRED"])
    for (const method of (await (await setup({ tools: {} })).handlers.describe!({}, rpcContext())).methods) expect(Object.hasOwn(method, "detail")).toBe(false)
  })

  mcpTest("gives the notRegistered hook's code as the reason while the server is not registered, and only then", async () => {
    const own = { code: "CLIENT_ID_MISSING", next: "Set the client ID." }
    const absent = await setup({ tools: {}, status: "absent", notRegistered: () => own })
    for (const method of (await absent.handlers.describe!({}, rpcContext())).methods) expect(method).toMatchObject({ available: false, reason: "CLIENT_ID_MISSING" })
    const fallback = await setup({ tools: {}, status: "absent", notRegistered: () => undefined })
    for (const method of (await fallback.handlers.describe!({}, rpcContext())).methods) expect(method).toMatchObject({ reason: "NOT_REGISTERED" })
    const auth = await setup({ tools: {}, status: "needs_auth", notRegistered: () => own })
    for (const method of (await auth.handlers.describe!({}, rpcContext())).methods) expect(method).toMatchObject({ reason: "AUTH_REQUIRED" })
  })
})

mcpDescribe("a script's call", () => {
  mcpTest("runs the host executor as the session's agent, with a call id of its own, and returns {output, text}", async () => {
    const h = await setup()
    const output = await call(h, READ, { query: "hello" })
    expect(output).toEqual(JSON.parse(JSON.stringify(shapeResult(READ, { output: { echoed: { query: "hello" } }, text: "line one\nline two" }))))
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]).toMatchObject({ tool: ID, input: { query: "hello" }, call: { sessionID: "ses_1", agent: "build", messageID: expect.any(String), id: expect.stringMatching(/^script:/) } })
    expect(h.evaluations).toEqual([expect.objectContaining({ action: ID, effect: "allow", source: { type: "tool", messageID: h.calls[0]!.call.messageID, id: h.calls[0]!.call.id } })])
  })

  mcpTest("returns only text when the tool has no structured content, as plain JSON", async () => {
    const h = await setup({ tools: { [ID]: async () => ({ content: "just text", output: undefined }) } })
    const output = await call(h, READ)
    expect(output).toEqual(JSON.parse(JSON.stringify(shapeResult(READ, { text: "just text" }))))
    expect(Object.hasOwn(output, "output")).toBe(false)
  })

  mcpTest("gives each call its own id", async () => {
    const h = await setup()
    await call(h, READ)
    await call(h, READ)
    expect(new Set(h.calls.map((entry) => entry.call.id)).size).toBe(2)
  })
})

mcpDescribe("sessions", () => {
  mcpTest("refuses an unknown session with SESSION_UNKNOWN, also for a 404, before any tool runs", async () => {
    refusedWith(await call(await setup(), READ, {}, "ses_missing"), "SESSION_UNKNOWN")
    const h = await setup({ lookup: async () => Promise.reject(Object.assign(new Error("Not Found"), { status: 404 })) })
    refusedWith(await call(h, READ), "SESSION_UNKNOWN")
    expect(h.calls).toEqual([])
  })

  mcpTest("lets any other session lookup failure propagate unchanged", async () => {
    const problem = Object.assign(new Error("database is locked"), { _tag: "Storage.Error" })
    const h = await setup({ lookup: async () => Promise.reject(problem) })
    await expect(call(h, READ)).rejects.toBe(problem)
    expect(h.calls).toEqual([])
  })

  mcpTest("refuses a session with no agent, or an agent that does not exist, with SESSION_AGENT_REQUIRED", async () => {
    const h = await setup({ sessions: { ses_none: {}, ses_gone: { agent: "gone" } } })
    refusedWith(await call(h, READ, {}, "ses_none"), "SESSION_AGENT_REQUIRED")
    refusedWith(await call(h, READ, {}, "ses_gone"), "SESSION_AGENT_REQUIRED")
    expect(h.calls).toEqual([])
  })
})

mcpDescribe("permissions", () => {
  mcpTest("refuses a tool the agent's rules hide from the model, before the executor runs", async () => {
    const h = await setup({ agents: { build: [rule("*", "allow"), rule(`${SERVER}_*`, "deny")] } })
    const refused = await call(h, READ)
    refusedWith(refused, "PERMISSION_DENIED")
    expect(refused.message).toContain(ID)
    expect(h.calls).toEqual([])
  })

  mcpTest("applies the session's rules after the agent's: a session deny narrows, a session allow reopens", async () => {
    const h = await setup({
      sessions: {
        narrow: { agent: "build", permissions: [rule(ID, "deny")] },
        reopen: { agent: "locked", permissions: [rule(ID, "allow")] },
      },
      agents: { build: [rule("*", "allow")], locked: [rule("*", "allow"), rule(`${SERVER}_*`, "deny")] },
    })
    refusedWith(await call(h, READ, {}, "narrow"), "PERMISSION_DENIED")
    expect(await call(h, READ, {}, "reopen")).toMatchObject({ text: "line one\nline two" })
  })

  mcpTest("a deny on another resource does not hide the tool; the executor's own check decides", async () => {
    const h = await setup({ agents: { build: [rule("*", "allow"), rule(ID, "deny", "something")] } })
    expect(await call(h, READ)).toMatchObject({ text: expect.any(String) })
  })

  mcpTest("turns the executor's permission refusal (a Tool.Error with a cause) into PERMISSION_DENIED", async () => {
    const h = await setup({ tools: { [ID]: async () => Promise.reject(toolError("Permission denied: srv_x", new Error("rule"))) } })
    refusedWith(await call(h, READ), "PERMISSION_DENIED")
  })

  mcpTest("names the action of the request a refusal carries, in the message and the next step, when it is not the method's", async () => {
    const cause = Object.assign(new Error("denied"), { request: { sessionID: "ses_1", action: `${SERVER}_other`, resources: ["*"] } })
    const h = await setup({ tools: { [ID]: async () => Promise.reject(toolError(`Permission denied: ${SERVER}_other`, cause)) } })
    const refused = await call(h, READ)
    refusedWith(refused, "PERMISSION_DENIED")
    expectStartsWith(refused.message, `PERMISSION_DENIED: ${ID} needs ${SERVER}_other, which was refused for this session's agent: `)
    expect(refused.data.next).toBe(`Add an allow rule for ${SERVER}_other to the session's agent or to the session, or use a session whose agent allows it.`)
  })

  mcpTest("keeps the plugin's next step when the refused request is the method's own", async () => {
    const h = await setup({ agents: { build: [rule("*", "allow"), rule(ID, "ask")] } })
    const refused = await call(h, READ)
    expectStartsWith(refused.message, `PERMISSION_DENIED: ${ID} was refused for this session's agent: `)
    expect(refused.data.next).toBe(NEXT_STEPS.PERMISSION_DENIED)
  })

  mcpTest("refuses an ask at once: the hook turns this call's ask into a deny, and no prompt is left", async () => {
    const h = await setup({ agents: { build: [rule("*", "allow"), rule(ID, "ask")] } })
    const refused = await call(h, READ)
    refusedWith(refused, "PERMISSION_DENIED")
    expect(refused.message).toMatch(/cannot answer an approval prompt/)
    expect(h.evaluations).toEqual([expect.objectContaining({ action: ID, effect: "deny" })])
  })

  mcpTest("the hook leaves every other evaluation alone: other ids, no source, a finished call, allows and denies", async () => {
    const h = await setup()
    await call(h, READ)
    const finished = h.calls[0]!.call.id
    const base: Evaluation = { sessionID: "ses_1", agent: "build", action: ID, resources: ["*"], effect: "ask" }
    for (const untouched of [
      { ...base },
      { ...base, source: { type: "tool" as const, messageID: "msg_model", id: "call_model" } },
      { ...base, source: { type: "tool" as const, messageID: "msg_script", id: finished } },
      { ...base, source: { type: "tool" as const, messageID: "msg_script", id: "script:not-live" } },
    ]) {
      const before = structuredClone(untouched)
      h.hook(untouched)
      expect(untouched).toEqual(before)
    }
  })

  mcpTest("the hook only tightens: it never changes an allow or a deny of a live call", async () => {
    let observed: Evaluation[] = []
    const h: Harness = await setup({
      tools: {
        [ID]: async (_input, live) => {
          observed = (["allow", "deny"] as const).map((effect) => {
            const evaluation: Evaluation = { sessionID: "ses_1", action: ID, resources: ["*"], source: { type: "tool", messageID: live.messageID, id: live.id }, effect }
            h.hook(evaluation)
            return evaluation
          })
          return { content: "ok" }
        },
      },
    })
    await call(h, READ)
    expect(observed.map((evaluation) => [evaluation.effect, evaluation.message])).toEqual([["allow", undefined], ["deny", undefined]])
  })
})

mcpDescribe("server and tool state", () => {
  mcpTest("refuses with SERVER_CONFLICT while the server name belongs to a server the plugin does not manage", async () => {
    const h = await setup({ managed: false })
    refusedWith(await call(h, READ), "SERVER_CONFLICT")
    expect(h.calls).toEqual([])
  })

  mcpTest("names the connection state when the tool is missing, and TOOL_UNAVAILABLE when the server is connected", async () => {
    const states: [string, string][] = [["pending", "CONNECTING"], ["needs_auth", "AUTH_REQUIRED"], ["failed", "CONNECTION_FAILED"], ["disabled", "DISABLED"], ["absent", "NOT_REGISTERED"], ["connected", "TOOL_UNAVAILABLE"]]
    for (const [status, code] of states) refusedWith(await call(await setup({ tools: {}, status }), READ), code)
  })

  mcpTest("maps OpenCode's \"MCP server is not connected\" error from the executor to the connection state", async () => {
    const h = await setup({ status: "needs_auth", tools: { [ID]: async () => Promise.reject(new Error(`MCP server "${SERVER}" is not connected`)) } })
    refusedWith(await call(h, READ), "AUTH_REQUIRED")
  })

  mcpTest("gives CONNECTING, not CONNECTION_FAILED, when that error comes from a server that reads connected again", async () => {
    const h = await setup({ status: "connected", tools: { [ID]: async () => Promise.reject(new Error(`MCP server "${SERVER}" is not connected`)) } })
    const refused = await call(h, READ)
    refusedWith(refused, "CONNECTING")
    expect(refused.data.next).toBe(NEXT_STEPS.CONNECTING)
    expect(refused.message).toContain(`the "${SERVER}" server was reconnecting when ${ID} ran`)
  })

  mcpTest("uses the notRegistered hook's code and next step while the server is not registered; undefined keeps NOT_REGISTERED", async () => {
    let own: { code: string; next: string } | undefined = { code: "CLIENT_ID_MISSING", next: "Run /connect and set the client ID." }
    const servers: string[] = []
    const notRegistered = (server: string) => (servers.push(server), own)
    const missing = await call(await setup({ tools: {}, status: "absent", notRegistered }), READ)
    refusedWith(missing, "CLIENT_ID_MISSING")
    expect(missing.message).toBe(`CLIENT_ID_MISSING: the "${SERVER}" server is not registered. Next step: Run /connect and set the client ID.`)
    expect(missing.data).toEqual({ code: "CLIENT_ID_MISSING", next: "Run /connect and set the client ID." })
    expect(servers).toEqual([SERVER])
    // The executor's "not connected" error while the server is gone takes the same path.
    const gone = await setup({ status: "absent", notRegistered, tools: { [ID]: async () => Promise.reject(new Error(`MCP server "${SERVER}" is not connected`)) } })
    refusedWith(await call(gone, READ), "CLIENT_ID_MISSING")
    // Other states never ask the hook.
    servers.length = 0
    refusedWith(await call(await setup({ tools: {}, status: "failed", notRegistered }), READ), "CONNECTION_FAILED")
    expect(servers).toEqual([])
    own = undefined
    const plain = await call(await setup({ tools: {}, status: "absent", notRegistered }), READ)
    refusedWith(plain, "NOT_REGISTERED")
    expect(plain.data.next).toBe(NEXT_STEPS.NOT_REGISTERED)
  })
})

mcpDescribe("upstream failures", () => {
  mcpTest("an upstream error (a Tool.Error without a cause) is UPSTREAM_ERROR with its first line, redacted and cut to 300 characters", async () => {
    const text = `Bad request for https://files.example.com/a.pdf?X-Amz-Signature=abc123def456&X-Amz-Credential=zzz with Bearer tvly-secretkey123456 ${"x ".repeat(200)}\nsecond line with more detail`
    const h = await setup({ tools: { [ID]: async () => Promise.reject(toolError(text)) } })
    const refused = await call(h, READ)
    refusedWith(refused, "UPSTREAM_ERROR")
    expect(refused.message).toContain("https://files.example.com/a.pdf?[redacted]")
    for (const secret of ["abc123def456", "zzz", "tvly-secretkey123456", "second line"]) expect(refused.message).not.toContain(secret)
  })

  mcpTest("any other executor failure is OpenCode's own error and propagates unchanged", async () => {
    const problem = new Error("the host is shutting down")
    const h = await setup({ tools: { [ID]: async () => Promise.reject(problem) } })
    await expect(call(h, READ)).rejects.toBe(problem)
  })

  mcpTest("a cancelled call is CANCELLED, before or during the run", async () => {
    const before = new AbortController()
    before.abort()
    const h = await setup()
    refusedWith(await call(h, READ, {}, "ses_1", rpcContext(before.signal)), "CANCELLED")
    expect(h.calls).toEqual([])
    const during = new AbortController()
    const slow = await setup({ tools: { [ID]: async () => (during.abort(), Promise.reject(new Error("aborted"))) } })
    refusedWith(await call(slow, READ, {}, "ses_1", rpcContext(during.signal)), "CANCELLED")
  })
})

describe("upstreamText", () => {
  test("keeps the first non-empty line and redacts tokens, keys and signed URLs", () => {
    expect(upstreamText("\n  Invalid query  \nstack")).toBe("Invalid query")
    expect(upstreamText("")).toBe("no message")
    const line = upstreamText(
      `token=abc12345 api_key: "k-1234567890" Authorization: Bearer eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl ghp_abcdefghijklmnop xoxb-1234567890-abc sk-abcdefghijkl ${"A".repeat(48)} https://x.example/p#frag`,
    )
    for (const secret of ["abc12345", "k-1234567890", "eyJhbGciOi", "ghp_abcdefghijklmnop", "xoxb-1234567890", "sk-abcdefghijkl", "A".repeat(48), "frag"]) expect(line).not.toContain(secret)
    expect(line).toContain("https://x.example/p?[redacted]")
  })

  test("keeps ordinary words, numbers and URL paths", () => {
    expect(upstreamText("error code: 429 for https://example.com/search/results, retry later")).toBe("error code: 429 for https://example.com/search/results, retry later")
  })

  test("cuts at 300 characters", () => {
    const cut = upstreamText("word ".repeat(100))
    expect(cut.length).toBe(300)
    expect(cut.endsWith("…")).toBe(true)
  })
})

describe("hidden", () => {
  test("is true only when the last rule matching the action on * is a deny", () => {
    expect(hidden([rule("*", "allow")], ID)).toBe(false)
    expect(hidden([rule("*", "allow"), rule(`${SERVER}_*`, "deny")], ID)).toBe(true)
    expect(hidden([rule(`${SERVER}_*`, "deny"), rule(ID, "allow")], ID)).toBe(false)
    expect(hidden([rule(`${SERVER}_*`, "deny"), rule(ID, "ask")], ID)).toBe(false)
    expect(hidden([rule(ID, "deny", "x")], ID)).toBe(false)
    expect(hidden([], ID)).toBe(false)
  })
})

describe("plugin-owned methods", () => {
  const owned = (run: OwnedMethod["run"]): OwnedMethod => ({
    name: "owned_read",
    action: "plugin_owned_read",
    description: "A plugin-owned read",
    input: { type: "object", properties: { n: { type: "integer" } }, additionalProperties: false },
    output: { type: "object", properties: { n: { type: "integer" } } },
    run,
  })

  test("run their own spec as the session, return its output as JSON, and take the spec's input schema in the envelope", async () => {
    const seen: ToolCall[] = []
    const h = await setup({ owned: [owned(async (input, live) => (seen.push(live), { n: (input as { n: number }).n + 1, dropped: undefined }))] })
    expect(await call(h, "owned_read", { n: 1 })).toEqual({ n: 2 })
    expect(seen[0]).toMatchObject({ sessionID: "ses_1", agent: "build", id: expect.stringMatching(/^script:/) })
    expect(h.contract.methods.owned_read!.input.properties.input).toEqual(owned(async () => null).input)
    // The spec checks its own input; the envelope only needs one.
    expect(h.contract.methods.owned_read!.input["~standard"].validate({ sessionID: "ses_1", input: "any" })).toEqual({ value: { sessionID: "ses_1", input: "any" } })
    const description = await h.handlers.describe!({}, rpcContext())
    expect(description.methods.at(-1)).toMatchObject({ name: "owned_read", kind: "plugin", action: "plugin_owned_read", available: true })
  })

  test("are hidden by a deny rule on their action, and their own refused assert is PERMISSION_DENIED", async () => {
    const hiddenOwned = await setup({ owned: [owned(async () => ({}))], agents: { build: [rule("*", "allow"), rule("plugin_*", "deny")] } })
    refusedWith(await call(hiddenOwned, "owned_read", {}), "PERMISSION_DENIED")
    const refused = await setup({ owned: [owned(async () => Promise.reject(toolError("Permission denied: plugin_owned_read", new Error("rule"))))] })
    refusedWith(await call(refused, "owned_read", {}), "PERMISSION_DENIED")
  })

  test("an ask from their own assert, which passes the call's source, is refused by the hook", async () => {
    let asked: Evaluation | undefined
    const h: Harness = await setup({
      owned: [
        owned(async (_input, live) => {
          asked = { sessionID: live.sessionID, action: "plugin_owned_read", resources: ["*"], source: { type: "tool", messageID: live.messageID, id: live.id }, effect: "ask" }
          h.hook(asked)
          throw toolError(asked.message!, new Error("hook"))
        }),
      ],
    })
    refusedWith(await call(h, "owned_read", {}), "PERMISSION_DENIED")
    expect(asked).toMatchObject({ effect: "deny", message: expect.stringMatching(/cannot answer an approval prompt/) })
  })

  test("a refused check of another action, such as a download a transcription asks for, names that action", async () => {
    let calls = 0
    const h: Harness = await setup({
      owned: [
        owned(async (_input, live) => {
          // The first call's check of another action asks; the second call's own check is denied by a rule.
          if (calls++ > 0) throw toolError("Permission denied: plugin_owned_read", new Error("rule"))
          const asked: Evaluation = { sessionID: live.sessionID, action: "plugin_download", resources: ["*"], source: { type: "tool", messageID: live.messageID, id: live.id }, effect: "ask" }
          h.hook(asked)
          throw toolError(asked.message!, new Error("hook"))
        }),
      ],
    })
    const refused = await call(h, "owned_read", {})
    refusedWith(refused, "PERMISSION_DENIED")
    expectStartsWith(refused.message, "PERMISSION_DENIED: plugin_owned_read needs plugin_download, which was refused for this session's agent: A script cannot answer")
    expect(refused.data.next).toBe("Add an allow rule for plugin_download to the session's agent or to the session, or use a session whose agent allows it.")
    // The next call starts clean: its own refusal names its own action.
    const again = await call(h, "owned_read", {})
    expectStartsWith(again.message, "PERMISSION_DENIED: plugin_owned_read was refused")
    expect(again.data.next).toBe(NEXT_STEPS.PERMISSION_DENIED)
  })

  test("a failure that is not a permission refusal propagates, unless pluginError names it", async () => {
    const problem = new Error("plugin bug")
    const h = await setup({ owned: [owned(async () => Promise.reject(problem))] })
    if (pluginError(problem) === undefined) await expect(call(h, "owned_read", {})).rejects.toBe(problem)
    else expect(await call(h, "owned_read", {})).toMatchObject({ type: "failed" })
  })

  test("describe reports the reason available() gives as unavailable, read at each describe; without it, available", async () => {
    let reason: string | undefined = "MODULE_OFF"
    const h = await setup({ owned: [{ ...owned(async () => ({})), available: async () => reason }, { ...owned(async () => ({})), name: "plain", available: () => undefined }] })
    const methods = async () => (await h.handlers.describe!({}, rpcContext())).methods.filter((method: { kind: string }) => method.kind === "plugin")
    expect(await methods()).toEqual([
      expect.objectContaining({ name: "owned_read", available: false, reason: "MODULE_OFF" }),
      expect.objectContaining({ name: "plain", available: true }),
    ])
    reason = undefined
    const now = await methods()
    expect(now[0]).toMatchObject({ name: "owned_read", available: true })
    expect(Object.hasOwn(now[0], "reason")).toBe(false)
    expect(Object.hasOwn(now[1], "reason")).toBe(false)
  })

  test("available() never gates a call: run decides, with its own error", async () => {
    const h = await setup({ owned: [{ ...owned(async () => ({ ran: true })), available: () => "MODULE_OFF" }] })
    expect(await call(h, "owned_read", {})).toEqual({ ran: true })
  })

  test("take the strict envelope: an unknown key, or a missing sessionID or input, is refused", async () => {
    const h = await setup({ owned: [owned(async () => ({}))] })
    const messages = (value: unknown) => h.contract.methods.owned_read!.input["~standard"].validate(value).issues?.map((issue: { message: string }) => issue.message)
    expect(messages({ sessionID: "ses_1", input: {}, extra: true })).toEqual([`"extra" is not allowed`])
    expect(messages({ input: {} })).toEqual([`"sessionID" must be a non-empty string`])
    expect(messages({ sessionID: "ses_1" })).toEqual([`"input" is missing`])
  })

  test("refuse an unknown session, a session with no agent and a missing agent before the spec runs", async () => {
    let runs = 0
    const h = await setup({ owned: [owned(async () => (runs++, {}))], sessions: { ses_none: {}, ses_gone: { agent: "gone" } } })
    refusedWith(await call(h, "owned_read", {}, "ses_missing"), "SESSION_UNKNOWN")
    refusedWith(await call(h, "owned_read", {}, "ses_none"), "SESSION_AGENT_REQUIRED")
    refusedWith(await call(h, "owned_read", {}, "ses_gone"), "SESSION_AGENT_REQUIRED")
    expect(runs).toBe(0)
  })

  test("apply the session's rules after the agent's: a session deny hides, a session allow reopens", async () => {
    const h = await setup({
      owned: [owned(async () => ({ ran: true }))],
      sessions: { narrow: { agent: "build", permissions: [rule("plugin_owned_read", "deny")] }, reopen: { agent: "locked", permissions: [rule("plugin_owned_read", "allow")] } },
      agents: { build: [rule("*", "allow")], locked: [rule("*", "allow"), rule("plugin_*", "deny")] },
    })
    refusedWith(await call(h, "owned_read", {}, "narrow"), "PERMISSION_DENIED")
    expect(await call(h, "owned_read", {}, "reopen")).toEqual({ ran: true })
  })

  test("a call cancelled before or during the run is CANCELLED", async () => {
    let runs = 0
    const before = new AbortController()
    before.abort()
    const h = await setup({ owned: [owned(async () => (runs++, {}))] })
    refusedWith(await call(h, "owned_read", {}, "ses_1", rpcContext(before.signal)), "CANCELLED")
    expect(runs).toBe(0)
    const during = new AbortController()
    const slow = await setup({ owned: [owned(async () => (during.abort(), Promise.reject(new Error("aborted"))))] })
    refusedWith(await call(slow, "owned_read", {}, "ses_1", rpcContext(during.signal)), "CANCELLED")
  })

  test("the hook leaves a finished call's ask, and other calls' asks, alone", async () => {
    let finished = ""
    const h = await setup({ owned: [owned(async (_input, live) => ((finished = live.id), {}))] })
    await call(h, "owned_read", {})
    const base: Evaluation = { sessionID: "ses_1", agent: "build", action: "plugin_owned_read", resources: ["*"], effect: "ask" }
    for (const untouched of [{ ...base }, { ...base, source: { type: "tool" as const, messageID: "msg_script", id: finished } }, { ...base, source: { type: "tool" as const, messageID: "msg_model", id: "call_model" } }]) {
      const before = structuredClone(untouched)
      h.hook(untouched)
      expect(untouched).toEqual(before)
    }
  })

  test("need no MCP server when there are no known reads", async () => {
    const register = setup({ mcp: false, owned: [owned(async () => ({}))] })
    if (KNOWN_READS.length > 0) await expect(register).rejects.toThrow(/KNOWN_READS needs the mcp option/)
    else expect(Object.keys((await register).contract.methods).sort()).toEqual(["describe", "owned_read"])
  })
})

describe("per-account servers", () => {
  const accounts = (account: string | undefined) => (account === undefined ? SERVER : account === "work" ? "srv-work" : undefined)

  test("need NEXT_STEPS.ACCOUNT_UNKNOWN, take an optional account in the envelope and run on that account's server", async () => {
    if (NEXT_STEPS.ACCOUNT_UNKNOWN === undefined) {
      await expect(setup({ server: accounts })).rejects.toThrow(/ACCOUNT_UNKNOWN/)
      return
    }
    const h = await setup({ server: accounts, tools: { [ID]: echo, [`srv-work_${READ}`]: echo } })
    expect(h.contract.methods[READ]!.input.properties.account).toEqual({ type: "string", minLength: 1 })
    expect(h.contract.methods[READ]!.input["~standard"].validate({ sessionID: "ses_1", account: "", input: {} }).issues).toEqual([{ message: `"account" must be a non-empty string` }])
    await h.handlers[READ]!({ sessionID: "ses_1", account: "work", input: {} }, rpcContext())
    expect(h.calls.map((entry) => entry.tool)).toEqual([`srv-work_${READ}`])
    refusedWith(await h.handlers[READ]!({ sessionID: "ses_1", account: "nope", input: {} }, rpcContext()), "ACCOUNT_UNKNOWN")
  })

  /**
   * Runs a body with per-account servers allowed. A plugin without them has no ACCOUNT_UNKNOWN next step; the shared
   * part reads NEXT_STEPS when it runs, so the body sets one for its duration and removes it afterwards.
   */
  const withAccounts = async (body: () => Promise<void>) => {
    const steps = NEXT_STEPS as { ACCOUNT_UNKNOWN?: string }
    const had = steps.ACCOUNT_UNKNOWN !== undefined
    if (!had) steps.ACCOUNT_UNKNOWN = "Pass a known account."
    try {
      await body()
    } finally {
      if (!had) delete steps.ACCOUNT_UNKNOWN
    }
  }
  const ownedSpec = (run: OwnedMethod["run"]): OwnedMethod => ({ name: "owned_read", action: "plugin_owned_read", description: "", input: {}, output: {}, run })

  test("give a plugin-owned method the envelope's account as call.account, and none when the envelope has none", async () =>
    withAccounts(async () => {
      const seen: ToolCall[] = []
      const h = await setup({ server: accounts, owned: [ownedSpec(async (_input, live) => (seen.push(live), { ok: true }))] })
      expect(h.contract.methods.owned_read!.input.properties.account).toEqual({ type: "string", minLength: 1 })
      expect(await h.handlers.owned_read!({ sessionID: "ses_1", account: "work", input: {} }, rpcContext())).toEqual({ ok: true })
      expect(await h.handlers.owned_read!({ sessionID: "ses_1", input: {} }, rpcContext())).toEqual({ ok: true })
      expect(seen[0]).toMatchObject({ sessionID: "ses_1", agent: "build", account: "work", id: expect.stringMatching(/^script:/) })
      expect(Object.hasOwn(seen[1]!, "account")).toBe(false)
    }))

  test("refuse an unknown account with ACCOUNT_UNKNOWN before a plugin-owned method runs, as for an MCP method", async () =>
    withAccounts(async () => {
      let runs = 0
      const h = await setup({ server: accounts, owned: [ownedSpec(async () => (runs++, {}))] })
      const refused = await h.handlers.owned_read!({ sessionID: "ses_1", account: "nope", input: {} }, rpcContext())
      refusedWith(refused, "ACCOUNT_UNKNOWN")
      expect(refused.data.next).toBe(NEXT_STEPS.ACCOUNT_UNKNOWN)
      expect(runs).toBe(0)
      expect(h.evaluations).toEqual([])
    }))

  test("without per-account servers, a plugin-owned method's call has no account", async () => {
    const seen: ToolCall[] = []
    const h = await setup({ owned: [ownedSpec(async (_input, live) => (seen.push(live), {}))] })
    expect(Object.hasOwn(h.contract.methods.owned_read!.input.properties, "account")).toBe(false)
    await h.handlers.owned_read!({ sessionID: "ses_1", input: {} }, rpcContext())
    expect(Object.hasOwn(seen[0]!, "account")).toBe(false)
  })
})

describe("registration", () => {
  test("disposes the hook and the RPC", async () => {
    const h = await setup()
    await h.stop()
    expect(h.disposed.sort()).toEqual(["hook", "rpc"])
  })

  test("refuses a method name that is describe or taken twice", async () => {
    const spec: OwnedMethod = { name: "describe", action: "x", description: "", input: {}, output: {}, run: async () => null }
    await expect(setup({ owned: [spec] })).rejects.toThrow(/describe/)
    await expect(setup({ owned: [{ ...spec, name: "twice" }, { ...spec, name: "twice" }] })).rejects.toThrow(/twice/)
    if (MCP) await expect(setup({ owned: [{ ...spec, name: READ }] })).rejects.toThrow(READ)
  })
})
