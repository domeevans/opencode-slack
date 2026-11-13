// docs/scripting.md and the README's scripting lines are the contract a script author copies. Every example must use a
// method this plugin registers, carry the location header and the strict envelope, and name only fields that method's
// schema accepts, so a doc example cannot drift from the code.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { EVENTS_INPUT } from "../../src/events.js"
import { METHODS, TOOLS_RPC_ID } from "../../src/host/tools-rpc.js"
import { DMS_INPUT } from "../../src/dms.js"
import { MARK_READ_INPUT } from "../../src/mark-read.js"
import { MENTIONS_INPUT } from "../../src/mentions.js"
import { parameters, SLACK_SCHEMAS } from "../host/slack-catalog.js"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const FILES = ["docs/scripting.md", "README.md"]
const METHODS_BY_NAME = new Map(METHODS.map((method) => [method.name, method]))
/** The plugin's own methods, which setup registers beside the MCP ones, with their input schemas. */
const OWN_INPUTS: Readonly<Record<string, { properties: Record<string, unknown>; required?: readonly string[] }>> = {
  events_list: EVENTS_INPUT as never,
  mark_read: MARK_READ_INPUT as never,
  status: { properties: {}, required: [] },
  mentions_list: MENTIONS_INPUT as never,
  dms_list: DMS_INPUT as never,
}

interface Example {
  readonly file: string
  readonly line: number
  readonly method: string
  readonly body: unknown
  readonly statement: string
}

/** Every `opencode api post /api/rpc/…` call in a file, as its method name and its parsed body. */
function calls(file: string, text: string): Example[] {
  return [...text.matchAll(/opencode api post \/api\/rpc\/([A-Za-z0-9.]+)\/([A-Za-z0-9_]+)/g)].map((match) => {
    const start = match.index!
    // A statement runs to the end of its fenced block or the next blank line.
    const rest = text.slice(start)
    const end = rest.search(/\n\s*\n|\n```/)
    const statement = (end === -1 ? rest : rest.slice(0, end)).trim()
    return {
      file,
      line: text.slice(0, start).split("\n").length,
      method: match[2]!,
      body: bodyOf(statement),
      statement,
    }
  })
}

/** The `-d '{…}'` body of a statement, by matching braces. */
function bodyOf(statement: string): unknown {
  const at = statement.indexOf("-d '{")
  if (at === -1) return undefined
  let depth = 0
  let inString = false
  for (let i = at + 4; i < statement.length; i++) {
    const char = statement[i]
    if (inString) {
      if (char === "\\") i++
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === "{") depth++
    else if (char === "}") {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(statement.slice(at + 4, i + 1))
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

const examples = FILES.flatMap((file) => calls(file, readFileSync(join(ROOT, file), "utf8")))

/** The tool's input nested in the strict envelope. */
const inputOf = (body: unknown) => (body as { input?: { input?: unknown } } | undefined)?.input?.input

describe("the scripting examples", () => {
  test("there are examples to check", () => {
    expect(examples.length).toBeGreaterThan(2)
  })

  test.each(examples)("$file:$line calls $method with this plugin's RPC id and a real method", (example) => {
    expect(example.statement).toContain("/api/rpc/slack.workspace.tools/")
    expect(TOOLS_RPC_ID).toBe("slack.workspace.tools")
    expect(example.method === "describe" || METHODS_BY_NAME.has(example.method) || Object.hasOwn(OWN_INPUTS, example.method)).toBe(true)
  })

  test.each(examples)("$file:$line sends the location header", (example) => {
    expect(example.statement).toContain('-H "x-opencode-directory:$PWD"')
  })

  test.each(examples)("$file:$line sends the strict envelope", (example) => {
    const envelope = (example.body as { input?: Record<string, unknown> } | undefined)?.input
    expect(envelope).toBeDefined()
    if (example.method === "describe") {
      expect(Object.keys(envelope!).filter((key) => key !== "sessionID")).toEqual([])
      return
    }
    expect(Object.keys(envelope!).sort()).toEqual(["input", "sessionID"])
    expect(typeof envelope!["sessionID"]).toBe("string")
    expect(typeof envelope!["input"]).toBe("object")
  })

  test.each(examples.filter((example) => example.method !== "describe"))("$file:$line names only fields $method accepts", (example) => {
    const input = (inputOf(example.body) ?? {}) as Record<string, unknown>
    const own = OWN_INPUTS[example.method]
    if (own !== undefined) {
      for (const key of Object.keys(input)) expect({ key, known: Object.hasOwn(own.properties, key) }).toEqual({ key, known: true })
      for (const key of own.required ?? []) expect({ key, given: key in input }).toEqual({ key, given: true })
      return
    }
    const method = METHODS_BY_NAME.get(example.method)!
    expect(method.kind).toBe("mcp")
    const schema = SLACK_SCHEMAS[example.method]!
    for (const key of Object.keys(input)) expect({ key, known: parameters(example.method).includes(key) }).toEqual({ key, known: true })
    for (const key of schema.required as readonly string[]) expect({ key, given: key in input }).toEqual({ key, given: true })
  })
})
