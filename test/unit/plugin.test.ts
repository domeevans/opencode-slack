import { afterEach, describe, expect, test } from "bun:test"
import plugin from "../../src/index.js"
import { defaultRules } from "../../src/permissions.js"
import { parseOptions } from "../../src/options.js"
import { serverConfig } from "../../src/server.js"
import { NAMESPACE_DESCRIPTION } from "../../src/tools.js"
import { agent, BASE_ALLOW, BASE_RULES, fakeHost, type FakeHostInput } from "./fakes.js"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function setUp(input: FakeHostInput = {}) {
  const host = fakeHost(input)
  const cleanup = await plugin.setup(host.ctx)
  const dispose = async () => void (await cleanup?.())
  cleanups.push(dispose)
  return { ...host, dispose }
}

const until = async (condition: () => boolean | Promise<boolean>) => {
  for (const deadline = Date.now() + 2_000; !(await condition()); await Bun.sleep(5)) {
    if (Date.now() > deadline) throw new Error("timed out")
  }
}

// The `/connect` rename of the Slack server's integration runs in the background, so these leave it out.
const registrations = (calls: readonly string[]) => calls.filter((call) => call !== "integration.transform")
// The status RPC, then the tools RPC and its evaluate hook.
const FULL = ["mcp.transform", "tool.transform", "agent.transform", "skill.transform", "rpc.register", "rpc.register", "evaluate hook", "command.transform"]
const STATUS_ONLY = ["rpc.register", "command.transform"]
const CONNECT = {}
const stored = (key: string, metadata?: Record<string, string>) => ({ type: "key" as const, key, ...(metadata ? { metadata } : {}) })
const options = (input: unknown) => {
  const parsed = parseOptions(input)
  if (!parsed.ok) throw new Error(parsed.error.message)
  return parsed.options
}

test("the plugin ID is slack.workspace", () => {
  expect(plugin.id).toBe("slack.workspace")
})

