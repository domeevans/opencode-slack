import type { Plugin } from "@opencode/plugin"
import { SERVER } from "./defaults.js"
import type { Options } from "./options.js"

type Context = Plugin.Context
type Registration = Awaited<ReturnType<Context["integration"]["transform"]>>

/** The Slack app OpenCode signs in with. `secret` is set only for an app without PKCE. */
export interface Client {
  readonly id: string
  readonly secret?: string
  readonly source: "options" | "connect"
}

/** The client in use. Without one, `invalid` tells whether a stored entry was unusable or nothing is stored. */
export interface ClientState {
  readonly client?: Client
  readonly invalid: boolean
}

const NO_SPACES = /^\S+$/

/** The `/connect` entry that stores a Slack app's client ID. */
const APP_INTEGRATION_ID = "slack-app"
/** The name `/connect` shows for the entry that stores the client ID. */
export const APP_NAME = "Slack app"
/** The name `/connect` shows for the Slack MCP server's own integration. */
export const SERVER_DISPLAY_NAME = "Slack"

/**
 * Adds "Slack app" to `/connect`: a key method whose key is the client ID, because OpenCode asks for a non-empty
 * key. The optional secret is a form field, for apps without PKCE. Both are kept in OpenCode's credential store.
 */
export function registerAppIntegration(integration: Pick<Context["integration"], "transform">) {
  return integration.transform((editor) => {
    editor.update(APP_INTEGRATION_ID, (draft) => {
      draft.name = APP_NAME
    })
    editor.method.update({
      integrationID: APP_INTEGRATION_ID,
      method: {
        type: "key",
        label: "Slack app client ID",
        form: [{
          key: "client_secret",
          type: "string",
          title: "Client secret",
          description: "Only for a Slack app without PKCE. Skip it for an app made from the plugin's manifest.",
          required: false,
        }],
      },
    })
  })
}

/** Options first, then the client stored through `/connect`. No client ships with the plugin. */
export async function resolveClient(integration: { readonly connection: Pick<Context["integration"]["connection"], "active" | "resolve" | "status"> }, options: Options): Promise<ClientState> {
  if (options.clientId !== undefined) {
    return { client: { id: options.clientId, ...(options.clientSecret === undefined ? {} : { secret: options.clientSecret }), source: "options" }, invalid: false }
  }
  const integrationID = APP_INTEGRATION_ID
  const connection = await integration.connection.active(integrationID)
  const stored = connection === undefined ? undefined : await integration.connection.resolve(connection)
  if (connection !== undefined && stored?.type === "key") {
    const id = stored.key.trim()
    const valid = NO_SPACES.test(id)
    // `/connect` then shows the saved entry as needing a new sign-in.
    await integration.connection.status({
      integrationID,
      connection,
      status: valid ? undefined : { status: "needs_auth", message: "This is not a Slack client ID: it is empty or has spaces." },
    }).catch(() => undefined)
    if (!valid) return { invalid: true }
    const secret = typeof stored.metadata?.client_secret === "string" ? stored.metadata.client_secret.trim() : ""
    return { client: { id, ...(secret === "" ? {} : { secret }), source: "connect" }, invalid: false }
  }
  return { invalid: false }
}

export const sameClient = (a: ClientState, b: ClientState) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Names the Slack MCP server's integration in `/connect`. OpenCode registers that integration after plugin setup,
 * and again on every MCP reload, naming it after the server; so the rename is registered again whenever the name
 * has reverted, to run after OpenCode's own transform.
 */
export function serverNamer(ctx: Pick<Context, "mcp" | "integration">, owned: () => boolean) {
  let registration: Registration | undefined
  return {
    /** True once the integration carries the display name. */
    async apply(): Promise<boolean> {
      if (!owned()) return false
      const id = (await ctx.mcp.list()).data.find((item) => item.name === SERVER)?.integrationID
      if (id === undefined) return false
      const name = SERVER_DISPLAY_NAME
      if ((await ctx.integration.get({ integrationID: id })).data.name === name) return true
      const previous = registration
      registration = await ctx.integration.transform((editor) => {
        if (editor.get(id) !== undefined) editor.update(id, (draft) => void (draft.name = name))
      })
      await previous?.dispose()
      return false
    },
    async dispose() {
      await registration?.dispose()
      registration = undefined
    },
  }
}
