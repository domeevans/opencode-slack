/**
 * Every code this plugin raises, in one typed table: the status codes, and the ones the tools RPC adds. A test fails
 * when a code appears in `src` and in neither table, and when the README's Troubleshooting table or
 * `docs/scripting.md`'s refusal table drifts from them in either direction.
 */

/** The codes the plugin's own code raises, as `CODE: What happened. Next step: What to do.` */
export type PluginCode =
  | "AUTH_REQUIRED"
  | "CLIENT_ID_INVALID"
  | "CLIENT_ID_MISSING"
  | "CONNECTION_FAILED"
  | "HOST_UNTESTED"
  | "OPTIONS_INVALID"
  | "SERVER_DISABLED"
  | "SERVER_NAME_IN_USE"
  | "SKILLS_INVALID"
  | "STATUS_UNAVAILABLE"

export const PLUGIN_CODES: readonly PluginCode[] = [
  "AUTH_REQUIRED",
  "CLIENT_ID_INVALID",
  "CLIENT_ID_MISSING",
  "CONNECTION_FAILED",
  "HOST_UNTESTED",
  "OPTIONS_INVALID",
  "SERVER_DISABLED",
  "SERVER_NAME_IN_USE",
  "SKILLS_INVALID",
  "STATUS_UNAVAILABLE",
]

/**
 * The codes the tools RPC shares with every plugin of this family, from the shared module and from OpenCode rather than
 * from this plugin's own code. `docs/scripting.md` documents them beside the two client-ID codes.
 */
type RpcCode =
  | "AUTH_REQUIRED"
  | "CANCELLED"
  | "CONNECTING"
  | "CONNECTION_FAILED"
  | "DISABLED"
  | "NOT_REGISTERED"
  | "PERMISSION_DENIED"
  | "SERVER_CONFLICT"
  | "SESSION_AGENT_REQUIRED"
  | "SESSION_UNKNOWN"
  | "TOOL_UNAVAILABLE"
  | "UPSTREAM_ERROR"

export const RPC_CODES: readonly RpcCode[] = [
  "AUTH_REQUIRED",
  "CANCELLED",
  "CONNECTING",
  "CONNECTION_FAILED",
  "DISABLED",
  "NOT_REGISTERED",
  "PERMISSION_DENIED",
  "SERVER_CONFLICT",
  "SESSION_AGENT_REQUIRED",
  "SESSION_UNKNOWN",
  "TOOL_UNAVAILABLE",
  "UPSTREAM_ERROR",
]
