import { describe, expect, test } from "bun:test"
import { DEFAULT_REDIRECT_URI, DEFAULT_SCOPES } from "../../src/defaults.js"
import { parseOptions, type OptionsError } from "../../src/options.js"

const CLIENT = "1234567890.0987654321"

function rejected(input: unknown): OptionsError {
  const parsed = parseOptions(input)
  if (parsed.ok) throw new Error(`expected ${JSON.stringify(input)} to be rejected`)
  return parsed.error
}

const withOAuth = (oauth: Record<string, unknown>, rest: Record<string, unknown> = {}) => ({ oauth: { client_id: CLIENT, ...oauth }, ...rest })

describe("parseOptions defaults", () => {
  test("a client ID alone gives the organisation defaults", () => {
    expect(parseOptions({ oauth: { client_id: CLIENT } })).toEqual({
      ok: true,
      options: {
        clientId: CLIENT,
        redirectUri: "http://localhost:8765/callback",
        scopes: ["channels:history", "channels:read", "search:read.public", "users:read"],
        server: "slack",
        allowUntestedHost: false,
      },
    })
  })

  test.each([undefined, null, {}, { oauth: {} }])("%p without a client ID is valid and leaves the client to /connect", (input) => {
    expect(parseOptions(input)).toEqual({
      ok: true,
      options: { redirectUri: DEFAULT_REDIRECT_URI, scopes: [...DEFAULT_SCOPES], server: "slack", allowUntestedHost: false },
    })
  })

  test("every field can be set", () => {
    const parsed = parseOptions({
      oauth: { client_id: CLIENT, redirect_uri: "http://127.0.0.1:9000/slack/cb", scopes: ["search:read.public"], client_secret: "s" },
      server: "work-slack_2",
      allowUntestedHost: true,
    })
    expect(parsed).toEqual({
      ok: true,
      options: {
        clientId: CLIENT,
        redirectUri: "http://127.0.0.1:9000/slack/cb",
        scopes: ["search:read.public"],
        clientSecret: "s",
        server: "work-slack_2",
        allowUntestedHost: true,
      },
    })
  })

  test("returns a copy of the scopes, never the caller's or the default array", () => {
    const scopes = ["channels:read"]
    const parsed = parseOptions(withOAuth({ scopes }))
    const defaults = parseOptions(withOAuth({}))
    if (!parsed.ok || !defaults.ok) throw new Error("expected valid options")
    expect(parsed.options.scopes).not.toBe(scopes)
    expect(defaults.options.scopes).not.toBe(DEFAULT_SCOPES)
  })
})

