// An offline stand-in for Slack's MCP server over stdio: every tool in the classification table plus one the
// plugin does not know. It answers the handshake and tool listing, and a `tools/call` with the tool's name and
// arguments as structured content and text, or, for a `query` that starts with "fail", with an upstream error
// (`isError`) whose first line holds a signed URL. With a file path as its argument, it appends each called tool's
// name to that file, one per line, so a test can tell which tools OpenCode called.
import { appendFileSync } from "node:fs"
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

/** Each fake tool's input schema. */
export const FAKE_INPUT = { type: "object", properties: { query: { type: "string" } } } as const

/** The upstream error a "fail" query gets: two lines, the first with a signed URL. */
export const UPSTREAM_FAILURE = "invalid_arguments for https://files.slack.example/f.pdf?X-Amz-Signature=fake-signature-123\nTraceback: second line"

if (import.meta.main) {
  const log = process.argv[2]
  const tools = FAKE_TOOLS.map((name) => ({ name, description: `Fake ${name}`, inputSchema: FAKE_INPUT }))
  const send = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`)
  createInterface({ input: process.stdin }).on("line", (line) => {
    if (line.trim() === "") return
    const message = JSON.parse(line) as {
      id?: number | string
      method: string
      params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> }
    }
    if (message.id === undefined) return
    const reply = (result: object) => send({ jsonrpc: "2.0", id: message.id, result })
    switch (message.method) {
      case "initialize":
        // The MCP handshake's server capabilities: a client lists tools only when the server declares them.
        return reply({ protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-slack", version: "0.0.0" } })
      case "tools/list":
        return reply({ tools })
      case "tools/call": {
        const name = String(message.params?.name)
        const args = message.params?.arguments ?? {}
        if (log !== undefined) appendFileSync(log, `${name}\n`)
        if (String(args.query ?? "").startsWith("fail")) return reply({ content: [{ type: "text", text: UPSTREAM_FAILURE }], isError: true })
        return reply({ content: [{ type: "text", text: `${name}: ${JSON.stringify(args)}` }], structuredContent: { tool: name, arguments: args } })
      }
      case "ping":
        return reply({})
      default:
        return send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } })
    }
  })
}
