import type { Plugin } from "@opencode/plugin"
import { SERVER } from "./defaults.js"
import { eventsError } from "./events.js"
import type { JsonSchema, OwnedMethod } from "./host/tools-rpc.js"
import type { Identity } from "./identity.js"
import { NOT_SIGNED_IN, type SlackApi, type SlackApiMethod, type SlackApiResult } from "./slack-api.js"
import type { Status } from "./status.js"

/**
 * What the plugin's structured reads, `mentions_list` and `dms_list`, share: their options, how they read a time, a
 * Slack ts and a message's text, how they wait out Slack's rate limits, how they turn Slack's refusals into the plugin's
 * codes, and how each becomes both a Code Mode tool in the `slack` namespace and a tools RPC method of class `read`.
 * They call Slack's Web API through `slack-api.ts`, the only code that reads the Slack token.
 */

export interface ReadOptions {
  readonly permission: Pick<Plugin.Context["permission"], "assert">
  readonly api: SlackApi
  /** The signed-in account, from status's one `auth.test` per sign-in. */
  readonly identity: () => Promise<Identity | undefined>
  /** The status model, read only when there is no sign-in, for its code and next step. */
  readonly status: () => Promise<Status>
  /** Waits between rate-limited tries; tests pass their own. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

/** The longest text a read returns for one message, in characters. */
export const MAX_TEXT = 4_096
/** How many times one request is tried again after Slack's rate limit, and the longest wait Slack may ask for. */
const RATE_RETRIES = 2
const MAX_RETRY_AFTER_S = 30

/** Slack's ts: whole seconds, a dot and microseconds. */
export const TS = /^\d{9,11}\.\d{6}$/
/** A date and time with a zone, such as `2026-11-13T09:00:00Z` or `2026-11-13T10:00:00.000+01:00`. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/

export const ISO_PATTERN = ISO.source

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
export const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {})
export const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined)

/** Milliseconds since the epoch for an ISO date and time with a zone, or undefined. */
export function parseTime(value: unknown): number | undefined {
  if (typeof value !== "string" || !ISO.test(value)) return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

/** A Slack ts as milliseconds since the epoch. */
export const tsMillis = (ts: string): number => Math.floor(Number(ts) * 1000)

/** A Slack ts as an ISO date and time in UTC. */
export const tsTime = (ts: string): string => new Date(tsMillis(ts)).toISOString()

/** A message's text, at most `MAX_TEXT` characters, cut at a whole character. */
export function boundText(text: string): string {
  const chars = Array.from(text)
  return chars.length <= MAX_TEXT ? text : `${chars.slice(0, MAX_TEXT - 1).join("")}…`
}

/** Checks an input object against the fields a read takes. */
export function inputProblems(input: unknown, fields: readonly string[]): { record?: Record<string, unknown>; problems: string[] } {
  if (!isRecord(input)) return { problems: ["the input must be an object"] }
  const extra = Object.keys(input).filter((key) => !fields.includes(key))
  return { record: input, problems: extra.length > 0 ? [`${extra.map((key) => `"${key.slice(0, 40)}"`).join(", ")} is not allowed`] : [] }
}

/** A whole number from `low` to `high`, or the default when absent; undefined when it is something else. */
export function limitOf(value: unknown, low: number, high: number, fallback: number): number | undefined {
  if (value === undefined) return fallback
  return typeof value === "number" && Number.isInteger(value) && value >= low && value <= high ? value : undefined
}

const defaultSleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(signal.reason)
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", abort)
    resolve()
  }, ms)
  const abort = () => {
    clearTimeout(timer)
    reject(signal.reason)
  }
  signal.addEventListener("abort", abort, { once: true })
})

/**
 * One Web API call for a read, waiting out Slack's rate limit: when Slack answers `ratelimited` with a `Retry-After`
 * of at most 30 seconds, it waits that long and tries again, at most twice. Any other failure is thrown as the
 * plugin's error for `name` (see `failure`).
 */
export async function readCall(
  options: ReadOptions,
  name: string,
  method: SlackApiMethod,
  params: Readonly<Record<string, string>>,
  signal: AbortSignal,
): Promise<Readonly<Record<string, unknown>>> {
  return (await readCallUnless(options, name, method, params, signal, []))!
}