describe("parseOptions rejects", () => {
  test.each([["a list", []], ["a string", "slack"], ["a number", 3]])("options that are %s", (_label, input) => {
    expect(rejected(input)).toEqual({
      code: "OPTIONS_INVALID", field: "options", message: "Plugin options must be an object.", next: "Set options to an object, or remove them.",
    })
  })

  test("unknown top-level keys, naming the supported ones", () => {
    expect(rejected({ ...withOAuth({}), policy: { allow: ["write"] } })).toEqual({
      code: "OPTIONS_INVALID", field: "policy", message: "This option is not supported.", next: "Remove it. Supported options: oauth, server, allowUntestedHost.",
    })
  })

  test.each([["a list", []], ["a string", "id"]])("oauth that is %s", (_label, oauth) => {
    expect(rejected({ oauth })).toMatchObject({ field: "oauth", message: "Must be an object." })
  })

  test("redirect_port, pointing to oauth.redirect_uri instead of accepting it as an alias", () => {
    expect(rejected(withOAuth({ redirect_port: 8765 }))).toEqual({
      code: "OPTIONS_INVALID",
      field: "oauth.redirect_port",
      message: "This option is not supported.",
      next: `Use oauth.redirect_uri instead, for example ${DEFAULT_REDIRECT_URI}.`,
    })
  })

  test("other unknown oauth keys, naming the supported ones", () => {
    expect(rejected(withOAuth({ clientId: "x" }))).toEqual({
      code: "OPTIONS_INVALID",
      field: "oauth.clientId",
      message: "This option is not supported.",
      next: "Remove it. Supported oauth options: client_id, redirect_uri, scopes, client_secret.",
    })
  })

  test.each([["empty", ""], ["spaced", "123 456"], ["a number", 123], ["a list", [CLIENT]]])("a client_id that is %s", (_label, client_id) => {
    expect(rejected({ oauth: { client_id } })).toEqual({
      code: "OPTIONS_INVALID",
      field: "oauth.client_id",
      message: "Must be a non-empty string without spaces.",
      next: "Copy the client ID from the Basic Information page of your Slack app.",
    })
  })

  test.each([
    ["not a URL", "/callback", "Must be a valid URL."],
    ["another scheme", "localhost:8765/callback", "Must use http:."],
    ["https", "https://localhost:8765/callback", "Must use http:."],
    ["a remote host", "http://example.com:8765/callback", "Must use the host localhost or 127.0.0.1."],
    ["IPv6 loopback", "http://[::1]:8765/callback", "Must use the host localhost or 127.0.0.1."],
    ["no port", "http://localhost/callback", "Must include an explicit port."],
    ["credentials", "http://user:pass@localhost:8765/callback", "Must not include credentials."],
    ["a query", "http://localhost:8765/callback?x=1", "Must not include a query or fragment."],
    ["an empty query", "http://localhost:8765/callback?", "Must not include a query or fragment."],
    ["a fragment", "http://localhost:8765/callback#top", "Must not include a query or fragment."],
    ["no path", "http://localhost:8765", "Must include a path, such as /callback."],
    ["a root path", "http://localhost:8765/", "Must include a path, such as /callback."],
    ["not a string", 8765, "Must be a string."],
  ])("a redirect_uri with %s", (_label, redirect_uri, message) => {
    expect(rejected(withOAuth({ redirect_uri }))).toEqual({
      code: "OPTIONS_INVALID",
      field: "oauth.redirect_uri",
      message,
      next: `Use the loopback URL registered in your Slack app, for example ${DEFAULT_REDIRECT_URI}.`,
    })
  })

  test.each([
    ["not a list", "channels:read"],
    ["empty", []],
    ["a non-string entry", ["channels:read", 7]],
    ["an empty entry", [""]],
    ["a spaced entry", ["channels:read users:read"]],
  ])("scopes that are %s", (_label, scopes) => {
    expect(rejected(withOAuth({ scopes }))).toEqual({
      code: "OPTIONS_INVALID",
      field: "oauth.scopes",
      message: "Must be a non-empty list of scope names without spaces.",
      next: `List Slack user scopes, for example ${JSON.stringify(DEFAULT_SCOPES)}.`,
    })
  })

  test("duplicate scopes", () => {
    expect(rejected(withOAuth({ scopes: ["users:read", "users:read"] }))).toEqual({
      code: "OPTIONS_INVALID", field: "oauth.scopes", message: "Lists a scope more than once.", next: "Remove the duplicate scope.",
    })
  })

  test.each([["empty", ""], ["a number", 42], ["null", null]])("a client_secret that is %s", (_label, client_secret) => {
    expect(rejected(withOAuth({ client_secret }))).toEqual({
      code: "OPTIONS_INVALID",
      field: "oauth.client_secret",
      message: "Must be a non-empty string.",
      next: "Set it to {env:SLACK_CLIENT_SECRET} and export that variable, or remove it to use PKCE.",
    })
  })

  test("a client_secret without a client_id", () => {
    expect(rejected({ oauth: { client_secret: "s" } })).toEqual({
      code: "OPTIONS_INVALID",
      field: "oauth.client_secret",
      message: "Needs oauth.client_id.",
      next: "Set oauth.client_id to your Slack app's client ID, or remove oauth.client_secret.",
    })
  })

  test.each([["a dot", "slack.work"], ["a space", "my slack"], ["empty", ""], ["a number", 1]])("a server name with %s", (_label, server) => {
    expect(rejected(withOAuth({}, { server }))).toEqual({
      code: "OPTIONS_INVALID", field: "server", message: "Must contain only letters, digits, _ and -.", next: 'Use a name such as "slack".',
    })
  })

  test.each([["a string", "true"], ["a number", 1]])("allowUntestedHost that is %s", (_label, allowUntestedHost) => {
    expect(rejected(withOAuth({}, { allowUntestedHost }))).toEqual({
      code: "OPTIONS_INVALID",
      field: "allowUntestedHost",
      message: "Must be true or false.",
      next: "Set it to true only to run on an OpenCode version this plugin is not tested with.",
    })
  })
})

describe("the {env:} example for client_secret", () => {
  // OpenCode replaces {env:NAME} across the whole config text before plugin options reach the plugin, and an unset
  // variable becomes an empty string.
  const substitute = (text: string, env: Record<string, string>) => text.replace(/\{env:([^}]+)\}/g, (_match, name: string) => env[name] ?? "")
  const docs = `{ "oauth": { "client_id": "${CLIENT}", "client_secret": "{env:SLACK_CLIENT_SECRET}" } }`

  test("a set variable makes a confidential client", () => {
    const parsed = parseOptions(JSON.parse(substitute(docs, { SLACK_CLIENT_SECRET: "from-the-environment" })))
    expect(parsed).toMatchObject({ ok: true, options: { clientSecret: "from-the-environment" } })
  })

  test("an unset variable is reported, not sent to Slack as an empty secret", () => {
    expect(rejected(JSON.parse(substitute(docs, {})))).toMatchObject({ field: "oauth.client_secret", message: "Must be a non-empty string." })
  })
})

describe("errors never echo values", () => {
  const MARKER = "zz-do-not-echo-91f3"
  test.each([
    ["an unknown oauth value", withOAuth({ token: MARKER })],
    ["a spaced client ID", { oauth: { client_id: `${MARKER} x` } }],
    ["a remote redirect", withOAuth({ redirect_uri: `http://${MARKER}.example:1/cb` })],
    ["a redirect query", withOAuth({ redirect_uri: `http://localhost:1/cb?${MARKER}` })],
    ["a duplicated scope", withOAuth({ scopes: [MARKER, MARKER] })],
    ["a spaced scope", withOAuth({ scopes: [`${MARKER} x`] })],
    ["a non-string secret", withOAuth({ client_secret: [MARKER] })],
    ["a bad server name", withOAuth({}, { server: `${MARKER}.x` })],
    ["a bad override", withOAuth({}, { allowUntestedHost: MARKER })],
  ])("%s", (_label, input) => {
    expect(JSON.stringify(rejected(input))).not.toContain(MARKER)
  })
})