describe("setup with a client ID in the options", () => {
  test("registers the server, the default rules, the skills, the RPCs and /slack-status, in that order", async () => {
    const host = await setUp()
    expect(registrations(host.calls)).toEqual(FULL)
    expect(host.rpc.id).toBe("slack.workspace")
    expect([...host.rpcs.keys()]).toEqual(["slack.workspace", "slack.workspace.tools"])
    expect(host.commands.map((command) => command.name)).toEqual(["slack-status"])
    expect(host.commands[0]?.description).toBe("Show Slack sign-in, connection and permission status")
    expect(host.skills.map((skill) => skill.id)).toEqual(["slack-search"] as never)
  })

  test("status names a user skill with the bundled skill's id, which OpenCode loads instead, and says to move it", async () => {
    const path = "/home/someone/.config/opencode/skills/slack-search/SKILL.md"
    const host = await setUp({ status: { slack: { status: "connected" } }, userSkills: [{ id: "slack-search", path }] })
    expect(await host.status()).toMatchObject({
      state: "connected",
      shadowedSkills: [{ id: "slack-search", path }],
      nextStep: `Move or rename the skill at ${path}, so that this plugin's slack-search skill loads, then run opencode reload.`,
    })
    expect((await host.slashStatus()).text).toContain(`Skills: slack-search is shadowed by ${path}, so agents load that file instead of this plugin's skill`)
    const own = await setUp({ status: { slack: { status: "connected" } } })
    expect(await own.status()).toMatchObject({ shadowedSkills: [], nextStep: "Nothing to do." })
  })

  test("describes the server's Code Mode namespace", async () => {
    expect([...(await setUp()).namespaces.values()]).toEqual([{ name: "slack", description: NAMESPACE_DESCRIPTION }])
    expect(NAMESPACE_DESCRIPTION).toContain("untrusted")
    expect(NAMESPACE_DESCRIPTION.length).toBeLessThan(250)
  })

  test("the status RPC carries the plugin's version from package.json and the tested host", async () => {
    const { version } = JSON.parse(await Bun.file(new URL("../../package.json", import.meta.url)).text()) as { version: string }
    for (const host of ["2.2.3", "2.2.4", "2.2.5"])
      expect(await (await setUp({ version: host })).status()).toMatchObject({ version, host: { version: host, range: ">=2.2.3 <2.3.0", tested: true } })
  })

  test("a release inside the supported range that the checks do not run on sets everything up, and status calls it untested", async () => {
    const host = await setUp({ version: "2.2.6", status: { slack: { status: "connected" } } })
    expect(registrations(host.calls)).toEqual(FULL)
    expect(await host.status()).toMatchObject({ state: "connected", host: { version: "2.2.6", tested: false } })
    expect((await host.slashStatus()).text).toContain("OpenCode: 2.2.6 (untested; supported range >=2.2.3 <2.3.0)")
  })

  test("registers Slack's MCP server with the configured OAuth app", async () => {
    const host = await setUp({ options: { oauth: { client_id: "C1", scopes: ["search:read.public"] } } })
    expect(host.servers.get("slack")).toStrictEqual({
      type: "remote",
      url: "https://mcp.slack.com/mcp",
      oauth: { client_id: "C1", redirect_uri: "http://localhost:8765/callback", scope: "search:read.public" },
    })
    expect(await host.status()).toMatchObject({ client: { id: "C1", mode: "public_pkce", source: "options" } })
  })

  test("adds no Slack app entry to /connect and ignores a stored client", async () => {
    const host = await setUp({ options: { oauth: { client_id: "C1" } }, credentials: { "slack-app": stored("C2") } })
    expect(host.integrations.has("slack-app")).toBe(false)
    host.store("slack-app", stored("C3"))
    await Bun.sleep(20)
    expect(host.calls).not.toContain("mcp.reload")
    expect(host.servers.get("slack")).toMatchObject({ oauth: { client_id: "C1" } })
  })

  test("asks nobody to paste a client ID: no Slack app in /connect, status or its next step, in any connection state", async () => {
    for (const status of [{ status: "pending" }, { status: "needs_auth", error: "Authentication required" }, { status: "failed", error: "boom" }, { status: "disabled" }, { status: "connected" }] as const) {
      const host = await setUp({ options: { oauth: { client_id: "C1" } }, status: { slack: status } })
      expect([...host.integrations.keys()].filter((id) => id.endsWith("-app"))).toEqual([])
      const text = (await host.slashStatus()).text
      expect({ status: status.status, mentions: text.includes("Slack app") }).toEqual({ status: status.status, mentions: false })
      expect(await host.status()).toMatchObject({ client: { source: "options" } })
      await host.dispose()
    }
  })

  test("an https redirect registers the server with it and the callback port", async () => {
    const host = await setUp({ options: { oauth: { client_id: "C1", redirect_uri: "https://host.example/oauth/return", callback_port: 49200 } } })
    expect(host.servers.get("slack")).toStrictEqual({
      type: "remote",
      url: "https://mcp.slack.com/mcp",
      oauth: {
        client_id: "C1",
        redirect_uri: "https://host.example/oauth/return",
        callback_port: 49200,
        scope: "channels:history channels:read search:read.public users:read",
      },
    })
    expect(await host.status()).toMatchObject({ callback: "https://host.example/oauth/return", callbackPort: 49200 })
  })

  test("names the Slack server's integration Slack in /connect", async () => {
    const host = await setUp()
    await until(() => host.integrations.get("mcp_slack")?.name === "Slack")
  })

  test("inserts the default rules after the base allow of every agent that has one", async () => {
    const host = await setUp({ agents: [agent("build", BASE_RULES), agent("locked", [{ action: "*", resource: "*", effect: "deny" }])] })
    expect(host.agents.find((item) => item.id === "build")?.permissions).toEqual([BASE_ALLOW, ...defaultRules(), ...BASE_RULES.slice(1)])
    expect(host.updatedAgents).toEqual(["build"])
  })

  test("a server the user already configured is kept, and status says the name is in use", async () => {
    const mine = { type: "remote", url: "https://mcp.example.test/mcp" } as const
    const host = await setUp({ servers: { slack: mine } })
    expect(host.servers.get("slack")).toStrictEqual(mine)
    expect(registrations(host.calls)).toEqual(FULL)
    expect(await host.status()).toMatchObject({ state: "conflict", code: "SERVER_NAME_IN_USE" })
    await Bun.sleep(50)
    expect(host.integrations.get("mcp_slack")?.name).not.toBe("Slack")
  })

  test("the status RPC reports the live connection, tools and agents", async () => {
    const host = await setUp({
      status: { slack: { status: "connected" } },
      tools: [{ name: "slack_search_public", options: { namespace: "slack" } }, { name: "slack_brand_new", options: { namespace: "slack" } }],
      agents: [agent("build", BASE_RULES)],
    })
    expect(await host.status()).toMatchObject({
      state: "connected",
      tools: { read: 1, private: 0, file: 0, write: 0, unknown: 1, unknownNames: ["slack_brand_new"] },
      unguardedAgents: [],
      host: { version: "2.2.3", range: ">=2.2.3 <2.3.0", tested: true },
    })
  })

  test("the status RPC returns the unavailable error when the host cannot answer", async () => {
    const host = await setUp()
    host.failLists()
    expect(await host.status()).toEqual({
      error: "unavailable",
      message: "STATUS_UNAVAILABLE: Slack status is unavailable. Next step: Run /slack-status again in a moment.",
      data: undefined,
    })
  })

  test("/slack-status posts the status as one message that does not start a turn", async () => {
    const host = await setUp({ status: { slack: { status: "needs_auth", error: "Authentication required" } } })
    const message = await host.slashStatus()
    expect(message).toMatchObject({ sessionID: "ses_test", delivery: "queue", description: "Slack status", resume: false })
    expect(message.text).toStartWith("Slack\nConnection: sign-in required. AUTH_REQUIRED: ")
    expect(message.text).toEndWith("\nNext step: Run /connect and choose Slack, then press o or Enter to open the sign-in page (in a terminal, opencode mcp auth slack opens the browser automatically).")
  })

  test("/slack-status says when status is unavailable", async () => {
    const host = await setUp()
    host.failLists()
    expect((await host.slashStatus()).text).toBe("STATUS_UNAVAILABLE: Slack status is unavailable. Next step: Run /slack-status again in a moment.")
  })

  test("replaying the server and agent transforms changes nothing", async () => {
    const host = fakeHost()
    const transforms: never[] = []
    const capture = (domain: { transform: (callback: never) => Promise<unknown> }) => {
      const original = domain.transform
      domain.transform = (callback: never) => {
        transforms.push(callback)
        return original(callback)
      }
    }
    capture(host.ctx.mcp as never)
    capture(host.ctx.agent as never)
    const cleanup = await plugin.setup(host.ctx)
    cleanups.push(async () => void (await cleanup?.()))
    const once = { servers: structuredClone([...host.servers]), agents: structuredClone(host.agents) }
    expect(transforms.length).toBe(2)
    await host.ctx.mcp.reload()
    await host.ctx.agent.transform(transforms[1]!)
    expect({ servers: [...host.servers], agents: host.agents }).toEqual(once)
  })

  test("cleanup ends the event subscription", async () => {
    const host = await setUp()
    await until(() => host.subscribers() === 1)
    await host.dispose()
    expect(host.subscribers()).toBe(0)
  })
})