/** `readCall`, except that Slack's refusal with one of the `skipped` codes is undefined rather than an error. */
export async function readCallUnless(
  options: ReadOptions,
  name: string,
  method: SlackApiMethod,
  params: Readonly<Record<string, string>>,
  signal: AbortSignal,
  skipped: readonly string[],
): Promise<Readonly<Record<string, unknown>> | undefined> {
  for (let tries = 0; ; tries += 1) {
    const result = await options.api.call(method, params, signal)
    if (result.ok) return result.body
    if (skipped.includes(result.error)) return undefined
    const wait = result.error === "ratelimited" ? result.retryAfter : undefined
    if (wait !== undefined && wait <= MAX_RETRY_AFTER_S && tries < RATE_RETRIES) {
      await (options.sleep ?? defaultSleep)(wait * 1000, signal)
      continue
    }
    throw await failure(options, name, method, result)
  }
}

/** The plugin's error for a failed Web API call of a read: status's code without a sign-in, a missing scope, or Slack's code. */
export async function failure(options: ReadOptions, name: string, method: string, result: Extract<SlackApiResult, { ok: false }>): Promise<Error> {
  if (result.error === NOT_SIGNED_IN) return notSignedIn(options, name)
  if (result.error === "missing_scope") {
    const needed = result.needed ?? "the scope Slack names"
    return eventsError(
      "SCOPE_MISSING",
      `Slack refused ${method}: the Slack sign-in lacks the scope ${needed}.`,
      `Add ${needed} to the Slack app's user scopes and to the plugin's oauth.scopes, then sign in to Slack again.`,
    )
  }
  return eventsError("UPSTREAM_ERROR", `Slack's ${method} failed for ${name}: ${result.error}.`, `Call ${name} again in a minute, and run /slack-status if it keeps failing.`)
}

/** Status's code and next step while Slack cannot be reached, or `AUTH_REQUIRED`. */
export async function notSignedIn(options: ReadOptions, name: string): Promise<Error> {
  const current = await options.status().catch(() => undefined)
  if (current?.code !== undefined && current.state !== "connected") {
    return eventsError(current.code, `${current.message.replace(/[.\s]+$/, "")}; ${name} cannot read Slack.`, current.nextStep)
  }
  return eventsError("AUTH_REQUIRED", `OpenCode has no Slack sign-in that ${name} can use.`, "Run /connect and choose Slack, then press o or Enter to open the sign-in page.")
}

/** The signed-in account, or the plugin's error when Slack does not say who it is. */
export async function signedIn(options: ReadOptions, name: string): Promise<Identity> {
  const identity = await options.identity().catch(() => undefined)
  if (identity !== undefined) return identity
  if ((await options.api.credential().catch(() => undefined)) === undefined) throw await notSignedIn(options, name)
  throw eventsError("UPSTREAM_ERROR", `Slack did not say which account is signed in, so ${name} cannot read for it.`, `Call ${name} again in a minute, and run /slack-status if it keeps failing.`)
}

type Context = Parameters<Awaited<ReturnType<Plugin.Context["tool"]["list"]>>[number]["execute"]>[1]

export interface ReadSpec<T> {
  readonly name: string
  readonly description: string
  readonly input: JsonSchema
  readonly output: JsonSchema
  readonly run: (options: ReadOptions, input: unknown, signal: AbortSignal) => Promise<T>
  /** The tool's text for the model. */
  readonly content: (output: T) => string
}

/** The read as a Code Mode tool in the `slack` namespace: it asserts its own action, `slack_<name>`, then reads. */
export function readTool<T>(spec: ReadSpec<T>, options: ReadOptions) {
  const action = `${SERVER}_${spec.name}`
  return {
    name: spec.name,
    description: spec.description,
    input: spec.input,
    output: spec.output,
    options: { namespace: SERVER },
    execute: async (input: unknown, context: Context) => {
      // Rethrown untouched: the host turns a refusal into the end of the step, and the tools RPC into PERMISSION_DENIED.
      await options.permission.assert({
        sessionID: context.sessionID,
        agent: context.agent,
        action,
        resources: ["*"],
        source: { type: "tool", messageID: context.messageID, id: context.id },
      })
      const output = await spec.run(options, input, context.signal)
      return { output, content: spec.content(output) }
    },
  }
}

/** The read as a tools RPC method of class `read`: it runs the tool's own spec as the envelope's session and agent. */
export function readMethod<T>(spec: ReadSpec<T>, options: ReadOptions): OwnedMethod {
  const tool = readTool(spec, options)
  return {
    kind: "plugin",
    class: "read",
    name: spec.name,
    action: `${SERVER}_${spec.name}`,
    description: spec.description,
    input: spec.input,
    output: spec.output,
    run: async (input, call) => (await tool.execute(input, call as unknown as Context)).output,
    // For describe: status's code while Slack cannot be reached, such as CLIENT_ID_MISSING or AUTH_REQUIRED.
    available: async () => {
      const current = await options.status().catch(() => undefined)
      if (current === undefined || current.state === "connected") return undefined
      return current.code ?? current.state.toUpperCase()
    },
  }
}
