// An offline stand-in for Slack's MCP server over stdio: every tool Slack lists, with Slack's own input schemas
// (slack-catalog.ts), plus one the plugin does not know. It answers the handshake and tool listing. A `tools/call`
// gets the tool's name and arguments as structured content and text; for the `query` "text only", text alone; for a
// `query` that starts with "fail", an upstream error (`isError`) whose first line holds a signed URL. With a file
// path as its argument, it appends each called tool's name to that file, one per line, so a test can tell which
// tools OpenCode called.
import { appendFileSync } from "node:fs"
import { createInterface } from "node:readline"
import { SLACK_SCHEMAS } from "./slack-catalog.js"

/** A tool Slack does not list, so the plugin does not know it. */
const UNKNOWN_TOOL = "slack_brand_new_tool"

export const FAKE_TOOLS = [...Object.keys(SLACK_SCHEMAS), UNKNOWN_TOOL]

/** Each fake tool's input schema: Slack's own, and a plain query for the unknown tool. */
export const fakeInput = (name: string) => SLACK_SCHEMAS[name] ?? { type: "object", properties: { query: { type: "string" } }, required: ["query"] }

/** The upstream error a "fail" query gets: two lines, the first with a signed URL. */
export const UPSTREAM_FAILURE = "invalid_arguments for https://files.slack.example/f.pdf?X-Amz-Signature=fake-signature-123\nTraceback: second line"

if (import.meta.main) {
  const log = process.argv[2]
  const tools = FAKE_TOOLS.map((name) => ({ name, description: `Fake ${name}`, inputSchema: fakeInput(name) }))
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
        if (args.query === "text only") return reply({ content: [{ type: "text", text: `${name}: text only` }] })
        return reply({ content: [{ type: "text", text: `${name}: ${JSON.stringify(args)}` }], structuredContent: { tool: name, arguments: args } })
      }
      case "ping":
        return reply({})
      default:
        return send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } })
    }
  })
}
