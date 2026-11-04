// The host test, run against every host in embedded.test.ts and binary.test.ts. It checks what the plugin
// registers on a real OpenCode host, and the permission results V1-V6 from the plan (ISSUE §3.4).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, sep } from "node:path"
import { defaultRules, type Rule } from "../../src/permissions.js"
import type { Status } from "../../src/status.js"
import { KNOWN_READS, TOOLS_RPC_ID } from "../../src/host/tools-rpc.js"
import { classify } from "../../src/tools.js"
import { fakeInput, FAKE_TOOLS, UPSTREAM_FAILURE } from "./fake-slack-mcp.js"
import { CLIENT_ID, HOSTED_OAUTH, REPO, repositoryChanges, TEMP, USER_SERVER, type Host, type Project } from "./harness.js"
import type { Outcome } from "./probe/index.js"

interface ProbeState {
  readonly registered: unknown
  readonly agents: readonly { readonly id: string; readonly permissions: readonly Rule[] }[]
}

const PACKAGE_VERSION = (JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { version: string }).version

// Agents defined only in the project's config; OpenCode creates them after package plugins run.
const CONFIG_ONLY = ["custom", "locked", "fixed"]
const isBaseAllow = (rule: Rule) => rule.action === "*" && rule.resource === "*" && rule.effect === "allow"
const catchAlls = (permissions: readonly Rule[]) => permissions.filter((rule) => rule.action === "slack_*" && rule.effect === "ask").length

