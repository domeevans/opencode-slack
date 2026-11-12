/**
 * Every code this plugin raises, in one typed table: the status codes, and the ones the tools RPC adds. A test fails
 * when a code appears in `src` and in neither table, and when the README's Troubleshooting table or
 * `docs/scripting.md`'s refusal table drifts from them in either direction.
 */

/** The codes the plugin's own code raises, as `CODE: What happened. Next step: What to do.` */
export type PluginCode =
  | "ACCOUNT_UNKNOWN"
  | "AUTH_REQUIRED"
  | "CLIENT_ID_INVALID"
  | "CLIENT_ID_MISSING"
  | "CONNECTION_FAILED"
  | "CURSOR_INVALID"
  | "HOST_UNTESTED"
  | "INPUT_INVALID"
  | "OPTIONS_INVALID"
  | "SCOPE_MISSING"
  | "SERVER_DISABLED"
  | "SERVER_NAME_IN_USE"
  | "SKILLS_INVALID"
  | "SOURCE_UNKNOWN"
  | "STATUS_UNAVAILABLE"
  | "TOO_MANY_MESSAGES"
  | "TOOL_UNAVAILABLE"
  | "UPSTREAM_ERROR"
  | "UPSTREAM_UNREADABLE"

export const PLUGIN_CODES: readonly PluginCode[] = [
  "ACCOUNT_UNKNOWN",
  "AUTH_REQUIRED",
  "CLIENT_ID_INVALID",
  "CLIENT_ID_MISSING",
  "CONNECTION_FAILED",
  "CURSOR_INVALID",
  "HOST_UNTESTED",
  "INPUT_INVALID",
  "OPTIONS_INVALID",
  "SCOPE_MISSING",
  "SERVER_DISABLED",
  "SERVER_NAME_IN_USE",
  "SKILLS_INVALID",
  "SOURCE_UNKNOWN",
  "STATUS_UNAVAILABLE",
  "TOO_MANY_MESSAGES",
  "TOOL_UNAVAILABLE",
  "UPSTREAM_ERROR",
  "UPSTREAM_UNREADABLE",
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
