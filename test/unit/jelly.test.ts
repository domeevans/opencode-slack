import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { appDisplayName, appIntegrationID, resolveClient, serverDisplayName } from "../../src/connect.js"
import { DEFAULT_SERVER } from "../../src/defaults.js"
import plugin from "../../src/index.js"
import { parseOptions } from "../../src/options.js"
import { defaultRules } from "../../src/permissions.js"
import { fakeHost } from "./fakes.js"

/**
 * The `jelly` section of package.json, which Jelly reads without loading the plugin. Jelly's agents have no base
 * "allow everything" rule, so this plugin's own default rules never reach them; Jelly writes each declared "ask" or
 * "deny" as that tool's default instead. So each declared effect must be the one these rules give the tool after a
 * base allow, and the declared skills must be the ones the package ships.
 */

type Tool = { name: string; permission: string; effect: string; readOnly: boolean }
type SignIn = { id: string; label: string; integration?: string; server?: string; after?: string; presetBy?: string; help?: { url: string; label: string }; relay?: Record<string, string> }
const jelly = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).jelly as { tools: Tool[]; skills: string[]; signIns: SignIn[] }
const rules: readonly { action: string; resource: string; effect: string }[] = [{ action: "*", resource: "*", effect: "allow" }, ...defaultRules("slack")]
const wildcard = (pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`)
const effectOf = (action: string) => [...rules].reverse().find((rule) => wildcard(rule.action).test(action) && rule.resource === "*")?.effect

describe("the jelly declaration", () => {
  test("gives each tool the effect the plugin's own default rules give it", () => {
    expect(jelly.tools.length).toBeGreaterThan(0)
    for (const tool of jelly.tools) expect(effectOf(tool.permission), tool.permission).toBe(tool.effect)
  })

  test("names each tool once, as the engine names its permission (namespace.tool for namespace_tool)", () => {
    const names = jelly.tools.map((tool) => tool.name)
    expect(new Set(names).size).toBe(names.length)
    for (const tool of jelly.tools) expect(tool.name.replaceAll(".", "_"), tool.name).toBe(tool.permission)
  })

  test("names every skill the package ships", () => {
    expect([...jelly.skills].sort()).toEqual(readdirSync(new URL("../../skills", import.meta.url)).sort())
  })

  describe("sign-ins", () => {
    const [app, slack] = jelly.signIns
    /** Plugin options with only the declared option path set, as an organisation's managed config sets it. */
    const presetOptions = (path: string, value: string) =>
      path.split(".").reduceRight<unknown>((inner, key) => ({ [key]: inner }), value) as Record<string, unknown>

    test("declare the Slack app's /connect entry, then the server that waits for it, under the names /connect shows", () => {
      expect(jelly.signIns.length).toBe(2)
      expect(app).toMatchObject({ id: "app", label: appDisplayName(DEFAULT_SERVER), integration: appIntegrationID(DEFAULT_SERVER) })
      expect(slack).toEqual({ id: "slack", label: serverDisplayName(DEFAULT_SERVER), server: DEFAULT_SERVER, after: "app", relay: {} })
    })

    test("Slack's own sign-in may come back through Jelly's relay, whose address the manifest lists", () => {
      const manifest = JSON.parse(readFileSync(new URL("../../docs/slack-app-manifest.json", import.meta.url), "utf8")) as { oauth_config: { redirect_urls: string[] } }
      expect(slack?.relay).toEqual({})
      expect(manifest.oauth_config.redirect_urls).toEqual(["http://localhost:8765/callback", "https://id.toqanjelly.ai/connect/callback"])
    })

    test("the app step is preset by the option that pins the client, so that client is used and no entry is registered", async () => {
      expect(app?.presetBy).toBe("oauth.client_id")
      const options = presetOptions(app!.presetBy!, "C1")
      const parsed = parseOptions(options)
      if (!parsed.ok) throw new Error(parsed.error.message)
      const resolved = await resolveClient({ connection: { active: async () => undefined, resolve: async () => undefined, status: async () => {} } } as never, parsed.options)
      expect(resolved.client).toEqual({ id: "C1", source: "options" })

      const host = fakeHost({ options })
      const cleanup = await plugin.setup(host.ctx)
      try {
        expect(host.integrations.has(app!.integration!)).toBe(false)
        expect(host.servers.get(slack!.server!)).toMatchObject({ oauth: { client_id: "C1" } })
        expect((await host.slashStatus()).text).not.toContain(app!.label)
      } finally {
        await cleanup?.()
      }
    })

    test("without the preset option, the app step's entry is the one /connect lists", async () => {
      const host = fakeHost({ options: {} })
      const cleanup = await plugin.setup(host.ctx)
      try {
        expect(host.integrations.get(app!.integration!)?.name).toBe(app!.label)
        expect(host.servers.has(slack!.server!)).toBe(false)
      } finally {
        await cleanup?.()
      }
    })
  })
})
