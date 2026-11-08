// Renders the built dialog (dist/tui.js) with OpenTUI's test renderer and a fake TUI context.
// The preload must load first: it maps solid-js to its client build, which OpenCode also uses. Everything that
// imports solid-js is therefore imported dynamically below.
import "@opentui/solid/preload"
import { afterEach, describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import { parseOptions } from "../../src/options.js"
import { buildStatus, stateLabel, type Status, type StatusInput } from "../../src/status.js"

const { testRender } = await import("@opentui/solid")
const { createRoot, getOwner, onCleanup } = await import("solid-js")
// The built file, not src/tui.tsx: OpenCode loads the prebuilt JavaScript. `npm run check` builds before this runs.
const tui = (await import(new URL("../../dist/tui.js", import.meta.url).href)).default as Plugin.Definition

type Context = Plugin.Context
type Layer = ReturnType<Parameters<Context["keymap"]["layer"]>[0]>
type Location = { readonly directory: string }

interface Call {
  readonly client: string
  readonly input: unknown
  readonly location: Location
  readonly signal: AbortSignal
  resolve(value: unknown): void
  reject(error: Error): void
}

function status(overrides: Partial<StatusInput> = {}): Status {
  return buildStatus({
    version: "9.9.9",
    hostVersion: "2.2.3",
    hostSupported: true,
    hostTested: true,
    parsed: parseOptions({ oauth: { client_id: "TEST_CLIENT_ID" } }),
    access: "all",
    active: true,
    nameInUse: false,
    client: { client: { id: "TEST_CLIENT_ID", source: "options" }, invalid: false },
    servers: [{ name: "slack", status: { status: "connected" } }],
    tools: [],
    agents: [],
    shadowedSkills: [],
    ...overrides,
  })
}

// Every event that can change the dialog.
const EVENTS = ["server.connected", "mcp.status.changed", "agent.updated", "integration.updated", "credential.updated", "credential.switched"]

const STATES: readonly (readonly [string, Status])[] = [
  ["connected", status({ tools: [{ name: "slack_search_public", options: { namespace: "slack" } }, { name: "slack_brand_new", options: { namespace: "slack" } }] })],
  ["sign_in_required", status({ servers: [{ name: "slack", status: { status: "needs_auth", error: "Authentication required" } }] })],
  ["connecting", status({ servers: [{ name: "slack", status: { status: "pending" } }] })],
  ["disabled", status({ servers: [{ name: "slack", status: { status: "disabled" } }] })],
  ["failed", status({ servers: [{ name: "slack", status: { status: "failed", error: "invalid_auth" } }] })],
  ["conflict", status({ nameInUse: true })],
  ["not_configured (no client ID)", status({ client: { invalid: false } })],
  ["not_configured (invalid options)", status({ parsed: parseOptions({ oauth: { bogus: 1 } }), active: false })],
  ["host_untested", status({ hostVersion: "3.0.0", hostSupported: false, hostTested: false, active: false })],
]

/** A TUI host: records RPC calls with their location and signal, event subscriptions, keymap layers and dialogs. */
function fakeTui() {
  const calls: Call[] = []
  const handlers = new Map<string, Set<() => void>>()
  const layers: { layer: Layer; removed: boolean }[] = []
  const dialogs: { render: () => unknown; onClose: (() => void) | undefined }[] = []
  const presentation: unknown[] = []
  let visible = false

  const client = (name: string) => ({
    rpc: (definition: { id: string }) => ({
      status: (input: unknown, options: { location: Location; signal: AbortSignal }) => {
        if (definition.id !== "slack.workspace") throw new Error(`unexpected RPC ${definition.id}`)
        return new Promise((resolve, reject) => {
          calls.push({ client: name, input, location: options.location, signal: options.signal, resolve, reject })
        })
      },
    }),
  })

  const context = {
    location: undefined as Location | undefined,
    client: client("first"),
    data: {
      on: (type: string, handler: () => void) => {
        const set = handlers.get(type) ?? new Set()
        handlers.set(type, set.add(handler))
        return () => void set.delete(handler)
      },
      location: { default: () => ({ directory: "/default-project" }) },
    },
    keymap: {
      layer: (factory: () => Layer) => {
        const entry = { layer: factory(), removed: false }
        layers.push(entry)
        // As in OpenCode: a layer goes away with the component or reactive owner that created it.
        if (getOwner()) onCleanup(() => void (entry.removed = true))
      },
    },
    ui: {
      dialog: {
        show: (render: () => unknown, onClose?: () => void) => {
          dialogs.push({ render, onClose })
          visible = true
        },
        set: (options: unknown) => void presentation.push(options),
        clear: () => {
          if (!visible) return
          visible = false
          dialogs.at(-1)?.onClose?.()
        },
      },
    },
    theme: { text: { base: "#ffffff", muted: "#808080" } },
  }

  const emit = (type: string) => {
    for (const handler of handlers.get(type) ?? []) handler()
  }
  const command = (bind: string) => layers.filter((entry) => !entry.removed).flatMap((entry) => entry.layer.commands ?? []).find((item) => item.bind === bind)
  const subscriptions = () => [...handlers.values()].reduce((count, set) => count + set.size, 0)

  return {
    context,
    calls,
    layers,
    dialogs,
    presentation,
    emit,
    command,
    subscriptions,
    useClient: (name: string) => void (context.client = client(name)),
    get visible() { return visible },
  }
}

type Fake = ReturnType<typeof fakeTui>
const renderers: { destroy(): void }[] = []
const deactivations: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const deactivate of deactivations.splice(0)) await deactivate()
  for (const renderer of renderers.splice(0)) renderer.destroy()
})

