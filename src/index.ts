import { Plugin } from "@opencode/plugin"
import { registerAppIntegration, resolveClient, sameClient, serverNamer, type ClientState } from "./connect.js"
import { isTestedHost } from "./host-version.js"
import { parseOptions } from "./options.js"
import { insertDefaultRules } from "./permissions.js"
import { SlackRpc } from "./rpc.js"
import { registerServer } from "./server.js"
import { loadSkills } from "./skills.js"
import { buildStatus, formatStatus, UNAVAILABLE } from "./status.js"

const STARTUP_POLL_MS = 250
const STARTUP_WINDOW_MS = 10_000
const RESUBSCRIBE_MS = 1_000

const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) return resolve()
  const timer = setTimeout(resolve, ms)
  signal.addEventListener("abort", () => {
    clearTimeout(timer)
    resolve()
  }, { once: true })
})

/** Calls `handle` for each event until `signal` aborts. A pending `next()` need not settle on abort, so it races it. */
async function forEach<T>(events: AsyncIterable<T>, signal: AbortSignal, handle: (event: T) => void) {
  const iterator = events[Symbol.asyncIterator]()
  const aborted = new Promise<undefined>((resolve) => signal.addEventListener("abort", () => resolve(undefined), { once: true }))
  try {
    while (!signal.aborted) {
      const result = await Promise.race([iterator.next(), aborted])
      if (result === undefined || result.done === true) return
      handle(result.value)
    }
  } finally {
    void iterator.return?.()?.catch(() => undefined)
  }
}

export default Plugin.define({
  id: "slack.workspace",
  async setup(ctx) {
    const hostVersion = ctx.app.version
    const hostTested = isTestedHost(hostVersion)
    const parsed = parseOptions(ctx.options)
    // An untested host or invalid options register only the status surfaces, which explain the problem.
    const options = parsed.ok && (hostTested || parsed.options.allowUntestedHost) ? parsed.options : undefined
    const stopped = new AbortController()
    let nameInUse = false
    let client: ClientState = { invalid: false }
    let cleanup = async () => {}

    if (options !== undefined) {
      const fromConnect = options.clientId === undefined
      if (fromConnect) await registerAppIntegration(ctx.integration, options.server)
      client = await resolveClient(ctx.integration, options).catch(() => client)
      await ctx.mcp.transform((editor) => {
        nameInUse = !registerServer(editor, options, client.client)
      })
      await ctx.agent.transform((editor) => insertDefaultRules(editor, options.server))
      const skills = await loadSkills()
      await ctx.skill.transform((editor) => {
        for (const skill of skills) editor.add(skill)
      })

      // Only a server this plugin added is renamed, never one from the user's config.
      const namer = serverNamer(ctx, options.server, () => !nameInUse && client.client !== undefined)
      // A client saved, switched or removed in `/connect` applies without a restart.
      const updateClient = async () => {
        const next = await resolveClient(ctx.integration, options)
        if (sameClient(next, client)) return
        client = next
        await ctx.mcp.reload()
      }
      // One handler at a time, in event order.
      let queue = Promise.resolve()
      const handle = (work: () => Promise<unknown>) => {
        queue = queue.then(() => (stopped.signal.aborted ? undefined : work())).then(() => undefined, () => undefined)
      }
      const listen = (async () => {
        while (!stopped.signal.aborted) {
          const events = ctx.event.subscribe({ types: ["integration.updated", "credential.updated", "credential.switched"], signal: stopped.signal })
          await forEach(events, stopped.signal, (event) => {
            if (event.type === "integration.updated") handle(() => namer.apply())
            else if (fromConnect) handle(updateClient)
          }).catch(() => undefined)
          // The stream ended or failed: subscribe again.
          await delay(RESUBSCRIBE_MS, stopped.signal)
        }
      })()
      // OpenCode registers the server's integration after setup, and an event stream has no start signal.
      const startup = (async () => {
        for (const until = Date.now() + STARTUP_WINDOW_MS; !stopped.signal.aborted && Date.now() < until;) {
          if (await namer.apply().catch(() => false)) break
          await delay(STARTUP_POLL_MS, stopped.signal)
        }
      })()
      cleanup = async () => {
        await Promise.all([listen, startup, queue])
        await namer.dispose()
      }
    }

    const status = async () => buildStatus({
      hostVersion,
      hostTested,
      parsed,
      active: options !== undefined,
      nameInUse,
      client,
      servers: (await ctx.mcp.list()).data,
      tools: await ctx.tool.list(),
      agents: (await ctx.agent.list()).data,
    })

    await ctx.rpc.register(SlackRpc, {
      status: async (_input, call) => {
        try {
          return await status()
        } catch {
          return call.error("unavailable", UNAVAILABLE, undefined)
        }
      },
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: "slack-status",
        description: "Show Slack sign-in, connection and permission status",
        execute: async ({ sessionID, delivery }) => {
          const text = await status().then(formatStatus, () => UNAVAILABLE)
          await ctx.session.synthetic({ sessionID, delivery, text, description: "Slack status", resume: false })
        },
      })
    })

    return async () => {
      stopped.abort()
      await cleanup()
    }
  },
})