describe("setup without a client ID in the options", () => {
  test("adds Slack app to /connect: a key method for the client ID with an optional secret", async () => {
    const host = await setUp({ options: CONNECT })
    expect(host.calls[0]).toBe("integration.transform")
    expect(host.integrations.get("slack-app")).toEqual({
      name: "Slack app",
      methods: [{
        type: "key",
        label: "Slack app client ID",
        form: [{
          key: "client_secret",
          type: "string",
          title: "Client secret",
          description: "Only for a Slack app without PKCE. Skip it for an app made from the plugin's manifest.",
          required: false,
        }],
      }],
    } as never)
  })

  test("with nothing stored, registers no server but still the rules and skills, and asks for the client ID", async () => {
    const host = await setUp({ options: CONNECT })
    expect(host.servers.size).toBe(0)
    expect(registrations(host.calls)).toEqual(FULL)
    expect(host.agents[0]?.permissions[1]).toEqual({ action: "slack_*", resource: "*", effect: "ask" })
    const status = await host.status()
    expect(status).toMatchObject({
      state: "not_configured",
      code: "CLIENT_ID_MISSING",
      message: "No Slack app client ID is set, so Slack is not added. To create the app, use the manifest at https://github.com/joe-broadhead/opencode-slack/blob/HEAD/docs/slack-app-manifest.json.",
      nextStep: "Run /connect and choose Slack app, then paste your Slack app's client ID.",
    })
    expect(Object.keys(status as object)).not.toContain("client")
    expect((await host.slashStatus()).text).toEndWith("\nNext step: Run /connect and choose Slack app, then paste your Slack app's client ID.")
  })

  test("uses the client saved in /connect, with its optional secret", async () => {
    const host = await setUp({ options: CONNECT, credentials: { "slack-app": stored(" C2 ", { client_secret: "shh" }) } })
    expect(host.servers.get("slack")).toStrictEqual(serverConfig(options({}), { id: "C2", secret: "shh", source: "connect" }))
    expect(await host.status()).toMatchObject({ client: { id: "C2", mode: "confidential", source: "connect" } })
  })

  test("an empty secret field means a public client", async () => {
    const host = await setUp({ options: CONNECT, credentials: { "slack-app": stored("C2", { client_secret: " " }) } })
    expect(host.servers.get("slack")).toMatchObject({ oauth: { client_id: "C2" } })
    expect(Object.keys((host.servers.get("slack") as { oauth: object }).oauth)).not.toContain("client_secret")
  })

  test("a saved client ID with spaces is reported, and no server is added", async () => {
    const host = await setUp({ options: CONNECT, credentials: { "slack-app": stored("C2 C3") } })
    expect(host.servers.size).toBe(0)
    expect(await host.status()).toMatchObject({
      state: "not_configured",
      code: "CLIENT_ID_INVALID",
      message: "The client ID saved in the /connect Slack app entry is empty or has spaces, so Slack is not added.",
      nextStep: "Run /connect and choose Slack app, then paste your Slack app's client ID.",
    })
    expect(host.connectionStatus.get("slack-app")).toEqual({ status: "needs_auth", message: "This is not a Slack client ID: it is empty or has spaces." })
    await until(() => host.subscribers() === 1)
    host.store("slack-app", stored("C2"))
    await until(() => host.servers.has("slack"))
    expect(host.connectionStatus.has("slack-app")).toBe(false)
  })

  test("saving, replacing and removing the client in /connect reloads the server without a restart", async () => {
    const host = await setUp({ options: CONNECT })
    await until(() => host.subscribers() === 1)
    host.store("slack-app", stored("C2"))
    await until(() => host.servers.has("slack"))
    expect(host.servers.get("slack")).toMatchObject({ oauth: { client_id: "C2" } })
    host.store("slack-app", stored("C3"))
    await until(() => (host.servers.get("slack") as { oauth?: { client_id?: string } } | undefined)?.oauth?.client_id === "C3")
    host.store("slack-app", undefined)
    await until(() => !host.servers.has("slack"))
    expect(host.calls.filter((call) => call === "mcp.reload").length).toBe(3)
    expect(await host.status()).toMatchObject({ state: "not_configured" })
  })

  test("an unrelated credential change does not reload", async () => {
    const host = await setUp({ options: CONNECT, credentials: { "slack-app": stored("C2") } })
    await until(() => host.subscribers() === 1)
    host.emit("credential.switched")
    await Bun.sleep(20)
    expect(host.calls).not.toContain("mcp.reload")
  })
})

