import { CALLBACK_PORT_EXAMPLE, DEFAULT_REDIRECT_URI, DEFAULT_SCOPES, HOSTED_REDIRECT_EXAMPLE } from "./defaults.js"

/** What the default rules allow. `all` is the default; the other two are how a user restricts the plugin. */
export type Access = "all" | "ask-changes" | "read-only"

export const ACCESS_VALUES: readonly Access[] = ["all", "ask-changes", "read-only"]

export interface Options {
  /** Pins the Slack app, for example in an organisation's managed config. Otherwise the /connect Slack app client ID entry sets it. */
  readonly clientId?: string
  readonly redirectUri: string
  /** The local port OpenCode's callback listener uses. Set only, and always, with an `https:` redirect. */
  readonly callbackPort?: number
  readonly scopes: readonly string[]
  readonly clientSecret?: string
  readonly allowUntestedHost: boolean
  /** What the generated default rules allow: everything, changes ask, or read-only. */
  readonly access: Access
}

/** A rejected option. Messages name the field and never echo its value. */
export interface OptionsError {
  readonly code: "OPTIONS_INVALID"
  readonly field: string
  readonly message: string
  readonly next: string
}

export type ParsedOptions =
  | { readonly ok: true; readonly options: Options }
  | { readonly ok: false; readonly error: OptionsError }

const TOP_KEYS = ["oauth", "allowUntestedHost", "access"]
const OAUTH_KEYS = ["client_id", "redirect_uri", "callback_port", "scopes", "client_secret"]
const NO_SPACES = /^\S+$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const fail = (field: string, message: string, next: string): ParsedOptions =>
  ({ ok: false, error: { code: "OPTIONS_INVALID", field, message, next } })

/**
 * A loopback `http:` redirect, where OpenCode listens on the URL's own port, or an `https:` one that a proxy
 * forwards to OpenCode's listener on `oauth.callback_port`. Both need a path, which the listener matches.
 */
function redirectProblem(value: string): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return "Must be a valid URL."
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Must use http: or https:."
  if (url.protocol === "http:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    return "An http: URL must use the host localhost or 127.0.0.1."
  }
  if (url.protocol === "http:" && url.port === "") return "An http: URL must include an explicit port."
  if (url.username !== "" || url.password !== "") return "Must not include credentials."
  if (value.includes("?") || value.includes("#")) return "Must not include a query or fragment."
  if (url.pathname === "/") return "Must include a path, such as /callback."
  return undefined
}

const isPort = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535

export function parseOptions(input: unknown): ParsedOptions {
  const raw = input ?? {}
  if (!isRecord(raw)) return fail("options", "Plugin options must be an object.", "Set options to an object, or remove them.")
  const unknownKey = Object.keys(raw).find((key) => !TOP_KEYS.includes(key))
  if (unknownKey !== undefined) {
    return fail(unknownKey, "This option is not supported.", `Remove it. Supported options: ${TOP_KEYS.join(", ")}.`)
  }

  const oauth = raw.oauth ?? {}
  if (!isRecord(oauth)) return fail("oauth", "Must be an object.", "Set oauth to an object such as { \"client_id\": \"...\" }.")
  const unknownOAuthKey = Object.keys(oauth).find((key) => !OAUTH_KEYS.includes(key))
  if (unknownOAuthKey !== undefined) {
    return fail(`oauth.${unknownOAuthKey}`, "This option is not supported.", `Remove it. Supported oauth options: ${OAUTH_KEYS.join(", ")}.`)
  }

  const clientId = oauth.client_id
  if (clientId !== undefined && (typeof clientId !== "string" || !NO_SPACES.test(clientId))) {
    return fail("oauth.client_id", "Must be a non-empty string without spaces.", "Copy the client ID from the Basic Information page of your Slack app.")
  }

  const redirectUri = oauth.redirect_uri ?? DEFAULT_REDIRECT_URI
  const redirectError = typeof redirectUri === "string" ? redirectProblem(redirectUri) : "Must be a string."
  if (typeof redirectUri !== "string" || redirectError !== undefined) {
    return fail("oauth.redirect_uri", redirectError ?? "Must be a string.", `Use a URL listed in the app's Redirect URLs, for example ${DEFAULT_REDIRECT_URI} or ${HOSTED_REDIRECT_EXAMPLE}.`)
  }

  const hosted = new URL(redirectUri).protocol === "https:"
  const callbackPort = oauth.callback_port
  if (callbackPort !== undefined && !isPort(callbackPort)) {
    return fail("oauth.callback_port", "Must be a whole number from 1 to 65535.", `Set it to the local port that receives the forwarded callback, for example ${CALLBACK_PORT_EXAMPLE}.`)
  }
  if (callbackPort !== undefined && !hosted) {
    return fail("oauth.callback_port", "Applies only to an https: oauth.redirect_uri.", "Remove it: with a loopback oauth.redirect_uri, OpenCode listens on that URL's port.")
  }
  if (callbackPort === undefined && hosted) {
    return fail("oauth.callback_port", "Must be set with an https: oauth.redirect_uri.", `Set it to the local port your proxy forwards the redirect to, for example ${CALLBACK_PORT_EXAMPLE}.`)
  }

  const scopes: unknown = oauth.scopes ?? DEFAULT_SCOPES
  const isScope = (scope: unknown): scope is string => typeof scope === "string" && NO_SPACES.test(scope)
  if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every(isScope)) {
    return fail("oauth.scopes", "Must be a non-empty list of scope names without spaces.", `List Slack user scopes, for example ${JSON.stringify(DEFAULT_SCOPES)}.`)
  }
  if (new Set(scopes).size !== scopes.length) return fail("oauth.scopes", "Lists a scope more than once.", "Remove the duplicate scope.")

  const clientSecret = oauth.client_secret
  if (clientSecret !== undefined && (typeof clientSecret !== "string" || clientSecret === "")) {
    return fail("oauth.client_secret", "Must be a non-empty string.", "Set it to {env:SLACK_CLIENT_SECRET} and export that variable, or remove it to use PKCE.")
  }
  if (clientSecret !== undefined && clientId === undefined) {
    return fail("oauth.client_secret", "Needs oauth.client_id.", "Set oauth.client_id to your Slack app's client ID, or remove oauth.client_secret.")
  }

  const allowUntestedHost = raw.allowUntestedHost ?? false
  if (typeof allowUntestedHost !== "boolean") {
    return fail("allowUntestedHost", "Must be true or false.", "Set it to true only to run on an OpenCode version outside the supported range.")
  }

  const access = raw.access ?? "all"
  if (typeof access !== "string" || !(ACCESS_VALUES as readonly string[]).includes(access)) {
    return fail("access", 'Must be "all", "ask-changes" or "read-only".', 'Set access to "all" (the default), "ask-changes" or "read-only".')
  }

  return {
    ok: true,
    options: {
      ...(clientId === undefined ? {} : { clientId }),
      redirectUri,
      ...(callbackPort === undefined ? {} : { callbackPort }),
      scopes: [...scopes],
      ...(clientSecret === undefined ? {} : { clientSecret }),
      allowUntestedHost,
      access: access as Access,
    },
  }
}
