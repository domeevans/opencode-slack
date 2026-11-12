import type { Plugin } from "@opencode/plugin"
import { SERVER } from "./defaults.js"
import { eventsError } from "./events.js"
import type { JsonSchema, OwnedMethod } from "./host/tools-rpc.js"
import { NOT_SIGNED_IN, type SlackApi } from "./slack-api.js"
import { MARK_READ } from "./tools.js"
import type { Status } from "./status.js"

/**
 * `slack_mark_read`: marks a conversation read up to a message, with Slack's `conversations.mark`, which Slack's MCP
 * server has no tool for. It is the plugin's own tool in the `slack` namespace and the tools RPC method `mark_read`,
 * class `write`. It asserts its own action, `slack_mark_read`, then makes one Web API call through `slack-api.ts`, the
 * only code that reads the Slack token. Slack needs the `:write` scope of the conversation's type (`channels:write`,
 * `groups:write`, `im:write` or `mpim:write`); without it the call is `SCOPE_MISSING`.
 */

/** The tool's permission action, and the tools RPC method's. */
export const MARK_READ_ACTION = `${SERVER}_${MARK_READ}`
/** The scopes `conversations.mark` needs, one per conversation type. */
export const MARK_READ_SCOPES: readonly string[] = ["channels:write", "groups:write", "im:write", "mpim:write"]

/** A public or private channel (`C…`, `G…`) or a direct or group message (`D…`). */
const CONVERSATION_ID = /^[CDG][A-Z0-9]{8,12}$/
/** Slack's ts: whole seconds, a dot and microseconds. */
const TS = /^\d{9,11}\.\d{6}$/

export const MARK_READ_INPUT: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["channel_id", "ts"],
  properties: {
    channel_id: { type: "string", pattern: CONVERSATION_ID.source, description: "A channel (C…, G…) or direct message (D…)" },
    ts: { type: "string", pattern: TS.source, description: "The message ts to mark read up to" },
  },
}

export const MARK_READ_OUTPUT: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["channel_id", "ts"],
  properties: { channel_id: { type: "string" }, ts: { type: "string" } },
}

const DESCRIPTION = "Marks a Slack conversation read for the signed-in user up to the message ts. Needs the conversation type's :write scope."

type Context = Parameters<Awaited<ReturnType<Plugin.Context["tool"]["list"]>>[number]["execute"]>[1]

export interface MarkReadOptions {
  readonly permission: Pick<Plugin.Context["permission"], "assert">
  readonly api: SlackApi
  /** The status model, read only when there is no sign-in, for its code and next step. */
  readonly status: () => Promise<Status>
}

function parse(input: unknown): { channel: string; ts: string } {
  const problems: string[] = []
  const record = typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined
  if (record === undefined) problems.push("the input must be an object")
  else {
    const extra = Object.keys(record).filter((key) => key !== "channel_id" && key !== "ts")
    if (extra.length > 0) problems.push(`${extra.map((key) => `"${key.slice(0, 40)}"`).join(", ")} is not allowed`)
    if (typeof record["channel_id"] !== "string" || !CONVERSATION_ID.test(record["channel_id"])) problems.push(`"channel_id" must be a conversation id such as C0123ABCD45 or D0123ABCD45`)
    if (typeof record["ts"] !== "string" || !TS.test(record["ts"])) problems.push(`"ts" must be a message ts such as 1700000000.000100`)
  }
  if (problems.length > 0 || record === undefined) {
    throw eventsError("INPUT_INVALID", `The mark_read input is invalid: ${problems.join("; ")}.`, "Pass channel_id and ts as mark_read's schema describes them.")
  }
  return { channel: record["channel_id"] as string, ts: record["ts"] as string }
}

async function markRead(options: MarkReadOptions, input: unknown, signal: AbortSignal) {
  const { channel, ts } = parse(input)
  const result = await options.api.call("conversations.mark", { channel, ts }, signal)
  if (result.ok) return { channel_id: channel, ts }
  if (result.error === NOT_SIGNED_IN) {
    const current = await options.status().catch(() => undefined)
    if (current?.code !== undefined && current.state !== "connected") {
      throw eventsError(current.code, `${current.message.replace(/[.\s]+$/, "")}; mark_read cannot mark ${channel} read.`, current.nextStep)
    }
    throw eventsError("AUTH_REQUIRED", "OpenCode has no Slack sign-in that mark_read can use.", "Run /connect and choose Slack, then press o or Enter to open the sign-in page.")
  }
  if (result.error === "missing_scope") {
    const needed = result.needed ?? MARK_READ_SCOPES.join(", ")
    throw eventsError(
      "SCOPE_MISSING",
      `Slack refused conversations.mark: the Slack sign-in lacks the scope ${needed}.`,
      `Add ${needed} to the Slack app's user scopes and to the plugin's oauth.scopes, then sign in to Slack again.`,
    )
  }
  throw eventsError("UPSTREAM_ERROR", `Slack's conversations.mark failed: ${result.error}.`, "Check channel_id and ts, and run /slack-status if it keeps failing.")
}

/** `slack_mark_read`, a Code Mode tool in the `slack` namespace. It asserts its own action, then marks. */
export function markReadTool(options: MarkReadOptions) {
  return {
    name: MARK_READ,
    description: DESCRIPTION,
    input: MARK_READ_INPUT,
    output: MARK_READ_OUTPUT,
    options: { namespace: SERVER },
    execute: async (input: unknown, context: Context) => {
      // Rethrown untouched: the host turns a refusal into the end of the step, and the tools RPC into PERMISSION_DENIED.
      await options.permission.assert({
        sessionID: context.sessionID,
        agent: context.agent,
        action: MARK_READ_ACTION,
        resources: ["*"],
        source: { type: "tool", messageID: context.messageID, id: context.id },
      })
      const output = await markRead(options, input, context.signal)
      return { output, content: `Marked ${output.channel_id} read up to ${output.ts}.` }
    },
  }
}

/** `mark_read` as a tools RPC method: it runs the tool's own spec as the envelope's session and agent. */
export function markReadMethod(options: MarkReadOptions): OwnedMethod {
  const tool = markReadTool(options)
  return {
    kind: "plugin",
    class: "write",
    name: MARK_READ,
    action: MARK_READ_ACTION,
    description: DESCRIPTION,
    input: MARK_READ_INPUT,
    output: MARK_READ_OUTPUT,
    run: async (input, call) => (await tool.execute(input, call as unknown as Context)).output,
    // For describe: status's code while Slack cannot be reached, such as CLIENT_ID_MISSING or AUTH_REQUIRED.
    available: async () => {
      const current = await options.status().catch(() => undefined)
      if (current === undefined || current.state === "connected") return undefined
      return current.code ?? current.state.toUpperCase()
    },
  }
}

export { MARK_READ }
