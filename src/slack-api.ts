import type { Plugin } from "@opencode/plugin"
import { SERVER } from "./defaults.js"

/**
 * The plugin's one Slack Web API client, and the only code in the plugin that reads a Slack token.
 *
 * It resolves the `slack` MCP server's active sign-in through OpenCode's connection API (`ctx.integration.connection`,
 * which refreshes a token near its expiry), and sends one request for one of `SLACK_API_METHODS` to
 * `https://slack.com/api/<method>` with the token in the `Authorization` header. The token is never returned, stored,
 * cached, logged or put in an error: an answer keeps no string that looks like a Slack token, and a failure is only
 * Slack's error code (and, for `missing_scope`, the scope Slack names), or `not_signed_in` / `request_failed`.
 */

export const SLACK_API_URL = "https://slack.com/api/"

/** The only Web API methods the plugin calls: who signed in (status), and marking a conversation read (`mark_read`). */
export const SLACK_API_METHODS = ["auth.test", "conversations.mark"] as const
export type SlackApiMethod = (typeof SLACK_API_METHODS)[number]

/** No usable Slack sign-in: no server of the plugin's, no active connection, or no OAuth token in it. */
export const NOT_SIGNED_IN = "not_signed_in"
/** No answer Slack's way: a network failure, a timeout, or an answer that is not Slack's JSON. */
export const REQUEST_FAILED = "request_failed"

const TIMEOUT_MS = 10_000
/** Slack's error codes are lower snake case, such as `missing_scope` or `channel_not_found`. */
const SLACK_CODE = /^[a-z][a-z0-9_]{0,63}$/
/** The scope or scopes Slack's `missing_scope` names in `needed`, such as `im:write`. */
const NEEDED = /^[a-z][a-z0-9:._-]{0,63}(?:,[a-z][a-z0-9:._-]{0,63}){0,9}$/
/** A Slack token of any kind, which an answer never carries back to a caller. */
const TOKEN_LIKE = /\bxox[a-z]?[.-]/i

export interface SlackApiSources {
  readonly mcp: Pick<Plugin.Context["mcp"], "list">
  readonly connection: Pick<Plugin.Context["integration"]["connection"], "active" | "resolve">
  /** False while `slack` is a server of the user's, whose sign-in is not the plugin's to use. */
  readonly owned: () => boolean
  /** The HTTP client; tests pass their own. */
  readonly fetch?: typeof globalThis.fetch
}

export type SlackApiResult =
  | { readonly ok: true; readonly credential: string; readonly body: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly error: string; readonly needed?: string }

export interface SlackApi {
  /** The id of the active Slack sign-in's credential, or undefined without one. Reads no token. */
  credential(): Promise<string | undefined>
  /** One request to Slack's Web API, as the signed-in user. */
  call(method: SlackApiMethod, params: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<SlackApiResult>
}

type Connection = NonNullable<Awaited<ReturnType<SlackApiSources["connection"]["active"]>>>

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** A copy of Slack's answer with every string that looks like a token left out. */
function scrub(value: unknown): unknown {
  if (typeof value === "string") return TOKEN_LIKE.test(value) ? undefined : value
  if (Array.isArray(value)) return value.map(scrub).filter((item) => item !== undefined)
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
      const kept = scrub(item)
      return kept === undefined ? [] : [[key, kept]]
    }))
  }
  return value
}

/** Waits for `work`, or for `signal` to abort, whichever comes first. */
function raced<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

export function slackApi(sources: SlackApiSources): SlackApi {
  /** The plugin's own `slack` server's active connection, or undefined. */
  const active = async (): Promise<{ id: string; connection: Connection } | undefined> => {
    if (!sources.owned()) return undefined
    try {
      const server = (await sources.mcp.list()).data.find((item) => item.name === SERVER)
      if (server?.integrationID === undefined) return undefined
      const connection = await sources.connection.active(server.integrationID)
      if (!isRecord(connection) || connection["type"] === "env" || typeof connection["id"] !== "string") return undefined
      return { id: connection["id"], connection }
    } catch {
      return undefined
    }
  }

  return {
    credential: async () => (await active())?.id,

    async call(method, params, signal) {
      const found = await active()
      if (found === undefined) return { ok: false, error: NOT_SIGNED_IN }
      let token: string
      try {
        const credential = await sources.connection.resolve(found.connection)
        if (credential?.type !== "oauth" || typeof credential.access !== "string" || credential.access === "") return { ok: false, error: NOT_SIGNED_IN }
        token = credential.access
      } catch {
        return { ok: false, error: NOT_SIGNED_IN }
      }

      const timeout = AbortSignal.timeout(TIMEOUT_MS)
      const stop = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
      let status: number
      let body: unknown
      try {
        const response = await raced((sources.fetch ?? globalThis.fetch)(`${SLACK_API_URL}${method}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(params).toString(),
          redirect: "error",
          signal: stop,
        }), stop)
        status = response.status
        body = status === 429 ? undefined : await raced(response.json() as Promise<unknown>, stop).catch(() => undefined)
      } catch {
        return { ok: false, error: REQUEST_FAILED }
      }
      if (status === 429) return { ok: false, error: "ratelimited" }
      if (!isRecord(body) || typeof body["ok"] !== "boolean") return { ok: false, error: REQUEST_FAILED }
      if (body["ok"]) return { ok: true, credential: found.id, body: scrub(body) as Record<string, unknown> }
      const error = typeof body["error"] === "string" && SLACK_CODE.test(body["error"]) ? body["error"] : REQUEST_FAILED
      const needed = error === "missing_scope" && typeof body["needed"] === "string" && NEEDED.test(body["needed"]) ? body["needed"] : undefined
      return needed === undefined ? { ok: false, error } : { ok: false, error, needed }
    },
  }
}