export function hostSuite(name: string, start: () => Promise<Host>): void {
  describe(name, () => {
    let host: Host
    let changesBefore: string

    beforeAll(async () => {
      changesBefore = repositoryChanges()
      host = await start()
    }, 240_000)
    afterAll(async () => {
      await host?.close()
    }, 60_000)

    const at = (project: Project) => ({ location: host.location(project) })
    const call = async (rpcID: string, method: string, project: Project, input: object = {}) =>
      (await host.client.rpc.call({ rpcID, method, input: input as never, ...at(project) })).output as unknown
    // RPC handlers wait for plugin activation, so the first status call also waits for the project to load.
    const status = async (project: Project) => (await call("slack.workspace", "status", project)) as Status
    const probe = async (project: Project) => (await call("slack.test.probe", "state", project)) as ProbeState
    const check = async (project: Project, agent: string, tool: string, reply?: "always") =>
      (await call("slack.test.probe", "check", project, { agent, action: `slack_${tool}`, ...(reply ? { reply } : {}) })) as Outcome

    async function slashStatus(project: Project): Promise<string> {
      const session = await host.client.session.create({ title: "Slack status", ...at(project) })
      await host.client.session.command({ sessionID: session.id, name: "slack-status", text: "" })
      for (const deadline = Date.now() + 20_000; Date.now() < deadline; await Bun.sleep(100)) {
        const inbox = await host.client.session.inbox.list({ sessionID: session.id })
        const posted = inbox.find((item) => item.type === "synthetic")
        if (posted?.type === "synthetic") return posted.payload.text
      }
      throw new Error("/slack-status posted nothing")
    }

    // The host lists a server's tools shortly after it reports the server connected.
    async function discovered(project: Project): Promise<Status> {
      for (const deadline = Date.now() + 30_000; ; await Bun.sleep(250)) {
        const current = await status(project)
        const { read, private: search, file, write, unknown } = current.tools
        if ((current.state === "connected" && read + search + file + write + unknown > 0) || Date.now() > deadline) return current
      }
    }

    describe("defaults", () => {
      test("slack.workspace is active with its server, TUI and RPC parts", async () => {
        await status("defaults")
        const plugins = (await host.client.plugin.list(at("defaults"))).data
        expect(plugins.find((plugin) => plugin.id === "slack.workspace")).toMatchObject({ state: { status: "active" }, features: { server: true, tui: true } })
      })

      test("registers Slack's MCP server with exactly type, url and oauth", async () => {
        expect((await probe("defaults")).registered).toStrictEqual({
          type: "remote",
          url: "https://mcp.slack.com/mcp",
          oauth: { client_id: CLIENT_ID, redirect_uri: "http://localhost:8765/callback", scope: "channels:history channels:read search:read.public users:read" },
        })
      })

      test("status reports the server's tools by class, the host and the unguarded config-only agent", async () => {
        const current = await discovered("defaults")
        expect(current).toMatchObject({
          state: "connected",
          tools: { read: 12, private: 1, file: 1, write: 13, unknown: 1, unknownNames: ["slack_brand_new_tool"] },
          unguardedAgents: ["custom"],
          version: PACKAGE_VERSION,
          host: { version: host.version, range: ">=2.2.3 <2.3.0", tested: true },
          client: { id: CLIENT_ID, mode: "public_pkce" },
        })
        expect(Object.hasOwn(current, "code")).toBe(false)
      })

      test("/slack-status posts the status into the session", async () => {
        expect((await host.client.command.list(at("defaults"))).data.map((command) => command.name)).toContain("slack-status")
        const text = await slashStatus("defaults")
        expect(text).toStartWith("Slack\nConnection: connected. ")
        expect(text).toContain(`Client: ${CLIENT_ID} (public, PKCE; set in plugin options)`)
        expect(text).toContain("Agents without default rules: These agents run Slack writes and unknown tools without asking: custom.")
        expect(text).toContain(`OpenCode: ${host.version} (tested; supported range >=2.2.3 <2.3.0)`)
      })

      test("the slack-search skill is registered", async () => {
        expect((await host.client.skill.list(at("defaults"))).data.map((skill) => skill.id)).toContain("slack-search")
      })

      test("each agent with a base allow gets the default rules directly after it, once", async () => {
        const { agents } = await probe("defaults")
        const withBase = agents.filter((agent) => agent.permissions.some(isBaseAllow))
        expect(withBase.map((agent) => agent.id)).toContain("build")
        for (const agent of agents) {
          const at = agent.permissions.findIndex(isBaseAllow)
          if (at === -1 || CONFIG_ONLY.includes(agent.id)) continue
          expect({ agent: agent.id, rules: agent.permissions.slice(at + 1, at + 1 + defaultRules("slack").length) })
            .toEqual({ agent: agent.id, rules: defaultRules("slack") })
        }
        for (const id of CONFIG_ONLY) expect({ id, catchAlls: catchAlls(agents.find((agent) => agent.id === id)!.permissions) }).toEqual({ id, catchAlls: id === "fixed" ? 1 : 0 })
      })

      test.each(FAKE_TOOLS.map((tool) => [tool, classify(tool)] as const))("V1: %s (%s)", async (tool, toolClass) => {
        const outcome = await check("defaults", "build", tool)
        expect(outcome.outcome).toBe(toolClass === "read" ? "allow" : "ask")
        if (outcome.outcome === "ask") expect(outcome).toEqual({ outcome: "ask", asked: `slack_${tool}`, afterReply: "rejected" })
      })

      test.each(["explore", "locked"])("V4: %s, with a later deny-all, stays denied", async (agent) => {
        for (const tool of ["slack_search_public", "slack_send_message", "slack_brand_new_tool"]) {
          expect({ tool, ...(await check("defaults", agent, tool)) }).toEqual({ tool, outcome: "deny" })
        }
      })

      test("V6: after a reload the default rules appear exactly once", async () => {
        const count = (state: ProbeState) => state.agents.map((agent) => [agent.id, catchAlls(agent.permissions)])
        const before = count(await probe("defaults"))
        const after = count((await call("slack.test.probe", "reload", "defaults")) as ProbeState)
        expect(after).toEqual(before)
        expect(Math.max(...before.map(([, n]) => n as number))).toBe(1)
      })

      test("an agent defined only in user config gets no rules; the status fix guards it without loosening explore", async () => {
        expect((await check("defaults", "custom", "slack_send_message")).outcome).toBe("allow")
        expect((await check("defaults", "custom", "slack_brand_new_tool")).outcome).toBe("allow")
        expect((await check("defaults", "fixed", "slack_search_public")).outcome).toBe("allow")
        expect((await check("defaults", "fixed", "slack_send_message")).outcome).toBe("ask")
        expect((await check("defaults", "fixed", "slack_brand_new_tool")).outcome).toBe("ask")
        expect((await check("defaults", "explore", "slack_search_public")).outcome).toBe("deny")
      })
    })

    describe("the tools RPC", () => {
      const sessions: Record<string, string> = {}
      const permission = (action: string, effect: Rule["effect"]): Rule => ({ action, resource: "*", effect })
      /** A tools RPC call's output, or its error's `{ type, code, message }`. */
      const script = async (method: string, input: unknown, project: Project = "defaults"): Promise<Record<string, any>> => {
        try {
          return { value: await call(TOOLS_RPC_ID, method, project, input as object) }
        } catch (error) {
          const e = error as Record<string, any>
          return { type: e.type ?? e._tag, code: e.data?.code, message: String(e.message ?? e) }
        }
      }
      const run = (session: string, method: string, input: unknown = {}, project: Project = "defaults") =>
        script(method, { sessionID: sessions[session] ?? session, input }, project)
      const since = (from: number) => host.toolCalls().slice(from)
      // Inputs that Slack's schemas accept.
      const CHANNEL = { channel_id: "C0TEST" }
      const THREAD = { channel_id: "C0TEST", message_ts: "1730000000.000100" }
      const FILE = { file_id: "F0TEST" }

      beforeAll(async () => {
        expect((await discovered("defaults")).state).toBe("connected")
        const create = async (input: Record<string, unknown>, project: Project = "defaults") =>
          (await host.client.session.create({ title: "script", ...at(project), ...input } as never)).id
        sessions.build = await create({ agent: "build" })
        sessions.locked = await create({ agent: "locked" })
        sessions.agentless = await create({})
        // Session rules come after the agent's: one narrows build, one allows build the reads that ask, one reopens a
        // read for locked.
        sessions.narrow = await create({ agent: "build", permissions: [permission("slack_slack_search_public", "deny")] })
        sessions.allowed = await create({
          agent: "build",
          permissions: [permission("slack_slack_search_public_and_private", "allow"), permission("slack_slack_read_file", "allow")],
        })
        sessions.reopen = await create({ agent: "locked", permissions: [permission("slack_slack_read_thread", "allow")] })
        sessions.collision = await create({ agent: "build" }, "collision")
      }, 60_000)

      test("describes exactly the known reads, with their live schemas; no write, send or unknown tool is a method", async () => {
        const { value } = await script("describe", {})
        expect(value.id).toBe(TOOLS_RPC_ID)
        expect(value.methods.map((method: { name: string }) => method.name)).toEqual([...KNOWN_READS])
        for (const method of value.methods) expect({ ...method, description: undefined, output: undefined }).toEqual({ name: method.name, tool: `slack_${method.name}`, kind: "mcp", action: `slack_${method.name}`, available: true, input: fakeInput(method.name), description: undefined, output: undefined })
        const from = host.toolCalls().length
        const excluded = FAKE_TOOLS.filter((tool) => ["write", "unknown"].includes(classify(tool)))
        expect(excluded.length).toBe(14)
        for (const tool of excluded) {
          const refused = await run("build", tool, { query: "q" })
          expect({ tool, type: refused.type, notFound: /not.?found|unknown/i.test(refused.message) }).toEqual({ tool, type: expect.not.stringMatching(/^failed$/), notFound: true })
        }
        expect(since(from)).toEqual([])
      })

      test("runs a known read as a session whose agent allows it, with no model turn", async () => {
        const from = host.toolCalls().length
        expect(await run("build", "slack_search_public", { query: "hello" })).toEqual({
          value: { output: { tool: "slack_search_public", arguments: { query: "hello" } }, text: `slack_search_public: {"query":"hello"}` },
        })
        expect(since(from)).toEqual(["slack_search_public"])
        const session = await host.client.session.get({ sessionID: sessions.build! })
        expect(session.outcome).toBeUndefined()
        expect(session.tokens).toMatchObject({ input: 0, output: 0 })
      })

      test("gives a result with only text as its output too, as the scripting doc says", async () => {
        expect(await run("build", "slack_search_users", { query: "text only" })).toEqual({
          value: { output: "slack_search_users: text only", text: "slack_search_users: text only" },
        })
      })

      test("refuses a session whose agent denies Slack, before Slack is called", async () => {
        const from = host.toolCalls().length
        expect(await run("locked", "slack_search_public", { query: "q" })).toMatchObject({ type: "failed", code: "PERMISSION_DENIED" })
        expect(since(from)).toEqual([])
      })

      test("refuses the private search and the file read, which ask by default, at once and with no prompt left waiting", async () => {
        const from = host.toolCalls().length
        for (const method of ["slack_search_public_and_private", "slack_read_file"]) {
          const started = Date.now()
          const result = await run("build", method, method === "slack_read_file" ? FILE : { query: "q" })
          expect(result).toMatchObject({ type: "failed", code: "PERMISSION_DENIED" })
          expect(result.message).toMatch(/cannot answer an approval prompt/)
          expect(Date.now() - started).toBeLessThan(5000)
        }
        const { data: pending } = await host.client.permission.request.list(at("defaults"))
        expect(pending.filter((request) => JSON.stringify(request).includes(sessions.build!))).toEqual([])
        expect(since(from)).toEqual([])
      })

      test("applies the session's rules after the agent's: an allow rule opens the reads that ask", async () => {
        const from = host.toolCalls().length
        expect(await run("narrow", "slack_search_public", { query: "q" })).toMatchObject({ type: "failed", code: "PERMISSION_DENIED" })
        expect((await run("narrow", "slack_read_channel", CHANNEL)).value).toMatchObject({ output: { tool: "slack_read_channel" } })
        expect((await run("allowed", "slack_search_public_and_private", { query: "q" })).value).toMatchObject({ output: { tool: "slack_search_public_and_private" } })
        expect((await run("allowed", "slack_read_file", FILE)).value).toMatchObject({ output: { tool: "slack_read_file" } })
        expect((await run("reopen", "slack_read_thread", THREAD)).value).toMatchObject({ output: { tool: "slack_read_thread" } })
        expect(await run("reopen", "slack_read_channel", CHANNEL)).toMatchObject({ type: "failed", code: "PERMISSION_DENIED" })
        expect(since(from)).toEqual(["slack_read_channel", "slack_search_public_and_private", "slack_read_file", "slack_read_thread"])
      })

      test("gives Slack's own error as UPSTREAM_ERROR: its first line, with the signed URL redacted", async () => {
        const result = await run("build", "slack_search_channels", { query: "fail" })
        expect(result).toMatchObject({ type: "failed", code: "UPSTREAM_ERROR" })
        expect(result.message).toContain("https://files.slack.example/f.pdf?[redacted]")
        for (const hidden of ["fake-signature-123", "second line"]) expect(result.message).not.toContain(hidden)
        expect(UPSTREAM_FAILURE).toContain("fake-signature-123")
      })

      test("refuses with SERVER_CONFLICT while the user's own server holds the name", async () => {
        expect(await run("collision", "slack_search_public", { query: "q" }, "collision")).toMatchObject({ type: "failed", code: "SERVER_CONFLICT" })
        const { value } = await script("describe", {}, "collision")
        expect(value.methods.every((method: { available: boolean; reason: string }) => !method.available && method.reason === "SERVER_CONFLICT")).toBe(true)
      })

      test("names an unknown session, a session without an agent, and rejects an envelope with extra keys", async () => {
        expect(await run("ses_does_not_exist", "slack_search_public", { query: "q" })).toMatchObject({ type: "failed", code: "SESSION_UNKNOWN" })
        expect(await run("agentless", "slack_search_public", { query: "q" })).toMatchObject({ type: "failed", code: "SESSION_AGENT_REQUIRED" })
        const from = host.toolCalls().length
        for (const envelope of [{ sessionID: sessions.build, input: { query: "q" }, extra: true }, { input: { query: "q" } }, { sessionID: sessions.build, input: "q" }])
          expect(await script("slack_search_public", envelope)).toMatchObject({ type: "rpc.invalid_input" })
        const describing = await script("describe", { sessionID: sessions.build })
        expect(describing).toMatchObject({ type: "rpc.invalid_input" })
        expect(describing.message).toContain("describe takes no input")
        expect(since(from)).toEqual([])
      })

      test("is not registered for invalid options", async () => {
        expect(await script("describe", {}, "invalid")).toMatchObject({ type: "rpc.unavailable", message: `RPC is unavailable: ${TOOLS_RPC_ID}` })
      })
    })

    describe("user permissions", () => {
      test.each(["build", "custom"])("V2: a user allow for slack_slack_send_message wins for %s", async (agent) => {
        expect((await check("rules", agent, "slack_send_message")).outcome).toBe("allow")
      })

      test.each(["build", "custom"])("V5: a user deny for slack_slack_search_public blocks %s", async (agent) => {
        expect((await check("rules", agent, "slack_search_public")).outcome).toBe("deny")
      })

      test("other defaults still ask", async () => {
        expect((await check("rules", "build", "slack_read_file")).outcome).toBe("ask")
        expect((await check("rules", "build", "slack_brand_new_tool")).outcome).toBe("ask")
      })

      test("with the status fix, the user's own rules keep winning", async () => {
        expect((await check("rules", "fixed", "slack_send_message")).outcome).toBe("allow")
        expect((await check("rules", "fixed", "slack_search_public")).outcome).toBe("deny")
        expect((await check("rules", "fixed", "slack_read_thread")).outcome).toBe("allow")
        expect((await check("rules", "fixed", "slack_read_file")).outcome).toBe("ask")
      })

      test("a disabled server shows SERVER_DISABLED", async () => {
        expect(await status("rules")).toMatchObject({ state: "disabled", code: "SERVER_DISABLED", nextStep: "Enable slack in /mcps.", unguardedAgents: ["custom"] })
      })
    })

    describe("a user server named slack", () => {
      test("is kept as configured, and status reports SERVER_NAME_IN_USE", async () => {
        expect(await status("collision")).toMatchObject({ state: "conflict", code: "SERVER_NAME_IN_USE" })
        // The host fills in defaults such as an empty timeout; the user's URL and OAuth setting are untouched.
        expect((await probe("collision")).registered).toMatchObject(USER_SERVER)
        expect(await slashStatus("collision")).toStartWith("Slack\nConnection: conflict. SERVER_NAME_IN_USE: ")
      })
    })

    describe("invalid options", () => {
      test("register only the status surfaces, which name the option and the fix", async () => {
        expect(await status("invalid")).toMatchObject({
          state: "not_configured",
          code: "OPTIONS_INVALID",
          message: "Option oauth.redirect_port: This option is not supported.",
          nextStep: "Use oauth.redirect_uri instead, for example http://localhost:8765/callback.",
        })
        const plugins = (await host.client.plugin.list(at("invalid"))).data
        expect(plugins.find((plugin) => plugin.id === "slack.workspace")?.state).toEqual({ status: "active" })
        const { registered, agents } = await probe("invalid")
        expect(registered).toBeNull()
        expect(agents.map((agent) => catchAlls(agent.permissions)).every((n) => n === 0)).toBe(true)
        expect((await host.client.skill.list(at("invalid"))).data.map((skill) => skill.id)).not.toContain("slack-search")
        expect(await slashStatus("invalid")).toStartWith("Slack\nConnection: not configured. OPTIONS_INVALID: ")
      })
    })

    describe("an https redirect", () => {
      test("registers the server with the redirect and the callback port, which the host accepts", async () => {
        expect((await probe("hosted")).registered).toStrictEqual({
          type: "remote",
          url: "https://mcp.slack.com/mcp",
          oauth: { client_id: CLIENT_ID, ...HOSTED_OAUTH, scope: "channels:history channels:read search:read.public users:read" },
        })
        expect(await status("hosted")).toMatchObject({ state: "disabled", callback: HOSTED_OAUTH.redirect_uri, callbackPort: HOSTED_OAUTH.callback_port })
        expect((await host.client.integration.list(at("hosted"))).data.map((item) => item.id)).not.toContain("slack-app")
        expect(await slashStatus("hosted")).not.toContain("Slack app")
      })
    })

    describe("a Slack app client ID from /connect", () => {
      const NEXT = "Run /connect and choose Slack app, then paste your Slack app's client ID."

      test("without one, Slack app is listed in /connect and the server is not registered", async () => {
        expect(await status("connect")).toMatchObject({ state: "not_configured", code: "CLIENT_ID_MISSING", nextStep: NEXT })
        expect((await probe("connect")).registered).toBeNull()
        const app = (await host.client.integration.list(at("connect"))).data.find((item) => item.id === "slack-app")
        expect(app).toMatchObject({
          name: "Slack app",
          methods: [{ type: "key", label: "Slack app client ID", form: [{ key: "client_secret", type: "string", title: "Client secret", required: false }] }],
        })
        // Projects that set the client ID in their options have no Slack app entry.
        expect((await host.client.integration.list(at("defaults"))).data.map((item) => item.id)).not.toContain("slack-app")
      })

      test("saving it registers the server with that client ID and redirect URI, named Slack in /connect", async () => {
        await host.client.integration.connect.key({ integrationID: "slack-app", key: "CONNECT_CLIENT_ID", answer: {}, ...at("connect") })
        let registered: unknown = null
        for (const deadline = Date.now() + 30_000; registered === null && Date.now() < deadline; await Bun.sleep(250)) registered = (await probe("connect")).registered
        expect(registered).toStrictEqual({
          type: "remote",
          url: "https://mcp.slack.com/mcp",
          oauth: { client_id: "CONNECT_CLIENT_ID", redirect_uri: "http://localhost:8765/callback", scope: "channels:history channels:read search:read.public users:read" },
        })
        expect(await status("connect")).toMatchObject({ client: { id: "CONNECT_CLIENT_ID", mode: "public_pkce", source: "connect" } })
        const id = (await host.client.mcp.list(at("connect"))).data.find((server) => server.name === "slack")?.integrationID
        expect(id).toBeString()
        let name: string | undefined
        for (const deadline = Date.now() + 30_000; name !== "Slack" && Date.now() < deadline; await Bun.sleep(250)) {
          name = (await host.client.integration.get({ integrationID: id!, ...at("connect") })).data.name
        }
        expect(name).toBe("Slack")
      })
    })

    // Saved approvals apply to the whole project, so this runs last and on a tool nothing else checks afterwards.
    test("V3: replying always lets the next identical call through without asking", async () => {
      expect(await check("defaults", "build", "slack_schedule_message", "always")).toEqual({ outcome: "ask", asked: "slack_slack_schedule_message", afterReply: "allowed" })
      expect(await check("defaults", "build", "slack_schedule_message")).toEqual({ outcome: "allow" })
    })

    // OpenCode looks for `.opencode` folders above a project, up to its repository root. Under HOME or TMPDIR it could
    // find the tester's own agents and skills; the root is a repository under the system's /tmp instead.
    test("its temp root is a git repository under the system's /tmp, away from TMPDIR and HOME", () => {
      expect(host.root.startsWith(TEMP + sep)).toBe(true)
      expect(host.root.startsWith(homedir() + sep)).toBe(false)
      expect(existsSync(join(host.root, ".git"))).toBe(true)
    })

    test("resolves OpenCode's global paths inside its temp root", async () => {
      const paths = (await call("slack.test.probe", "paths", "defaults")) as Record<string, string>
      expect(Object.keys(paths).sort()).toEqual(["bin", "cache", "config", "data", "home", "log", "repos", "state", "tmp"])
      expect(Object.entries(paths).filter(([, path]) => !path.startsWith(host.root + sep))).toEqual([])
    })

    test("writes nothing outside its temp root", () => {
      expect(repositoryChanges()).toBe(changesBefore)
      // The host's own state landed inside the root, so its HOME and XDG redirection took effect.
      expect(existsSync(join(host.root, host.state))).toBe(true)
      expect(readdirSync(join(host.root, "home"), { recursive: true }).length).toBeGreaterThan(0)
    })
  })
}
