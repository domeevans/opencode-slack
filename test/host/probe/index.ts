// Test-only plugin, configured after slack.workspace so its transforms run later. It keeps Slack offline and
// asserts permissions the way OpenCode's MCP tools do: action `<server>_<tool>`, resource `*`, saved as `*`.
import { Plugin } from "@opencode/plugin"
import { Rpc } from "@opencode/plugin/rpc"

const json = { type: "object" } as const

const Probe = Rpc.define({
  id: "slack.test.probe",
  methods: {
    state: { input: json, output: json },
    reload: { input: json, output: json },
    check: { input: json, output: json },
    paths: { input: json, output: json },
  },
  events: {},
})

interface ProbeOptions {
  /** Replace the Slack server with this local command (an offline fake). Without it, the server is disabled. */
  readonly fake?: readonly string[]
}

export type Outcome =
  | { readonly outcome: "allow" | "deny" }
  | { readonly outcome: "ask"; readonly asked: string; readonly afterReply: "allowed" | "rejected" }
  | { readonly outcome: "timeout" }

const sleep = (ms: number) => new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))

export default Plugin.define({
  id: "slack.test.probe",
  async setup(ctx) {
    const options = ctx.options as ProbeOptions
    let registered: unknown = null

    await ctx.mcp.transform((editor) => {
      const config = editor.get("slack")
      registered = config === undefined ? null : JSON.parse(JSON.stringify(config))
      if (config === undefined) return
      if (options.fake !== undefined) editor.set("slack", { type: "local", command: [...options.fake] })
      else editor.update("slack", (draft) => void (draft.disabled = true))
    })

    const state = async () => ({
      registered,
      agents: (await ctx.agent.list()).data.map((agent) => ({ id: agent.id, permissions: agent.permissions })),
    })

    await ctx.rpc.register(Probe, {
      state: async () => state(),
      // OpenCode's global paths as this host process resolves them, from its own environment and runtime.
      paths: async () => {
        const { Path } = (await import("@opencode/util/global")).Global
        return { home: Path.home, data: Path.data, cache: Path.cache, config: Path.config, state: Path.state, tmp: Path.tmp, bin: Path.bin, log: Path.log, repos: Path.repos }
      },
      reload: async () => {
        await ctx.agent.reload()
        return state()
      },
      check: async (input) => {
        const { agent, action, reply } = input as { agent: string; action: string; reply?: "once" | "always" | "reject" }
        const session = await ctx.session.create({ title: `probe ${agent} ${action}` })
        const settled = ctx.permission
          .assert({ sessionID: session.id, agent: agent as never, action, resources: ["*"], save: ["*"], metadata: { input: {} } })
          .then(() => "allowed" as const, () => "rejected" as const)
        for (const deadline = Date.now() + 20_000; Date.now() < deadline;) {
          const done = await Promise.race([settled, sleep(25)])
          if (done !== undefined) return { outcome: done === "allowed" ? "allow" : "deny" } satisfies Outcome
          const [pending] = await ctx.permission.list({ sessionID: session.id })
          if (pending !== undefined) {
            await ctx.permission.reply({ sessionID: session.id, requestID: pending.id, decision: reply ?? "reject" })
            return { outcome: "ask", asked: pending.action, afterReply: await settled } satisfies Outcome
          }
        }
        return { outcome: "timeout" } satisfies Outcome
      },
    })
  },
})
