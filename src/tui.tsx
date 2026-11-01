import type { Plugin } from "@opencode/plugin/tui"
import { createSignal, For, Show } from "solid-js"
import { isStatus, SlackRpc } from "./rpc.js"
import { statusRows, type Status } from "./status.js"

const UNAVAILABLE = "STATUS_UNAVAILABLE: Slack status is unavailable. Next step: Press r to retry."
/**
 * Everything that can change what the dialog shows, including the client ID saved in /connect. OpenCode 2.2.x does
 * not stream `mcp.tools.changed` to clients, so a connected server that lists no tools yet says to press r.
 */
const REFRESH_ON = [
  "server.connected",
  "mcp.status.changed",
  "agent.updated",
  "integration.updated",
  "credential.updated",
  "credential.switched",
] as const
const NO_TOOLS_YET = "OpenCode lists Slack's tools just after it connects: press r to refresh."

/** The status rows, with a hint on the tools row while a connected server lists no tools yet. */
function dialogRows(status: Status) {
  const { read, private: search, file, write, unknown } = status.tools
  const empty = status.state === "connected" && read + search + file + write + unknown.length === 0
  return statusRows(status).map((row) => (empty && row.label === "Tools" ? { ...row, value: `${row.value}. ${NO_TOOLS_YET}` } : row))
}

export default {
  id: "slack.workspace.tui",
  setup(context) {
    const [status, setStatus] = createSignal<Status>()
    const [problem, setProblem] = createSignal<string>()
    const [loading, setLoading] = createSignal(false)
    let open = false
    let generation = 0
    let controller: AbortController | undefined

    const refresh = async () => {
      if (!open) return
      const current = ++generation
      controller?.abort()
      const request = (controller = new AbortController())
      setLoading(true)
      try {
        // The client and location change on reconnects and project switches, so read both on every call.
        const value = await context.client.rpc(SlackRpc).status({}, {
          location: context.location ?? context.data.location.default(),
          signal: request.signal,
        })
        if (current !== generation) return
        if (isStatus(value)) {
          setStatus(value)
          setProblem(undefined)
        } else {
          setProblem(UNAVAILABLE)
        }
      } catch {
        if (current === generation) setProblem(UNAVAILABLE)
      } finally {
        if (current === generation) setLoading(false)
      }
    }

    // Events are followed only while the dialog is open.
    let unsubscribe: (() => void)[] = []
    const stop = () => {
      open = false
      generation++
      controller?.abort()
      for (const off of unsubscribe.splice(0)) off()
    }

    const View = () => {
      context.keymap.layer(() => ({
        commands: [{ id: "slack.workspace.refresh", title: "Refresh Slack status", bind: "r", run: () => void refresh() }],
      }))
      return (
        <box flexDirection="column" padding={1} gap={1}>
          <text fg={context.theme.text.base}>Slack</text>
          <Show when={status()} fallback={<text fg={context.theme.text.muted}>{problem() ?? "Loading Slack status…"}</text>}>
            {(current: () => Status) => (
              <box flexDirection="column">
                <For each={dialogRows(current())}>
                  {(row) => (
                    <box flexDirection="row" gap={1}>
                      <text fg={context.theme.text.muted} width={29} flexShrink={0}>{row.label}</text>
                      <text fg={context.theme.text.base} flexShrink={1}>{row.value}</text>
                    </box>
                  )}
                </For>
              </box>
            )}
          </Show>
          <Show when={status() !== undefined && problem() !== undefined}>
            <text fg={context.theme.text.muted}>{problem()}</text>
          </Show>
          <text fg={context.theme.text.muted}>{loading() ? "Refreshing…" : "r refresh · esc close"}</text>
        </box>
      )
    }

    const show = () => {
      context.ui.dialog.show(() => <View />, stop)
      context.ui.dialog.set({ size: "large" })
      open = true
      for (const off of unsubscribe.splice(0)) off()
      unsubscribe = REFRESH_ON.map((type) => context.data.on(type, () => void refresh()))
      void refresh()
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [{ id: "slack.workspace.status", title: "Slack: Status", group: "Slack", palette: true, slash: { name: "slack" }, run: show }],
    }))

    return () => {
      const visible = open
      stop()
      if (visible) context.ui.dialog.clear()
    }
  },
} satisfies Plugin.Definition
