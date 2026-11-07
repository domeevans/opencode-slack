export const DEFAULT_REDIRECT_URI = "http://localhost:8765/callback"
/** Examples in error next steps for a hosted (`https:`) redirect and its local listener port. */
export const HOSTED_REDIRECT_EXAMPLE = "https://host.example/oauth/return"
export const CALLBACK_PORT_EXAMPLE = 8766
export const DEFAULT_SCOPES: readonly string[] = ["channels:history", "channels:read", "search:read.public", "users:read"]
/** The MCP server's name: the prefix of every Slack tool name and permission action, and the Code Mode namespace. */
export const SERVER = "slack"
export const APP_MANIFEST_URL = "https://github.com/joe-broadhead/opencode-slack/blob/HEAD/docs/slack-app-manifest.json"
export const SLACK_MCP_URL = "https://mcp.slack.com/mcp"
/** The OpenCode versions the plugin sets itself up on, as `opencode.host` in package.json states. */
export const SUPPORTED_HOST_RANGE = ">=2.2.3 <2.3.0"
/** The OpenCode releases every check runs on. Status calls only these "tested"; the host tests and CI use this list. */
export const TESTED_HOSTS: readonly string[] = ["2.2.3", "2.2.4", "2.2.5", "2.2.6"]
