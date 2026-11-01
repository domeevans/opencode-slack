import type { Plugin } from "@opencode/plugin"
import { SLACK_MCP_URL } from "./defaults.js"
import type { Client } from "./connect.js"
import type { Options } from "./options.js"

type McpEditor = Parameters<Parameters<Plugin.Context["mcp"]["transform"]>[0]>[0]
type ServerConfig = Parameters<McpEditor["set"]>[1]

/**
 * Slack's hosted MCP server with the Slack app's OAuth client. `redirect_uri` is always explicit: without it
 * OpenCode uses `http://127.0.0.1:<port>/callback`, which does not match an app registered with `localhost`.
 * Protocol, timeouts, headers and Code Mode keep the host defaults.
 */
export function serverConfig(options: Options, client: Client): ServerConfig {
  return {
    type: "remote",
    url: SLACK_MCP_URL,
    oauth: {
      client_id: client.id,
      redirect_uri: options.redirectUri,
      scope: options.scopes.join(" "),
      ...(client.secret === undefined ? {} : { client_secret: client.secret }),
    },
  }
}

/**
 * Registers the server when there is a client. Returns false, and changes nothing, when the name is already
 * taken, for example by the user's own config.
 */
export function registerServer(editor: McpEditor, options: Options, client: Client | undefined): boolean {
  if (editor.get(options.server) !== undefined) return false
  if (client !== undefined) editor.set(options.server, serverConfig(options, client))
  return true
}
