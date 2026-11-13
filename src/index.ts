import { Plugin } from "@opencode/plugin"
import { SERVER } from "./defaults.js"
import { registerAppIntegration, resolveClient, sameClient, serverNamer, type ClientState } from "./connect.js"
import { isSupportedHost, isTestedHost } from "./host-version.js"
import { METHODS, registerToolsRpc } from "./host/tools-rpc.js"
import { eventsMethod, eventsTool, type EventsToolOptions } from "./events.js"
import { workspaceIdentity } from "./identity.js"
import { DMS_SPEC } from "./dms.js"
import { markReadMethod, markReadTool, type MarkReadOptions } from "./mark-read.js"
import { MENTIONS_SPEC } from "./mentions.js"
import { readMethod, readTool, type ReadOptions } from "./web-reads.js"
import { slackApi } from "./slack-api.js"
import { statusMethod } from "./status-method.js"
import { parseOptions } from "./options.js"
import { insertDefaultRules } from "./permissions.js"
import { SlackRpc } from "./rpc.js"
import { registerServer } from "./server.js"
import { NAMESPACE_DESCRIPTION } from "./tools.js"
import { loadSkills, shadowedSkills, type ListedSkill } from "./skills.js"
import { buildStatus, clientNextStep, formatStatus, UNAVAILABLE } from "./status.js"
import { VERSION } from "./version.js"

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
    const hostSupported = isSupportedHost(hostVersion)
    const hostTested = isTestedHost(hostVersion)
    const parsed = parseOptions(ctx.options)
    // A host outside the supported range, or invalid options, register only the status surfaces, which explain the
    // problem. A release inside the range that the checks do not run on sets everything up; status calls it untested.
    const options = parsed.ok && (hostSupported || parsed.options.allowUntestedHost) ? parsed.options : undefined
    const stopped = new AbortController()
    let nameInUse = false
    let client: ClientState = { invalid: false }
    let bundled: readonly ListedSkill[] = []
    let cleanup = async () => {}
    // Memory's source of Slack events: a Code Mode tool in the slack namespace, and the tools RPC method events_list.
    const events: EventsToolOptions | undefined = options === undefined
      ? undefined
      : { tool: ctx.tool, permission: ctx.permission, channels: options.channels, owned: () => !nameInUse, status: () => status() }
    // The one Slack Web API client, the only code that reads the Slack token: auth.test for status's account,
    // conversations.mark for mark_read, and the reads of mentions_list and dms_list. It uses only the plugin's own
    // server's sign-in.
    const api = slackApi({ mcp: ctx.mcp, connection: ctx.integration.connection, owned: () => options !== undefined && !nameInUse })
    const identity = workspaceIdentity(api)
    const marking: MarkReadOptions | undefined = options === undefined ? undefined : { permission: ctx.permission, api, status: () => status() }
    // The structured reads take the signed-in user's id from status's auth.test.
    const reading: ReadOptions | undefined = options === undefined
      ? undefined
      : { permission: ctx.permission, api, identity: () => identity.get(), status: () => status() }

    if (options !== undefined) {
      const fromConnect = options.clientId === undefined
      if (fromConnect) await registerAppIntegration(ctx.integration)
      client = await resolveClient(ctx.integration, options).catch(() => client)
      await ctx.mcp.transform((editor) => {
        nameInUse = !registerServer(editor, options, client.client)
      })
      // Code Mode's catalog describes the server's namespace with this text; slack_events_list is the plugin's own tool in it.
      await ctx.tool.transform((editor) => {
        editor.namespace({ name: SERVER, description: NAMESPACE_DESCRIPTION })
        editor.add(eventsTool(events!))
        editor.add(markReadTool(marking!))
        editor.add(readTool(MENTIONS_SPEC, reading!))
        editor.add(readTool(DMS_SPEC, reading!))
      })
      await ctx.agent.transform((editor) => insertDefaultRules(editor, options.access))
      const skills = await loadSkills()
      bundled = skills
      await ctx.skill.transform((editor) => {
        for (const skill of skills) editor.add(skill)
      })

      // Only a server this plugin added is renamed, never one from the user's config.
      const namer = serverNamer(ctx, () => !nameInUse && client.client !== undefined)
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
            else {
              if (fromConnect) handle(updateClient)
              // A new Slack sign-in: read its account now, so the next status has it. Outside the queue: it may wait on Slack.
              void identity.get().catch(() => undefined)
            }
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

    const status = async () => {
      const servers = (await ctx.mcp.list()).data
      // The account is read only while the plugin's own server is connected; a failure leaves it out.
      const connected = options !== undefined && !nameInUse && client.client !== undefined
        && servers.find((server) => server.name === SERVER)?.status.status === "connected"
      const account = connected ? await identity.get().catch(() => undefined) : undefined
      return buildStatus({
        version: VERSION,
        hostVersion,
        hostSupported,
        hostTested,
        parsed,
        access: options?.access ?? "all",
        active: options !== undefined,
        nameInUse,
        client,
        servers,
        ...(account === undefined ? {} : { account }),
        tools: await ctx.tool.list(),
        agents: (await ctx.agent.list()).data,
        // A skill list the host cannot give reports nothing shadowed, rather than failing status.
        shadowedSkills: bundled.length === 0 ? [] : shadowedSkills(await ctx.skill.list().then((listed) => listed.data, () => []), bundled),
      })
    }

    await ctx.rpc.register(SlackRpc, {
      status: async (_input, call) => {
        try {
          return await status()
        } catch {
          return call.error("unavailable", UNAVAILABLE, undefined)
        }
      },
    })

    // Scripts call every known Slack tool with no model, as a session and its agent: reads run when the rules allow
    // them, a write or a private read needs an allow first. A user's own server under the name is not this plugin's.
    // Invalid options or an untested host register no server, so no tools RPC either. Without a usable client ID there
    // is no server either: a call gets status's code and next step, read at each call, so a client saved in /connect
    // applies at once.
    const stopTools = options === undefined
      ? async () => {}
      : await registerToolsRpc(ctx, {
        methods: events === undefined || marking === undefined || reading === undefined
          ? METHODS
          : [
            ...METHODS,
            eventsMethod(events),
            markReadMethod(marking),
            statusMethod(() => status()),
            readMethod(MENTIONS_SPEC, reading),
            readMethod(DMS_SPEC, reading),
          ],
        mcp: {
          server: SERVER,
          managed: () => !nameInUse,
          notRegistered: () => client.client !== undefined
            ? undefined
            : { code: client.invalid ? "CLIENT_ID_INVALID" : "CLIENT_ID_MISSING", next: clientNextStep() },
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
      await stopTools()
    }
  },
})