describe("setup that registers only the status surfaces", () => {
  test.each(["2.2.2", "2.3.0", "3.0.0", "2.2.4-beta.1", "0.0.0-dev-385", "unknown"])("host %p", async (version) => {
    const host = await setUp({ version })
    expect(host.calls).toEqual(STATUS_ONLY)
    expect(host.servers.size).toBe(0)
    expect(host.namespaces.size).toBe(0)
    expect(host.agents[0]?.permissions).toEqual([...BASE_RULES])
    expect(await host.status()).toMatchObject({ state: "host_untested", code: "HOST_UNTESTED", host: { version, tested: false } })
    expect((await host.slashStatus()).text).toContain("Connection: host untested. HOST_UNTESTED: ")
  })

  test.each([
    ["an unknown option", { oauth: { client_id: "C1", redirect_port: 8765 } }, "oauth.redirect_port"],
    ["a secret without a client ID", { oauth: { client_secret: "s" } }, "oauth.client_secret"],
    ["a bad server name", { oauth: { client_id: "C1" }, server: "a.b" }, "server"],
    ["options that are not an object", "slack", "options"],
  ])("invalid options: %s", async (_label, options, field) => {
    const host = await setUp({ options })
    expect(host.calls).toEqual(STATUS_ONLY)
    const status = await host.status()
    expect(status).toMatchObject({ state: "not_configured", code: "OPTIONS_INVALID" })
    expect((status as { message: string }).message).toStartWith(`Option ${field}: `)
    expect((await host.slashStatus()).text).toContain("Connection: not configured. OPTIONS_INVALID: ")
  })

  test("an untested host with allowUntestedHost proceeds and still warns", async () => {
    const host = await setUp({ version: "2.3.0-beta.1", options: { oauth: { client_id: "C1" }, allowUntestedHost: true }, status: { slack: { status: "pending" } } })
    expect(registrations(host.calls)).toEqual(FULL)
    expect(host.servers.get("slack")).toStrictEqual(serverConfig(options({ allowUntestedHost: true }), { id: "C1", source: "options" }))
    expect(await host.status()).toMatchObject({ state: "connecting", host: { version: "2.3.0-beta.1", tested: false } })
    expect((await host.slashStatus()).text).toContain("OpenCode: 2.3.0-beta.1 (untested; supported range >=2.2.3 <2.3.0)")
  })

  test("an untested host with allowUntestedHost and invalid options reports the invalid option", async () => {
    const host = await setUp({ version: "2.3.0", options: { oauth: { redirect_port: 1 }, allowUntestedHost: true } })
    expect(host.calls).toEqual(STATUS_ONLY)
    expect(await host.status()).toMatchObject({
      state: "not_configured",
      code: "OPTIONS_INVALID",
      message: "Option oauth.redirect_port: This option is not supported.",
      host: { version: "2.3.0", tested: false },
    })
    const text = (await host.slashStatus()).text
    expect(text).toContain("Connection: not configured. OPTIONS_INVALID: ")
    expect(text).not.toContain("allowUntestedHost")
  })
})
