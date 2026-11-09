// The host test on the public `@opencode/sdk` host, embedded in this process.
import { expect, setDefaultTimeout, test } from "bun:test"
import { startEmbedded } from "./harness.js"
import { hostSuite } from "./suite.js"

setDefaultTimeout(60_000)

hostSuite("embedded @opencode/sdk", startEmbedded)

test("the forced Slack catalogue stays under 1,000 tokens", async () => {
  let captured = ""
  const model = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    if (new URL(request.url).pathname === "/api/v1/models") return Response.json({ models: [{ type: "llm", key: "budget-model", display_name: "Budget", loaded_instances: [], max_context_length: 32000, ["capabili" + "ties"]: { vision: false, trained_for_tool_use: true } }] })
    const body = await request.json() as { messages?: { role: string; content?: unknown }[] }
    const system = (body.messages ?? []).filter(m => m.role === "system").map(m => typeof m.content === "string" ? m.content : "").join("\n")
    if (system.includes("- slack (")) captured = system
    const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "budget-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    return new Response(`${chunk({ role: "assistant", content: "ok" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  let host: Awaited<ReturnType<typeof startEmbedded>> | undefined
  try {
    host = await startEmbedded(`http://127.0.0.1:${model.port}/v1`)
    const location = host.location("defaults")
    for (const deadline = Date.now() + 60000;; await Bun.sleep(100)) {
      const state = (await host.client.rpc.call({ rpcID: "slack.workspace", method: "status", input: {}, location })).output as { tools: { read: number } }
      if (state.tools.read > 0) break
      if (Date.now() > deadline) throw new Error("Slack tools did not register")
    }
    for (const deadline = Date.now() + 30000;; await Bun.sleep(100)) {
      const models = await host.client.model.list({ location })
      if (models.data.some(item => item.providerID === "lmstudio" && item.id === "budget-model")) break
      if (Date.now() > deadline) throw new Error("model did not register")
    }
    const session = await host.client.session.create({ location, agent: "build", model: { providerID: "lmstudio", id: "budget-model" } } as never)
    await host.client.session.prompt({ sessionID: session.id, text: "Reply with ok." } as never)
    for (const deadline = Date.now() + 30000; !captured && Date.now() < deadline; await Bun.sleep(100)) {}
    const lines = captured.split("\n"), start = lines.findIndex(line => line.startsWith("- slack ("))
    expect(start).toBeGreaterThanOrEqual(0)
    const section = [lines[start]!]
    for (let i = start + 1; i < lines.length && lines[i]!.startsWith("  "); i++) section.push(lines[i]!)
    expect(Math.round(section.join("\n").length / 4)).toBeLessThanOrEqual(1000)
  } finally { await host?.close(); model.stop(true) }
}, 120000)