/** Activates the TUI plugin inside a reactive owner, as OpenCode does, and returns how to deactivate it. */
async function activate(fake: Fake) {
  let disposeRoot = () => {}
  const cleanup = await createRoot((dispose) => {
    disposeRoot = dispose
    return tui.setup(fake.context as unknown as Context)
  })
  const deactivate = async () => {
    await cleanup?.()
    disposeRoot()
  }
  deactivations.push(deactivate)
  return deactivate
}

/** Opens the dialog through the /slack command and renders it. */
async function open(fake: Fake) {
  const command = fake.layers.flatMap((entry) => entry.layer.commands ?? []).find((item) => item.slash?.name === "slack")
  if (command === undefined) throw new Error("no /slack command")
  await command.run()
  const dialog = fake.dialogs.at(-1)
  if (dialog === undefined) throw new Error("no dialog shown")
  const setup = await testRender(dialog.render as never, { width: 220, height: 40 })
  renderers.push(setup.renderer)
  // The frame's text, one trimmed line per row with runs of spaces collapsed, so column widths do not matter.
  return async () => {
    await Bun.sleep(1)
    await setup.renderOnce()
    return setup.captureCharFrame().split("\n").map((line) => line.trim().replace(/ +/g, " ")).filter(Boolean).join("\n")
  }
}

describe("activation", () => {
  test("adds the palette command and the /slack slash command, and calls nothing yet", async () => {
    const fake = fakeTui()
    await activate(fake)
    expect(fake.layers.map((entry) => entry.layer)).toEqual([{
      mode: "global",
      commands: [{ id: "slack.workspace.status", title: "Slack: Status", group: "Slack", palette: true, slash: { name: "slack" }, run: expect.any(Function) }],
    }])
    expect(fake.subscriptions()).toBe(0)
    for (const event of EVENTS) fake.emit(event)
    expect(fake.calls).toEqual([])
  })
})

