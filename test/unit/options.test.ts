import { describe, expect, test } from "bun:test"
import { CALLBACK_PORT_EXAMPLE, DEFAULT_REDIRECT_URI, DEFAULT_SCOPES, HOSTED_REDIRECT_EXAMPLE } from "../../src/defaults.js"
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
        allowUntestedHost: false,
      },
    })
  })

  test.each([undefined, null, {}, { oauth: {} }])("%p without a client ID is valid and leaves the client to /connect", (input) => {
    expect(parseOptions(input)).toEqual({
      ok: true,
      options: { redirectUri: DEFAULT_REDIRECT_URI, scopes: [...DEFAULT_SCOPES], allowUntestedHost: false },
    })
  })

  test("every field can be set", () => {
    const parsed = parseOptions({
      oauth: { client_id: CLIENT, redirect_uri: "http://127.0.0.1:9000/slack/cb", scopes: ["search:read.public"], client_secret: "s" },
      allowUntestedHost: true,
    })
    expect(parsed).toEqual({
      ok: true,
      options: {
        clientId: CLIENT,
        redirectUri: "http://127.0.0.1:9000/slack/cb",
        scopes: ["search:read.public"],
        clientSecret: "s",
          allowUntestedHost: true,
      },
    })
  })

  test("an https redirect with a callback port is kept with both", () => {
    expect(parseOptions(withOAuth({ redirect_uri: "https://host.example/oauth/return", callback_port: 49200 }))).toEqual({
      ok: true,
      options: {
        clientId: CLIENT,
        redirectUri: "https://host.example/oauth/return",
        callbackPort: 49200,
        scopes: [...DEFAULT_SCOPES],
        allowUntestedHost: false,
      },
    })
  })

  test.each([
    "https://host.example:8443/slack/callback",
    "https://opencode.internal.example/oauth/return/slack",
    "https://localhost/callback",
    "HTTPS://Host.Example/oauth/return",
  ])("accepts the https redirect %s with a callback port", (redirect_uri) => {
    expect(parseOptions(withOAuth({ redirect_uri, callback_port: 1 }))).toMatchObject({ ok: true, options: { redirectUri: redirect_uri, callbackPort: 1 } })
  })

  test.each(["http://localhost:8765/callback", "http://127.0.0.1:1/cb", "http://localhost:65535/a/b"])("a loopback redirect %s has no callback port", (redirect_uri) => {
    const parsed = parseOptions(withOAuth({ redirect_uri }))
    if (!parsed.ok) throw new Error(parsed.error.message)
    expect(parsed.options.redirectUri).toBe(redirect_uri)
    expect(Object.hasOwn(parsed.options, "callbackPort")).toBe(false)
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
      code: "OPTIONS_INVALID", field: "policy", message: "This option is not supported.", next: "Remove it. Supported options: oauth, allowUntestedHost.",
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
      next: "Remove it. Supported oauth options: client_id, redirect_uri, callback_port, scopes, client_secret.",
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
    ["another scheme", "localhost:8765/callback", "Must use http: or https:."],
    ["ftp", "ftp://host.example/callback", "Must use http: or https:."],
    ["an http remote host", "http://example.com:8765/callback", "An http: URL must use the host localhost or 127.0.0.1."],
    ["http IPv6 loopback", "http://[::1]:8765/callback", "An http: URL must use the host localhost or 127.0.0.1."],
    ["http without a port", "http://localhost/callback", "An http: URL must include an explicit port."],
    ["http credentials", "http://user:pass@localhost:8765/callback", "Must not include credentials."],
    ["https credentials", "https://user:pass@host.example/oauth/return", "Must not include credentials."],
    ["an https user name", "https://user@host.example/oauth/return", "Must not include credentials."],
    ["an http query", "http://localhost:8765/callback?x=1", "Must not include a query or fragment."],
    ["an https query", "https://host.example/oauth/return?x=1", "Must not include a query or fragment."],
    ["an empty query", "http://localhost:8765/callback?", "Must not include a query or fragment."],
    ["an http fragment", "http://localhost:8765/callback#top", "Must not include a query or fragment."],
    ["an https fragment", "https://host.example/oauth/return#top", "Must not include a query or fragment."],
    ["no http path", "http://localhost:8765", "Must include a path, such as /callback."],
    ["a root http path", "http://localhost:8765/", "Must include a path, such as /callback."],
    ["no https path", "https://host.example", "Must include a path, such as /callback."],
    ["a root https path", "https://host.example/", "Must include a path, such as /callback."],
    ["not a string", 8765, "Must be a string."],
  ])("a redirect_uri with %s", (_label, redirect_uri, message) => {
    expect(rejected(withOAuth({ redirect_uri, callback_port: 8766 }))).toEqual({
      code: "OPTIONS_INVALID",
      field: "oauth.redirect_uri",
      message,
      next: `Use a URL listed in the app's Redirect URLs, for example ${DEFAULT_REDIRECT_URI} or ${HOSTED_REDIRECT_EXAMPLE}.`,
    })
  })

  test.each([["zero", 0], ["too high", 65536], ["negative", -1], ["fractional", 8765.5], ["a string", "8765"], ["null", null], ["a list", [8765]]])(
    "a callback_port that is %s",
    (_label, callback_port) => {
      expect(rejected(withOAuth({ redirect_uri: "https://host.example/oauth/return", callback_port }))).toEqual({
        code: "OPTIONS_INVALID",
        field: "oauth.callback_port",
        message: "Must be a whole number from 1 to 65535.",
        next: `Set it to the local port that receives the forwarded callback, for example ${CALLBACK_PORT_EXAMPLE}.`,
      })
    },
  )

  test.each([["the default redirect", {}], ["a loopback redirect", { redirect_uri: "http://127.0.0.1:9000/cb" }], ["the same port", { redirect_uri: "http://localhost:8765/callback" }]])(
    "a callback_port with %s",
    (_label, oauth) => {
      expect(rejected(withOAuth({ ...oauth, callback_port: 8765 }))).toEqual({
        code: "OPTIONS_INVALID",
        field: "oauth.callback_port",
        message: "Applies only to an https: oauth.redirect_uri.",
        next: "Remove it: with a loopback oauth.redirect_uri, OpenCode listens on that URL's port.",
      })
    },
  )

  test("an https redirect without a callback_port", () => {
    expect(rejected(withOAuth({ redirect_uri: "https://host.example/oauth/return" }))).toEqual({
      code: "OPTIONS_INVALID",
      field: "oauth.callback_port",
      message: "Must be set with an https: oauth.redirect_uri.",
      next: `Set it to the local port your proxy forwards the redirect to, for example ${CALLBACK_PORT_EXAMPLE}.`,
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

  test("server is not an option: the server is always named slack", () => {
    expect(rejected(withOAuth({}, { server: "work" }))).toEqual({
      code: "OPTIONS_INVALID", field: "server", message: "This option is not supported.", next: "Remove it. Supported options: oauth, allowUntestedHost.",
    })
  })

  test.each([["a string", "true"], ["a number", 1]])("allowUntestedHost that is %s", (_label, allowUntestedHost) => {
    expect(rejected(withOAuth({}, { allowUntestedHost }))).toEqual({
      code: "OPTIONS_INVALID",
      field: "allowUntestedHost",
      message: "Must be true or false.",
      next: "Set it to true only to run on an OpenCode version outside the supported range.",
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
    ["an https redirect query", withOAuth({ redirect_uri: `https://host.example/cb?${MARKER}`, callback_port: 1 })],
    ["https redirect credentials", withOAuth({ redirect_uri: `https://${MARKER}:${MARKER}@host.example/cb`, callback_port: 1 })],
    ["a bad callback port", withOAuth({ redirect_uri: "https://host.example/cb", callback_port: MARKER })],
    ["a duplicated scope", withOAuth({ scopes: [MARKER, MARKER] })],
    ["a spaced scope", withOAuth({ scopes: [`${MARKER} x`] })],
    ["a non-string secret", withOAuth({ client_secret: [MARKER] })],
    ["a server name", withOAuth({}, { server: MARKER })],
    ["a bad override", withOAuth({}, { allowUntestedHost: MARKER })],
  ])("%s", (_label, input) => {
    expect(JSON.stringify(rejected(input))).not.toContain(MARKER)
  })
})
