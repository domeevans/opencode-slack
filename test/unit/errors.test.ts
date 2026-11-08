// Every code the plugin raises is documented, and every documented code is raised: the status codes and the plugin's
// own errors in docs/configuration.md "Errors" and the README's Troubleshooting, the tools RPC's in docs/scripting.md
// "Errors". Each status next step appears verbatim in the configuration table, so the docs cannot drift from status.
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseOptions } from "../../src/options.js"
import { SlackRpc } from "../../src/rpc.js"
import { buildStatus, type StatusInput } from "../../src/status.js"
import { NEXT_STEPS } from "../../src/host/tools-rpc.js"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const read = (file: string) => readFileSync(join(ROOT, file), "utf8")

/** The section of a Markdown file under a heading, up to the next heading of the same or a higher level. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`)
  if (start === -1) throw new Error(`no heading ${heading}`)
  const level = /^#+/.exec(heading)![0]
  const rest = text.slice(start + heading.length + 2)
  const end = rest.search(new RegExp(`\\n#{1,${level.length}} `))
  return end === -1 ? rest : rest.slice(0, end)
}

/** The codes in a table's code column (the first cell that holds `CODE` names, or a given column). */
const tableCodes = (text: string, column: number) =>
  new Set(text.split("\n").filter((line) => line.startsWith("|")).flatMap((line) => {
    const cell = line.split("|")[column + 1] ?? ""
    return [...cell.matchAll(/`([A-Z][A-Z_]{3,}[A-Z])`/g)].map((match) => match[1]!)
  }))

/**
 * The plugin's own error codes, written as `CODE: what happened` in its sources, or as `eventsError("CODE", …)` by
 * slack_events_list, outside the shared tools RPC.
 */
function raisedInSources(): Set<string> {
  const files = readdirSync(join(ROOT, "src")).filter((name) => /\.tsx?$/.test(name))
  return new Set(files.flatMap((name) => [...read(join("src", name)).matchAll(/["`]([A-Z]+(?:_[A-Z]+)+): |eventsError\(\s*"([A-Z]+(?:_[A-Z]+)+)"/g)].map((match) => (match[1] ?? match[2])!)))
}

const statusCodes = (SlackRpc.methods.status.output as unknown as { properties: { code: { enum: string[] } } }).properties.code.enum
const PLUGIN_CODES = new Set([...statusCodes, ...raisedInSources()])

describe("the errors tables", () => {
  test("the plugin raises STATUS_UNAVAILABLE, SKILLS_INVALID and slack_events_list's codes besides the status codes", () => {
    expect([...raisedInSources()].sort()).toEqual([
      "ACCOUNT_UNKNOWN",
      "CURSOR_INVALID",
      "INPUT_INVALID",
      "SKILLS_INVALID",
      "SOURCE_UNKNOWN",
      "STATUS_UNAVAILABLE",
      "TOOL_UNAVAILABLE",
      "TOO_MANY_MESSAGES",
      "UPSTREAM_ERROR",
      "UPSTREAM_UNREADABLE",
    ])
  })

  test("docs/configuration.md Errors lists exactly the codes the plugin raises", () => {
    expect([...tableCodes(section(read("docs/configuration.md"), "## Errors"), 0)].sort()).toEqual([...PLUGIN_CODES].sort())
  })

  test("the README's Troubleshooting table lists exactly the status codes", () => {
    const table = section(read("README.md"), "## Troubleshooting")
    expect([...tableCodes(table, 1)].sort()).toEqual([...statusCodes].sort())
    for (const code of ["STATUS_UNAVAILABLE", "SKILLS_INVALID"]) expect({ code, named: table.includes(code) }).toEqual({ code, named: true })
  })

  test("docs/scripting.md Errors lists exactly the codes the tools RPC raises", () => {
    const raised = new Set([...Object.keys(NEXT_STEPS), "CLIENT_ID_MISSING", "CLIENT_ID_INVALID"])
    expect([...tableCodes(section(read("docs/scripting.md"), "## Errors"), 0)].sort()).toEqual([...raised].sort())
  })
})

describe("the status next steps", () => {
  const base: StatusInput = {
    version: "9.9.9",
    hostVersion: "2.2.3",
    hostSupported: true,
    hostTested: true,
    parsed: parseOptions({ oauth: { client_id: "C1" } }),
    active: true,
    nameInUse: false,
    client: { client: { id: "C1", source: "options" }, invalid: false },
    servers: [{ name: "slack", status: { status: "connected" } }],
    tools: [],
    agents: [],
    shadowedSkills: [],
  }
  const cases: readonly Partial<StatusInput>[] = [
    { hostVersion: "2.1.0", hostSupported: false, hostTested: false, active: false },
    { client: { invalid: false } },
    { client: { invalid: true } },
    { nameInUse: true },
    { servers: [] },
    { servers: [{ name: "slack", status: { status: "pending" } }] },
    { servers: [{ name: "slack", status: { status: "disabled" } }] },
    { servers: [{ name: "slack", status: { status: "needs_auth", error: "" } }] },
    { servers: [{ name: "slack", status: { status: "failed", error: "x" } }] },
    { agents: [{ id: "custom", permissions: [{ action: "*", resource: "*", effect: "allow" }] }] },
  ]

  test("each appears verbatim in docs/configuration.md Errors", () => {
    const table = section(read("docs/configuration.md"), "## Errors")
    for (const overrides of cases) {
      const { code, nextStep } = buildStatus({ ...base, ...overrides })
      expect({ code, nextStep, documented: table.includes(nextStep) }).toEqual({ code, nextStep, documented: true })
    }
  })
})
