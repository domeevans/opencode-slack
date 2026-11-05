// Narrow test doubles for the parts of the plugin context the Slack plugin uses. Each fake implements only the
// members the code calls, so the same tests typecheck against every 2.2.x `@opencode/plugin`.
import type { Plugin } from "@opencode/plugin"
import type { Rule } from "../../src/permissions.js"
import type { ServerStatus } from "../../src/status.js"

type Context = Plugin.Context
type McpEditor = Parameters<Parameters<Context["mcp"]["transform"]>[0]>[0]
type AgentEditor = Parameters<Parameters<Context["agent"]["transform"]>[0]>[0]
type IntegrationEditor = Parameters<Parameters<Context["integration"]["transform"]>[0]>[0]
type MethodRegistration = Parameters<IntegrationEditor["method"]["update"]>[0]
type CredentialValue = NonNullable<Awaited<ReturnType<Context["integration"]["connection"]["resolve"]>>>
type SkillEditor = Parameters<Parameters<Context["skill"]["transform"]>[0]>[0]
type CommandDefinition = Parameters<Parameters<Parameters<Context["command"]["transform"]>[0]>[0]["add"]>[0]
type ServerConfig = Parameters<McpEditor["set"]>[1]
type SkillInfo = Parameters<SkillEditor["add"]>[0]
type SyntheticInput = Parameters<Context["session"]["synthetic"]>[0]
type ToolEditor = Parameters<Parameters<Context["tool"]["transform"]>[0]>[0]
type Namespace = Parameters<ToolEditor["namespace"]>[0]

/** The members of `Plugin.Context` that `setup` uses. */
type UsedContext = {
  readonly app: Pick<Context["app"], "version">
  readonly options: Context["options"]
  readonly mcp: Pick<Context["mcp"], "transform" | "list" | "reload">
  readonly integration: Pick<Context["integration"], "transform" | "get"> & { readonly connection: Pick<Context["integration"]["connection"], "active" | "resolve" | "status"> }
  readonly event: Pick<Context["event"], "subscribe">
  readonly agent: Pick<Context["agent"], "transform" | "list" | "get">
  readonly tool: Pick<Context["tool"], "list" | "transform">
  readonly rpc: Pick<Context["rpc"], "register">
  readonly permission: Pick<Context["permission"], "hook">
  readonly command: Pick<Context["command"], "transform">
  readonly session: Pick<Context["session"], "synthetic" | "get">
  readonly skill: Pick<Context["skill"], "transform" | "list">
  readonly location: Pick<Context["location"], "directory">
}

export const BASE_ALLOW: Rule = { action: "*", resource: "*", effect: "allow" }

/** The host's base policy for every agent: allow everything, then ask before reading `.env` files. */
export const BASE_RULES: readonly Rule[] = [
  BASE_ALLOW,
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
]

interface FakeAgent {
  readonly id: string
  permissions: Rule[]
}

export const agent = (id: string, permissions: readonly Rule[]): FakeAgent => ({ id, permissions: permissions.map((rule) => ({ ...rule })) })

/** An agent editor over plain agents. It records which agents were updated. */
export function agentEditor(agents: readonly FakeAgent[]) {
  const updated: string[] = []
  const fake = {
    list: () => agents,
    update: (id: string, update: (draft: FakeAgent) => void) => {
      const found = agents.find((item) => item.id === id)
      if (found === undefined) return
      updated.push(id)
      update(found)
    },
  }
  // insertDefaultRules reads only `list` and `update`, and only the `id` and `permissions` fields.
  return { editor: fake as unknown as AgentEditor, updated }
}

/** An MCP editor over a plain map of server configs. */
export function mcpEditor(initial: Readonly<Record<string, ServerConfig>> = {}) {
  const servers = new Map<string, ServerConfig>(Object.entries(structuredClone(initial)))
  const fake = {
    list: () => [...servers.entries()],
    get: (name: string) => servers.get(name),
    set: (name: string, config: ServerConfig) => void servers.set(name, structuredClone(config)),
    update: (name: string, update: (config: ServerConfig) => void) => {
      const config = servers.get(name)
      if (config !== undefined) update(config)
    },
    remove: (name: string) => void servers.delete(name),
  }
  return { editor: fake as unknown as McpEditor, servers }
}

