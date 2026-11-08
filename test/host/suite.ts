// The host test, run against every host in embedded.test.ts and binary.test.ts. It checks what the plugin
// registers on a real OpenCode host, and the permission results V1-V6 from the plan (ISSUE §3.4).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, sep } from "node:path"
import { defaultRules, type Rule } from "../../src/permissions.js"
import type { Status } from "../../src/status.js"
import { METHODS, TOOLS_RPC_ID } from "../../src/host/tools-rpc.js"
import { classify } from "../../src/tools.js"
import { fakeInput, FAKE_TOOLS, UPSTREAM_FAILURE } from "./fake-slack-mcp.js"
import { CLIENT_ID, HOSTED_OAUTH, REPO, repositoryChanges, SHADOWING_SKILL, TEMP, USER_SERVER, type Host, type Project } from "./harness.js"
import type { Outcome } from "./probe/index.js"

interface ProbeState {
  readonly registered: unknown
  readonly agents: readonly { readonly id: string; readonly permissions: readonly Rule[] }[]
}

const PACKAGE_VERSION = (JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { version: string }).version

// Agents defined only in the project's config; OpenCode creates them after package plugins run.
const CONFIG_ONLY = ["custom", "locked", "fixed"]
const isBaseAllow = (rule: Rule) => rule.action === "*" && rule.resource === "*" && rule.effect === "allow"
const catchAlls = (permissions: readonly Rule[]) => permissions.filter((rule) => rule.action === "slack_*" && rule.effect === "allow").length

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

    /**
     * Runs `code` as Code Mode does, through a schedule's check program: OpenCode checks each tool's input and output
     * and evaluates permissions with nobody present to answer a prompt. The program reports by throwing "SEEN <json>",
     * so no schedule is ever created and no model is involved.
     */
    async function codeMode(project: Project, sessionID: string, code: string): Promise<{ seen: unknown } | { refused: string }> {
      let message: string
      try {
        const schedule = await host.client.experimental.schedule.create({
          sessionID, name: "slack-host-test", when: { in: "6 hours" }, prompt: "noop", if: { code }, ...at(project),
        } as never)
        await host.client.experimental.schedule.delete({ scheduleID: schedule.id, ...at(project) } as never)
        throw new Error("the check program finished without reporting")
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      const seen = /SEEN (.*)$/s.exec(message)
      if (!seen) return { refused: message }
      try {
        return { seen: JSON.parse(seen[1]!) }
      } catch {
        return { seen: seen[1]! }
      }
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
          // OpenCode lists the bundled skill under the path the plugin gave, so it is not reported as shadowed.
          shadowedSkills: [],
        })
        expect(Object.hasOwn(current, "code")).toBe(false)
      })

      test("/slack-status posts the status into the session", async () => {
        expect((await host.client.command.list(at("defaults"))).data.map((command) => command.name)).toContain("slack-status")
        const text = await slashStatus("defaults")
        expect(text).toStartWith("Slack\nConnection: connected. ")
        expect(text).toContain(`Client: ${CLIENT_ID} (public, PKCE; set in plugin options)`)
        expect(text).toContain('Agents without default rules: custom\n[\n  { "action": "slack_*", "resource": "*", "effect": "allow" },')
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
          expect({ agent: agent.id, rules: agent.permissions.slice(at + 1, at + 1 + defaultRules().length) })
            .toEqual({ agent: agent.id, rules: defaultRules() })
        }
        for (const id of CONFIG_ONLY) expect({ id, catchAlls: catchAlls(agents.find((agent) => agent.id === id)!.permissions) }).toEqual({ id, catchAlls: id === "fixed" ? 1 : 0 })
      })

      test.each(FAKE_TOOLS.map((tool) => [tool, classify(tool)] as const))("V1: %s (%s) runs without a prompt", async (tool) => {
        expect(await check("defaults", "build", tool)).toEqual({ outcome: "allow" })
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
        expect((await check("defaults", "fixed", "slack_send_message")).outcome).toBe("allow")
        expect((await check("defaults", "fixed", "slack_brand_new_tool")).outcome).toBe("allow")
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
      const MESSAGE = { channel_id: "C0TEST", text: "hello" }

      beforeAll(async () => {
        expect((await discovered("defaults")).state).toBe("connected")
        const create = async (input: Record<string, unknown>, project: Project = "defaults") =>
          (await host.client.session.create({ title: "script", ...at(project), ...input } as never)).id
        sessions.build = await create({ agent: "build" })
        sessions.locked = await create({ agent: "locked" })
        sessions.agentless = await create({})
        // Session rules come after the agent's: one narrows build, one allows build the tools that ask, one reopens a
        // read for locked.
        sessions.narrow = await create({ agent: "build", permissions: [permission("slack_slack_search_public", "deny")] })
        sessions.allowed = await create({
          agent: "build",
          permissions: [permission("slack_slack_search_public_and_private", "allow"), permission("slack_slack_read_file", "allow")],
        })
        sessions.send = await create({ agent: "build", permissions: [permission("slack_slack_send_message", "allow")] })
        sessions.reopen = await create({ agent: "locked", permissions: [permission("slack_slack_read_thread", "allow")] })
        sessions.collision = await create({ agent: "build" }, "collision")
        sessions.unconfigured = await create({ agent: "build" }, "connect")
      }, 60_000)

      test("describes every known tool with its class and live schema; no unknown tool is a method", async () => {
        const { value } = await script("describe", {})
        expect(value.id).toBe(TOOLS_RPC_ID)
        expect(value.methods.map((method: { name: string }) => method.name)).toEqual(METHODS.map((method) => method.name))
        for (const method of value.methods) {
          const expected = METHODS.find((entry) => entry.name === method.name)!
          expect({ name: method.name, tool: method.tool, kind: method.kind, class: method.class, action: method.action, available: method.available, input: method.input })
            .toEqual({ name: method.name, tool: `slack_${method.name}`, kind: "mcp", class: expected.class, action: `slack_${method.name}`, available: true, input: fakeInput(method.name) })
        }
        expect(value.unclassified).toEqual(["slack_brand_new_tool"])
        const from = host.toolCalls().length
        expect(await run("build", "slack_brand_new_tool", { query: "q" })).toMatchObject({ type: expect.not.stringMatching(/^failed$/) })
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

      test("a write is a method, and runs on the default access with no allow rule", async () => {
        const from = host.toolCalls().length
        expect((await run("build", "slack_send_message", MESSAGE)).value).toMatchObject({ output: { tool: "slack_send_message" } })
        expect(since(from)).toEqual(["slack_send_message"])
      })

      test("a write a session allows runs, and the fake server receives it", async () => {
        const from = host.toolCalls().length
        expect(await run("send", "slack_send_message", MESSAGE)).toEqual({
          value: { output: { tool: "slack_send_message", arguments: MESSAGE }, text: `slack_send_message: ${JSON.stringify(MESSAGE)}` },
        })
        expect(since(from)).toEqual(["slack_send_message"])
      })

      test("the private search and the file read are methods too, and run on the default access", async () => {
        const from = host.toolCalls().length
        expect((await run("build", "slack_search_public_and_private", { query: "q" })).value).toMatchObject({ output: { tool: "slack_search_public_and_private" } })
        expect((await run("build", "slack_read_file", FILE)).value).toMatchObject({ output: { tool: "slack_read_file" } })
        const { data: pending } = await host.client.permission.request.list(at("defaults"))
        expect(pending.filter((request) => JSON.stringify(request).includes(sessions.build!))).toEqual([])
        expect(since(from)).toEqual(["slack_search_public_and_private", "slack_read_file"])
      })

      test("applies the session's rules after the agent's: an allow rule opens the tools that ask", async () => {
        const from = host.toolCalls().length
        expect(await run("narrow", "slack_search_public", { query: "q" })).toMatchObject({ type: "failed", code: "PERMISSION_DENIED" })
        expect((await run("narrow", "slack_read_channel", CHANNEL)).value).toMatchObject({ output: { tool: "slack_read_channel" } })
        expect((await run("allowed", "slack_search_public_and_private", { query: "q" })).value).toMatchObject({ output: { tool: "slack_search_public_and_private" } })
        expect((await run("allowed", "slack_read_file", FILE)).value).toMatchObject({ output: { tool: "slack_read_file" } })
        expect((await run("reopen", "slack_read_thread", THREAD)).value).toMatchObject({ output: { tool: "slack_read_thread" } })
        expect(await run("reopen", "slack_read_channel", CHANNEL)).toMatchObject({ type: "failed", code: "PERMISSION_DENIED" })
        expect(since(from)).toEqual(["slack_read_channel", "slack_search_public_and_private", "slack_read_file", "slack_read_thread"])
      })

      test("describe with a session reports each method's permission; without one it omits it", async () => {
        const { value } = await script("describe", { sessionID: sessions.build })
        const expected = Object.fromEntries(METHODS.map((method) => [method.name, "allow"]))
        expect(Object.fromEntries(value.methods.map((method: { name: string; permission: string }) => [method.name, method.permission]))).toEqual(expected)
        const plain = (await script("describe", {})).value
        expect(plain.methods.every((method: object) => !Object.hasOwn(method, "permission"))).toBe(true)
        expect(plain.location).toBe(host.location("defaults").directory)
        expect(plain.locationHint).toContain("x-opencode-directory")
      })

      test("gives Slack's own error as UPSTREAM_ERROR: its first line, with the signed URL redacted", async () => {
        const result = await run("build", "slack_search_channels", { query: "fail" })
        expect(result).toMatchObject({ type: "failed", code: "UPSTREAM_ERROR" })
        expect(result.message).toContain("https://files.slack.example/f.pdf?[redacted]")
        for (const hidden of ["fake-signature-123", "second line"]) expect(result.message).not.toContain(hidden)
        expect(UPSTREAM_FAILURE).toContain("fake-signature-123")
      })

      test("a call with no location fails rpc.unavailable; the location query and the header work", async () => {
        if (host.api === undefined) {
          console.log("the embedded host exposes one location API, so the raw location cases run on the stock binaries")
          return
        }
        const path = `/api/rpc/${TOOLS_RPC_ID}/describe`
        const missing = await host.api("POST", path, { input: {} })
        expect(missing.status).toBe(400)
        expect(JSON.stringify(missing.data)).toContain("rpc.unavailable")
        const query = await host.api("POST", path, { input: {} }, host.location("defaults").directory)
        expect(query.status).toBe(200)
        const header = await host.api("POST", path, { input: {} }, undefined, { "x-opencode-directory": host.location("defaults").directory })
        expect(header.status).toBe(200)
      })

      test("opencode api needs x-opencode-directory:$PWD: without it rpc.unavailable, with it the call runs", async () => {
        if (host.cli === undefined) {
          console.log("the embedded host has no opencode api, so the CLI location case runs on the stock binaries")
          return
        }
        const body = JSON.stringify({ input: {} })
        const without = host.cli(["post", `/api/rpc/${TOOLS_RPC_ID}/describe`, "-d", body])
        expect(without.status).not.toBe(0)
        expect(without.out).toContain("rpc.unavailable")
        const withHeader = host.cli(["post", `/api/rpc/${TOOLS_RPC_ID}/describe`, "-d", body, "-H", `x-opencode-directory:${host.location("defaults").directory}`])
        expect(withHeader.status).toBe(0)
        expect(JSON.parse(withHeader.out)).toMatchObject({ output: { location: host.location("defaults").directory } })
      })

      test("refuses with SERVER_CONFLICT while the user's own server holds the name", async () => {
        expect(await run("collision", "slack_search_public", { query: "q" }, "collision")).toMatchObject({ type: "failed", code: "SERVER_CONFLICT" })
        const { value } = await script("describe", {}, "collision")
        expect(value.methods.every((method: { available: boolean; reason: string }) => !method.available && method.reason === "SERVER_CONFLICT")).toBe(true)
      })

      test("without a Slack app client ID, refuses with CLIENT_ID_MISSING and /slack-status's next step", async () => {
        const next = "Run /connect and choose Slack app client ID, then paste your Slack app's client ID."
        expect(await status("connect")).toMatchObject({ code: "CLIENT_ID_MISSING", nextStep: next })
        const refused = await run("unconfigured", "slack_search_public", { query: "q" }, "connect")
        expect(refused).toMatchObject({ type: "failed", code: "CLIENT_ID_MISSING" })
        expect(refused.message).toContain(`CLIENT_ID_MISSING: the "slack" server is not registered. Next step: ${next}`)
        const { value } = await script("describe", {}, "connect")
        expect(value.methods.every((method: { available: boolean; reason: string }) => !method.available && method.reason === "CLIENT_ID_MISSING")).toBe(true)
      })

      test("names an unknown session, a session without an agent, and rejects an envelope with extra keys", async () => {
        expect(await run("ses_does_not_exist", "slack_search_public", { query: "q" })).toMatchObject({ type: "failed", code: "SESSION_UNKNOWN" })
        expect(await run("agentless", "slack_search_public", { query: "q" })).toMatchObject({ type: "failed", code: "SESSION_AGENT_REQUIRED" })
        const from = host.toolCalls().length
        for (const envelope of [{ sessionID: sessions.build, input: { query: "q" }, extra: true }, { input: { query: "q" } }, { sessionID: sessions.build, input: "q" }])
          expect(await script("slack_search_public", envelope)).toMatchObject({ type: "rpc.invalid_input" })
        const describing = await script("describe", { input: {} })
        expect(describing).toMatchObject({ type: "rpc.invalid_input" })
        expect(describing.message).toContain(`"input" is not allowed`)
        expect(since(from)).toEqual([])
      })

      test("is not registered for invalid options", async () => {
        expect(await script("describe", {}, "invalid")).toMatchObject({ type: "rpc.unavailable", message: `RPC is unavailable: ${TOOLS_RPC_ID}` })
      })
    })

    // R2: the same proofs on the Code Mode path, inside the host's `execute`, where nobody can answer a prompt.
    test("R2 Code Mode: a read runs; an ask and a deny are refused with nothing sent; an unknown name is refused", async () => {
      await discovered("defaults")
      const created = async (permissions?: Rule[]) =>
        (await host.client.session.create({ title: "code mode", agent: "build", ...at("defaults"), ...(permissions ? { permissions } : {}) } as never)).id
      const run = (sessionID: string, tool: string) =>
        codeMode("defaults", sessionID, `const r = await tools.slack[${JSON.stringify(tool)}]({}); throw new Error("SEEN " + JSON.stringify(r))`)

      const READ = "slack_read_user_profile"
      const before = host.toolCalls().length
      expect(await run(await created(), READ)).toHaveProperty("seen")
      expect(host.toolCalls().slice(before)).toEqual([READ])

      // An ask is refused before the tool runs: nothing reaches Slack and no prompt is left waiting.
      const asking = host.toolCalls().length
      const askSession = await created([{ action: "slack_slack_read_user_profile", resource: "*", effect: "ask" }])
      const asked = await run(askSession, READ)
      expect(asked).toHaveProperty("refused")
      expect((asked as { refused: string }).refused).toMatch(/needs approval|nobody is present|not permitted|declined|ask/i)
      expect(host.toolCalls().slice(asking)).toEqual([])
      expect(await host.client.permission.list({ sessionID: askSession, ...at("defaults") })).toEqual([])

      const denied = await run(await created([{ action: "slack_slack_read_user_profile", resource: "*", effect: "deny" }]), READ)
      expect(denied).toHaveProperty("refused")
      const unknown = await run(await created(), "no_such_tool")
      expect(unknown).toHaveProperty("refused")
      expect(host.toolCalls().slice(asking)).toEqual([])
    })

    // R18: one host test per value, on the tools RPC path, where a refusal must reach nothing.
    describe("access", () => {
      for (const [project, access, effect] of [
        ["accessAll", "all", "allow"],
        ["accessAsk", "ask-changes", "ask"],
        ["accessReadOnly", "read-only", "deny"],
      ] as const) {
        test(`${access}: the block is the ${access} one, a read runs, and a write ${effect === "allow" ? "runs" : effect === "ask" ? "is refused with nothing sent" : "is denied"}`, async () => {
          await discovered(project)
          const contract = await host.client.session.create({ title: "access", agent: "build", ...at(project) })
          const CHANNEL = { channel_id: "C0TEST" }
          const MESSAGE = { channel_id: "C0TEST", text: "hello" }
          const script = async (method: string, input: object = {}): Promise<{ value?: unknown; code?: string; message?: string }> => {
            try {
              return { value: await call(TOOLS_RPC_ID, method, project, { sessionID: contract.id, input }) }
            } catch (error) {
              const e = error as Record<string, any>
              return { code: e.data?.code, message: String(e.message ?? e) }
            }
          }
          const before = host.toolCalls().length
          expect(await script("slack_read_channel", CHANNEL)).toHaveProperty("value")
          const write = await script("slack_send_message", MESSAGE)
          if (effect === "allow") expect(write).toHaveProperty("value")
          else {
            expect(write).toMatchObject({ code: "PERMISSION_DENIED" })
            if (effect === "ask") expect(write.message).toMatch(/would ask/)
            expect(host.toolCalls().slice(before)).toEqual(["slack_read_channel"])
          }
          if (effect === "allow") expect(host.toolCalls().slice(before)).toEqual(["slack_read_channel", "slack_send_message"])
          expect(await host.client.permission.list({ sessionID: contract.id, ...at(project) })).toEqual([])
        })
      }
    })

    describe("user permissions", () => {
      test.each(["build", "custom"])("V2: a user allow for slack_slack_send_message wins for %s", async (agent) => {
        expect((await check("rules", agent, "slack_send_message")).outcome).toBe("allow")
      })

      test.each(["build", "custom"])("V5: a user deny for slack_slack_search_public blocks %s", async (agent) => {
        expect((await check("rules", agent, "slack_search_public")).outcome).toBe("deny")
      })

      test("other defaults still run", async () => {
        expect((await check("rules", "build", "slack_read_file")).outcome).toBe("allow")
        expect((await check("rules", "build", "slack_brand_new_tool")).outcome).toBe("allow")
      })

      test("with the status fix, the user's own rules keep winning", async () => {
        expect((await check("rules", "fixed", "slack_send_message")).outcome).toBe("allow")
        expect((await check("rules", "fixed", "slack_search_public")).outcome).toBe("deny")
        expect((await check("rules", "fixed", "slack_read_thread")).outcome).toBe("allow")
        expect((await check("rules", "fixed", "slack_read_file")).outcome).toBe("allow")
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

    describe("a project skill with the bundled skill's id", () => {
      test("wins in OpenCode, and status names its file", async () => {
        const path = join(host.root, SHADOWING_SKILL)
        // Status waits for the project to load; the skill list does not.
        await status("shadowed")
        const listed = (await host.client.skill.list(at("shadowed"))).data.filter((skill) => skill.id === "slack-search")
        expect(listed.map((skill) => skill.path)).toEqual([path])
        expect(await status("shadowed")).toMatchObject({ shadowedSkills: [{ id: "slack-search", path }] })
        expect(await slashStatus("shadowed")).toContain(`Skills: slack-search is shadowed by ${path}, `)
      })
    })

    describe("invalid options", () => {
      test("register only the status surfaces, which name the option and the fix", async () => {
        expect(await status("invalid")).toMatchObject({
          state: "not_configured",
          code: "OPTIONS_INVALID",
          message: "Option oauth.bogus: This option is not supported.",
          nextStep: "Remove it. Supported oauth options: client_id, redirect_uri, callback_port, scopes, client_secret.",
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
        expect(await slashStatus("hosted")).not.toContain("Slack app client ID")
      })
    })

    describe("a Slack app client ID from /connect", () => {
      const NEXT = "Run /connect and choose Slack app client ID, then paste your Slack app's client ID."

      test("without one, Slack app is listed in /connect and the server is not registered", async () => {
        expect(await status("connect")).toMatchObject({ state: "not_configured", code: "CLIENT_ID_MISSING", nextStep: NEXT })
        expect((await probe("connect")).registered).toBeNull()
        const app = (await host.client.integration.list(at("connect"))).data.find((item) => item.id === "slack-app")
        expect(app).toMatchObject({
          name: "Slack app client ID",
          methods: [{ type: "key", label: "Slack app client ID", form: [{ key: "client_secret", type: "string", title: "Client secret", required: false }] }],
        })
        // Projects that set the client ID in their options have no Slack app client ID entry.
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
    test("V3: under ask-changes, replying always lets the next identical call through without asking", async () => {
      expect((await status("accessAsk")).state).toBe("connected")
      expect(await check("accessAsk", "build", "slack_schedule_message", "always")).toEqual({ outcome: "ask", asked: "slack_slack_schedule_message", afterReply: "allowed" })
      expect(await check("accessAsk", "build", "slack_schedule_message")).toEqual({ outcome: "allow" })
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