describe("the dialog", () => {
  test("opens large, asks for status with no input at the default location, and shows loading", async () => {
    const fake = fakeTui()
    await activate(fake)
    const frame = await open(fake)
    expect(fake.presentation).toEqual([{ size: "large" }])
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]).toMatchObject({ input: {}, location: { directory: "/default-project" } })
    expect(await frame()).toContain("Loading Slack status…")
  })

  test.each(STATES)("renders %s", async (_state, value) => {
    const fake = fakeTui()
    await activate(fake)
    const frame = await open(fake)
    fake.calls[0]!.resolve(value)
    const text = await frame()
    const lines = text.split("\n")
    expect(lines[0]).toBe("Slack")
    expect(lines[1]).toStartWith(`Connection ${stateLabel(value)}. ${value.code === undefined ? "" : `${value.code}: `}`)
    expect(lines.at(-2)).toBe(`Next step ${value.nextStep}`)
    expect(lines).toContain("Server slack at https://mcp.slack.com/mcp")
    expect(text).toContain("Every tool runs without asking")
    expect(lines).toContain(`Tools ${value.tools.read} read, ${value.tools.private} private search, ${value.tools.file} file, ${value.tools.write} write`
      + (value.tools.unknown > 0 ? `; ${value.tools.unknown} unknown (new tools run too): ${value.tools.unknownNames.join(", ")}` : ""))
    expect(lines).toContain("Agents without default rules none")
    expect(lines.at(-1)).toBe("r refresh · esc close")
    expect(lines.filter((line) => line.startsWith("Client "))).toEqual(value.client === undefined ? [] : ["Client TEST_CLIENT_ID (public, PKCE; set in plugin options)"])
    expect(lines.filter((line) => line.startsWith("Callback "))).toEqual(value.callback === undefined ? [] : ["Callback http://localhost:8765/callback (register exactly this URL in the app's Redirect URLs)"])
  })

  test("an unguarded agent: the row shows its name, then the block to paste, one rule per line; the next step names /slack-status", async () => {
    const fake = fakeTui()
    await activate(fake)
    const frame = await open(fake)
    const value = status({ agents: [{ id: "custom", permissions: [{ action: "*", resource: "*", effect: "allow" }] }] })
    fake.calls[0]!.resolve(value)
    const lines = (await frame()).split("\n").map((line) => line.trimEnd())
    const row = lines.findIndex((line) => line.startsWith("Agents without default rules "))
    expect(lines[row]).toBe("Agents without default rules custom")
    expect(lines[row + 1]?.trim()).toBe("[")
    expect(lines[row + 2]?.trim()).toBe('{ "action": "slack_*", "resource": "*", "effect": "allow" },')
    // The block is long, so the rows scroll and the footer stays visible; the next step is in the status either way.
    expect(lines.at(-1)).toBe("r refresh · esc close")
    expect(value.nextStep).toContain("/slack-status")
  })

  test("r refreshes and shows the new status", async () => {
    const fake = fakeTui()
    await activate(fake)
    const frame = await open(fake)
    fake.calls[0]!.resolve(STATES[1]![1])
    expect(await frame()).toContain("sign-in required")
    await fake.command("r")!.run()
    expect(fake.calls).toHaveLength(2)
    expect(await frame()).toContain("Refreshing…")
    fake.calls[1]!.resolve(STATES[0]![1])
    const text = await frame()
    expect(text).toContain("Connection connected")
    expect(text).toContain("unknown (new tools run too): slack_brand_new")
    expect(text).not.toContain("Refreshing…")
  })

  test.each(EVENTS)("%s refreshes while open", async (event) => {
    const fake = fakeTui()
    await activate(fake)
    const frame = await open(fake)
    fake.calls[0]!.resolve(STATES[2]![1])
    expect(await frame()).toContain("connecting")
    fake.emit(event)
    expect(fake.calls).toHaveLength(2)
    fake.calls[1]!.resolve(STATES[0]![1])
    expect(await frame()).toContain("Connection connected")
  })

  test("a connected server with no tools yet says to press r, and never polls", async () => {
    const fake = fakeTui()
    await activate(fake)
    const frame = await open(fake)
    fake.calls[0]!.resolve(status())
    expect(await frame()).toContain("Tools 0 read, 0 private search, 0 file, 0 write. OpenCode lists Slack's tools just after it connects: press r to refresh.")
    await Bun.sleep(1_200)
    expect(fake.calls).toHaveLength(1)
    await fake.command("r")!.run()
    fake.calls[1]!.resolve(STATES[0]![1])
    const text = await frame()
    expect(text).toContain("unknown (new tools run too): slack_brand_new")
    expect(text).not.toContain("press r to refresh.")
  })

  test("ignores a stale response and aborts the request it replaced", async () => {
    const fake = fakeTui()
    await activate(fake)
    const frame = await open(fake)
    fake.emit("mcp.status.changed")
    const [first, second] = fake.calls
    expect(first!.signal.aborted).toBe(true)
    expect(second!.signal.aborted).toBe(false)
    second!.resolve(STATES[0]![1])
    expect(await frame()).toContain("Connection connected")
    first!.resolve(STATES[4]![1])
    const text = await frame()
    expect(text).toContain("Connection connected")
    expect(text).not.toContain("CONNECTION_FAILED")
  })

  test("a stale failure does not replace the current status", async () => {
    const fake = fakeTui()
    await activate(fake)
    const frame = await open(fake)
    fake.emit("server.connected")
    fake.calls[1]!.resolve(STATES[0]![1])
    fake.calls[0]!.reject(new Error("aborted"))
    const text = await frame()
    expect(text).toContain("Connection connected")
    expect(text).not.toContain("unavailable")
  })

  test.each([
    ["a malformed reply", (call: Call) => call.resolve({ state: "connected" })],
    ["a failed request", (call: Call) => call.reject(new Error("rpc failed"))],
  ])("%s shows how to retry", async (_label, reply) => {
    const fake = fakeTui()
    await activate(fake)
    const frame = await open(fake)
    reply(fake.calls[0]!)
    expect(await frame()).toContain("STATUS_UNAVAILABLE: Slack status is unavailable. Next step: Press r to retry.")
  })

  test("a failed refresh keeps the last status and adds the problem", async () => {
    const fake = fakeTui()
    await activate(fake)
    const frame = await open(fake)
    fake.calls[0]!.resolve(STATES[0]![1])
    await frame()
    await fake.command("r")!.run()
    fake.calls[1]!.reject(new Error("rpc failed"))
    const text = await frame()
    expect(text).toContain("Connection connected")
    expect(text).toContain("STATUS_UNAVAILABLE: Slack status is unavailable. Next step: Press r to retry.")
  })

  test("reads the current client and location on every call", async () => {
    const fake = fakeTui()
    await activate(fake)
    fake.context.location = { directory: "/project-a" }
    await open(fake)
    fake.context.location = { directory: "/project-b" }
    fake.useClient("second")
    await fake.command("r")!.run()
    expect(fake.calls.map((call) => [call.client, call.location.directory])).toEqual([["first", "/project-a"], ["second", "/project-b"]])
  })
})