interface FakeTool {
  readonly name: string
  readonly options?: { readonly namespace?: string }
  /** The host's tool id, `<server>_<name>` for an MCP tool; the tools RPC finds executors by it. */
  readonly id?: string
  readonly input?: object
  /** The host's executor, which the tools RPC calls. */
  readonly execute?: (input: unknown, call: { sessionID: string; agent: string; id: string }) => Promise<unknown>
}

/** A session as the tools RPC reads it. */
export interface FakeSession {
  readonly agent?: string
  readonly permissions?: readonly Rule[]
}

/** The directory of the fake host's location. */
const FAKE_LOCATION = "/tmp/slack-fake-location"

export interface FakeHostInput {
  readonly version?: string
  readonly options?: unknown
  readonly servers?: Readonly<Record<string, ServerConfig>>
  readonly status?: Readonly<Record<string, ServerStatus>>
  readonly agents?: readonly FakeAgent[]
  readonly tools?: readonly FakeTool[]
  /** Stored credentials by integration ID, as `/connect` saves them. */
  readonly credentials?: Readonly<Record<string, CredentialValue>>
  /** Sessions by ID, for the tools RPC. */
  readonly sessions?: Readonly<Record<string, FakeSession>>
  /** Skills from the user's or the project's skill folders. One with a registered skill's id wins, as in OpenCode. */
  readonly userSkills?: readonly { readonly id: string; readonly path: string }[]
}

/** An event stream that delivers what `push` sends and ends when its signal aborts. */
function eventStream() {
  const listeners = new Set<(type: string) => void>()
  const subscribe = (options?: { types?: readonly string[]; signal?: AbortSignal }): AsyncIterable<{ type: string }> => ({
    [Symbol.asyncIterator]() {
      const queue: string[] = []
      let wake = () => {}
      const listener = (type: string) => {
        if (options?.types !== undefined && !options.types.includes(type)) return
        queue.push(type)
        wake()
      }
      listeners.add(listener)
      options?.signal?.addEventListener("abort", () => wake(), { once: true })
      return {
        async next() {
          while (queue.length === 0 && options?.signal?.aborted !== true) await new Promise<void>((resolve) => void (wake = resolve))
          if (queue.length === 0) return { done: true as const, value: undefined }
          return { done: false as const, value: { type: queue.shift()! } }
        },
        async return() {
          listeners.delete(listener)
          return { done: true as const, value: undefined }
        },
      }
    },
  })
  return { subscribe, push: (type: string) => void listeners.forEach((listener) => listener(type)), listeners }
}

type Handler = (input: unknown, call: { signal: AbortSignal; error: (type: string, message: string, data: unknown) => unknown }) => Promise<unknown>

/**
 * A plugin host that runs every transform immediately on in-memory registries, as OpenCode does at startup, and
 * records the order of registrations.
 */
