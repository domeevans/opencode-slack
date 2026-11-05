// Compares Slack's live read tool schemas with the catalog snapshot the tests use (test/host/slack-catalog.ts). It asks a
// running, signed-in OpenCode through the tools RPC's describe, so it covers the reads only: writes are never methods,
// so check their signatures with Code Mode's search({ namespace: "slack" }). Manual: npm run drift. Not part of check.
import { spawnSync } from "node:child_process"
import { SLACK_SCHEMAS } from "../test/host/slack-catalog.js"

type Schema = Record<string, unknown>
interface Method {
  readonly name: string
  readonly available: boolean
  readonly reason?: string
  readonly input?: Schema
}

/** Only what the snapshot records: types, allowed values, properties, required names and array items. */
function shape(schema: unknown): unknown {
  if (typeof schema !== "object" || schema === null) return schema
  const source = schema as Schema
  const kept: Schema = {}
  if (source.type !== undefined) kept.type = source.type
  if (Array.isArray(source.enum)) kept.enum = [...source.enum].sort()
  if (typeof source.properties === "object" && source.properties !== null) {
    kept.properties = Object.fromEntries(Object.entries(source.properties).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, shape(value)]))
  }
  if (Array.isArray(source.required) && source.required.length > 0) kept.required = [...source.required].sort()
  if (source.items !== undefined) kept.items = shape(source.items)
  return kept
}

const result = spawnSync("opencode", ["api", "post", "/api/rpc/slack.workspace.tools/describe", "-d", '{"input":{}}'], { encoding: "utf8" })
if (result.status !== 0) {
  console.error(`opencode api failed (status ${result.status}). Run it with OpenCode serving and Slack signed in.\n${result.stdout}${result.stderr}`)
  process.exit(2)
}
const body = JSON.parse(result.stdout) as { output?: { methods: Method[] }; methods?: Method[] }
const methods = body.output?.methods ?? body.methods ?? []

const problems: string[] = []
for (const method of methods) {
  if (!method.available) {
    problems.push(`${method.name}: not listed now (${method.reason ?? "no reason"}); run /slack-status`)
    continue
  }
  const snapshot = SLACK_SCHEMAS[method.name]
  if (snapshot === undefined) problems.push(`${method.name}: not in the snapshot`)
  else if (JSON.stringify(shape(method.input)) !== JSON.stringify(shape(snapshot))) {
    problems.push(`${method.name}: live ${JSON.stringify(shape(method.input))}\n  snapshot ${JSON.stringify(shape(snapshot))}`)
  }
}
if (methods.length === 0) problems.push("describe listed no methods")

if (problems.length > 0) {
  console.error(`Drift in ${problems.length} read tool(s):\n${problems.join("\n")}`)
  process.exit(1)
}
console.log(`No drift: ${methods.length} read tools match test/host/slack-catalog.ts. Check the writes with Code Mode's search({ namespace: "slack" }).`)
