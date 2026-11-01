/** How a Slack MCP tool is treated by default. Only `read` runs without asking. */
export type ToolClass = "read" | "private" | "file" | "write" | "unknown"

/**
 * The tools Slack's MCP server lists. Any other tool on the server is `unknown`
 * and asks until it is classified here; `/slack-status` names those tools.
 */
const KNOWN: Readonly<Record<string, Exclude<ToolClass, "unknown">>> = {
  slack_search_public: "read",
  slack_search_channels: "read",
  slack_search_users: "read",
  slack_read_channel: "read",
  slack_read_thread: "read",
  slack_read_user_profile: "read",
  slack_read_canvas: "read",
  slack_list_channel_members: "read",
  slack_get_reactions: "read",
  slack_list_user_channels: "read",
  slack_read_list: "read",
  slack_search_emojis: "read",
  slack_search_public_and_private: "private",
  slack_read_file: "file",
  slack_send_message: "write",
  slack_send_message_draft: "write",
  slack_schedule_message: "write",
  slack_create_canvas: "write",
  slack_update_canvas: "write",
  slack_add_reaction: "write",
  slack_get_file_upload_url: "write",
  slack_complete_file_upload: "write",
  slack_create_conversation: "write",
  slack_create_list: "write",
  slack_update_list: "write",
  slack_add_list_record: "write",
  slack_update_list_record: "write",
}

export const READ_TOOLS: readonly string[] = Object.keys(KNOWN).filter((tool) => KNOWN[tool] === "read")

export function classify(tool: string): ToolClass {
  return Object.hasOwn(KNOWN, tool) ? KNOWN[tool]! : "unknown"
}