export function fakeHost(input: FakeHostInput = {}) {
  const calls: string[] = []
  const mcp = mcpEditor(input.servers)
  const mcpTransforms: ((editor: McpEditor) => void)[] = []
  const integrations = new Map<string, { name: string; methods: MethodRegistration["method"][] }>()
  const credentials = new Map<string, CredentialValue>(Object.entries(input.credentials ?? {}))
  const events = eventStream()
  const connectionStatus = new Map<string, unknown>()
  const agents = (input.agents ?? [agent("build", BASE_RULES)]).map((item) => agent(item.id, item.permissions))
  const agentState = agentEditor(agents)
  const commands: CommandDefinition[] = []
  const skills: SkillInfo[] = []
  const synthetic: SyntheticInput[] = []
  // Every registered RPC by ID; `rpc` is the first, the status RPC.
  const rpcs = new Map<string, Record<string, Handler>>()
  const rpc: { id?: string; handlers: Record<string, Handler> } = { handlers: {} }
  // Every registered RPC contract by ID.
  const contracts = new Map<string, { methods: Record<string, { input: unknown; output: unknown }> }>()
  const hooks = new Set<unknown>()
  // Code Mode namespace descriptions, by name.
  const namespaces = new Map<string, Namespace>()
  let failLists = false

  const registration = { dispose: async () => {} }
  const ctx: UsedContext = {
    app: { version: input.version ?? "2.2.3" },
    options: (input.options ?? { oauth: { client_id: "TEST_CLIENT_ID" } }) as Context["options"],
    mcp: {
      transform: async (callback) => {
        calls.push("mcp.transform")
        mcpTransforms.push(callback)
        callback(mcp.editor)
        return registration
      },
      list: async () => {
        if (failLists) throw new Error("host unavailable")
        const data = [...mcp.servers.keys()].map((name) => ({ name, status: input.status?.[name] ?? { status: "pending" }, integrationID: `mcp_${name}` }))
        return { data } as never
      },
      // As in OpenCode: rebuild from the config, then replay every transform.
      reload: async () => {
        calls.push("mcp.reload")
        mcp.servers.clear()
        for (const [name, config] of Object.entries(structuredClone(input.servers ?? {}))) mcp.servers.set(name, config)
        for (const transform of mcpTransforms) transform(mcp.editor)
      },
    },
    integration: {
      transform: async (callback) => {
        calls.push("integration.transform")
        for (const name of mcp.servers.keys()) if (!integrations.has(`mcp_${name}`)) integrations.set(`mcp_${name}`, { name, methods: [] })
        callback({
          get: (id: string) => (integrations.has(id) ? { id, name: integrations.get(id)!.name } : undefined),
          update: (id: string, update: (draft: { id: string; name: string }) => void) => {
            const draft = { id, name: integrations.get(id)?.name ?? id }
            update(draft)
            integrations.set(id, { name: draft.name, methods: integrations.get(id)?.methods ?? [] })
          },
          method: { update: (registration: MethodRegistration) => void integrations.get(registration.integrationID)?.methods.push(registration.method) },
        } as unknown as IntegrationEditor)
        return registration
      },
      get: (async ({ integrationID }: { integrationID: string }) => ({ data: { id: integrationID, name: integrations.get(integrationID)?.name ?? integrationID.slice("mcp_".length) } })) as never,
      connection: {
        active: async (integrationID) => (credentials.has(integrationID) ? { id: `crd_${integrationID}` } as never : undefined),
        resolve: async (connection) => credentials.get((connection as unknown as { id: string }).id.slice("crd_".length)),
        status: async ({ integrationID, status }) => {
          if (status === undefined) connectionStatus.delete(integrationID)
          else connectionStatus.set(integrationID, status)
        },
      },
    },
    event: { subscribe: events.subscribe as never },
    agent: {
      transform: async (callback) => {
        calls.push("agent.transform")
        callback(agentState.editor)
        return registration
      },
      list: async () => ({ data: agents }) as never,
      get: (async ({ agentID }: { agentID: string }) => {
        const found = agents.find((item) => item.id === agentID)
        if (found === undefined) throw Object.assign(new Error(`Agent not found: ${agentID}`), { _tag: "Agent.NotFoundError" })
        return { location: { directory: FAKE_LOCATION }, data: { id: found.id, permissions: found.permissions } }
      }) as never,
    },
    tool: {
      list: async () => (input.tools ?? []) as never,
      transform: async (callback) => {
        calls.push("tool.transform")
        callback({ namespace: (namespace: Namespace) => void namespaces.set(namespace.name, namespace) } as unknown as ToolEditor)
        return registration
      },
    },
    rpc: {
      register: (async (definition: { id: string; methods: Record<string, { input: unknown; output: unknown }> }, handlers: Record<string, Handler>) => {
        calls.push("rpc.register")
        contracts.set(definition.id, definition)
        if (rpc.id === undefined) {
          rpc.id = definition.id
          rpc.handlers = handlers
        }
        rpcs.set(definition.id, handlers)
        return { dispose: async () => void rpcs.delete(definition.id), events: { emit: async () => {} } }
      }) as unknown as UsedContext["rpc"]["register"],
    },
    permission: {
      hook: (async (_name: string, callback: unknown) => {
        calls.push("evaluate hook")
        hooks.add(callback)
        return { dispose: async () => void hooks.delete(callback) }
      }) as never,
    },
    command: {
      transform: async (callback) => {
        calls.push("command.transform")
        callback({ add: (definition) => void commands.push(definition) })
        return registration
      },
    },
    session: {
      synthetic: async (message) => {
        synthetic.push(message)
        return {} as never
      },
      get: (async ({ sessionID }: { sessionID: string }) => {
        const session = input.sessions?.[sessionID]
        if (session === undefined) throw Object.assign(new Error(`Session not found: ${sessionID}`), { _tag: "Session.NotFoundError" })
        return { id: sessionID, location: { directory: FAKE_LOCATION }, ...session }
      }) as never,
    },
    skill: {
      transform: async (callback) => {
        calls.push("skill.transform")
        callback({ add: (skill: SkillInfo) => void skills.push(skill) } as unknown as SkillEditor)
        return registration
      },
      list: (async () => {
        if (failLists) throw new Error("host unavailable")
        const users = input.userSkills ?? []
        const data = [...users, ...skills.filter((skill) => !users.some((user) => user.id === skill.id))]
        return { location: { directory: FAKE_LOCATION }, data }
      }) as never,
    },
    location: { directory: FAKE_LOCATION as Context["location"]["directory"] },
  }

  /** Calls the registered RPC `status` method the way the host does. */
  const status = (signal = new AbortController().signal) => {
    const handler = rpc.handlers.status
    if (handler === undefined) throw new Error("status RPC is not registered")
    return handler({}, { signal, error: (type, message, data) => ({ error: type, message, data }) })
  }

  /** Calls a tools RPC method the way the host does, with the envelope `{ sessionID, input }`. */
  const script = (method: string, sessionID: string, toolInput: unknown = {}, signal = new AbortController().signal) => {
    const handler = rpcs.get("slack.workspace.tools")?.[method]
    if (handler === undefined) throw new Error(`the tools RPC has no method ${method}`)
    return handler(method === "describe" ? {} : { sessionID, input: toolInput }, { signal, error: (type, message, data) => ({ error: type, message, data }) })
  }

  /** Runs `/slack-status` and returns the synthetic message it posted. */
  const slashStatus = async () => {
    const command = commands.find((item) => item.name === "slack-status")
    if (command === undefined) throw new Error("/slack-status is not registered")
    const before = synthetic.length
    await command.execute({ sessionID: "ses_test", delivery: "queue", prompt: {} } as never)
    if (synthetic.length !== before + 1) throw new Error("/slack-status did not post exactly one message")
    return synthetic.at(-1)!
  }

  return {
    ctx: ctx as unknown as Context,
    calls,
    integrations,
    /** Problems reported on stored connections, by integration ID. */
    connectionStatus,
    /** Saves, replaces or removes a stored credential, and publishes the event OpenCode sends. */
    store: (integrationID: string, value: CredentialValue | undefined) => {
      if (value === undefined) credentials.delete(integrationID)
      else credentials.set(integrationID, value)
      events.push("credential.updated")
    },
    emit: events.push,
    subscribers: () => events.listeners.size,
    servers: mcp.servers,
    agents,
    updatedAgents: agentState.updated,
    commands,
    skills,
    rpc,
    rpcs,
    contracts,
    hooks,
    namespaces,
    script,
    status,
    slashStatus,
    failLists: () => void (failLists = true),
  }
}
