// An offline stand-in for Slack's MCP server over stdio: every tool in the classification table plus one the
// plugin does not know. It answers the handshake and tool listing; it is never called.
import { createInterface } from "node:readline"

export const FAKE_TOOLS = [
  "slack_search_public", "slack_search_channels", "slack_search_users", "slack_read_channel", "slack_read_thread",
  "slack_read_user_profile", "slack_read_canvas", "slack_list_channel_members", "slack_get_reactions",
  "slack_list_user_channels", "slack_read_list", "slack_search_emojis",
  "slack_search_public_and_private", "slack_read_file",
  "slack_send_message", "slack_send_message_draft", "slack_schedule_message", "slack_create_canvas", "slack_update_canvas",
  "slack_add_reaction", "slack_get_file_upload_url", "slack_complete_file_upload",
  "slack_create_conversation", "slack_create_list", "slack_update_list", "slack_add_list_record", "slack_update_list_record",
  "slack_brand_new_tool",
]

if (import.meta.main) {
  const tools = FAKE_TOOLS.map((name) => ({ name, description: `Fake ${name}`, inputSchema: { type: "object", properties: {} } }))
  const send = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`)
  createInterface({ input: process.stdin }).on("line", (line) => {
    if (line.trim() === "") return
    const message = JSON.parse(line) as { id?: number | string; method: string; params?: { protocolVersion?: string } }
    if (message.id === undefined) return
    const reply = (result: object) => send({ jsonrpc: "2.0", id: message.id, result })
    switch (message.method) {
      case "initialize":
        // The MCP handshake's server capabilities: a client lists tools only when the server declares them.
        return reply({ protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-slack", version: "0.0.0" } })
      case "tools/list":
        return reply({ tools })
      case "ping":
        return reply({})
      default:
        return send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } })
    }
  })
}