describe("closing and disposal", () => {
  test("closing the dialog stops refreshes, aborts the request in flight and drops every subscription", async () => {
    const fake = fakeTui()
    await activate(fake)
    await open(fake)
    expect(fake.subscriptions()).toBe(EVENTS.length)
    fake.context.ui.dialog.clear()
    expect(fake.subscriptions()).toBe(0)
    expect(fake.calls[0]!.signal.aborted).toBe(true)
    for (const event of EVENTS) fake.emit(event)
    expect(fake.calls).toHaveLength(1)
  })

  test("opening the dialog again subscribes once", async () => {
    const fake = fakeTui()
    await activate(fake)
    await open(fake)
    fake.context.ui.dialog.clear()
    await open(fake)
    expect(fake.subscriptions()).toBe(EVENTS.length)
  })

  test("the refresh key goes away with the dialog", async () => {
    const fake = fakeTui()
    await activate(fake)
    await open(fake)
    expect(fake.command("r")).toBeDefined()
    renderers.pop()!.destroy()
    expect(fake.command("r")).toBeUndefined()
  })

  test("deactivating with the dialog open closes it, aborts the request and removes every subscription and layer", async () => {
    const fake = fakeTui()
    const deactivate = await activate(fake)
    await open(fake)
    renderers.pop()!.destroy()
    await deactivate()
    expect(fake.visible).toBe(false)
    expect(fake.calls[0]!.signal.aborted).toBe(true)
    expect(fake.subscriptions()).toBe(0)
    expect(fake.layers.every((entry) => entry.removed)).toBe(true)
    fake.emit("mcp.status.changed")
    expect(fake.calls).toHaveLength(1)
  })

  test("deactivating with the dialog closed leaves the dialog alone", async () => {
    const fake = fakeTui()
    const deactivate = await activate(fake)
    const shown: string[] = []
    fake.context.ui.dialog.clear = () => void shown.push("clear")
    await deactivate()
    expect(shown).toEqual([])
    expect(fake.subscriptions()).toBe(0)
  })
})
