// Every code the plugin raises is documented, and every documented code is raised: the status codes and the plugin's
// own errors in docs/configuration.md "Errors" and the README's Troubleshooting, the tools RPC's in docs/scripting.md
// "Errors". Each status next step appears verbatim in the configuration table, so the docs cannot drift from status.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { PLUGIN_CODES } from "../../src/codes.js"
import { parseOptions } from "../../src/options.js"
import { buildStatus, type StatusInput } from "../../src/status.js"

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

describe("the errors tables", () => {
  // The README's and the scripting doc's tables are checked against the same table in test/unit/codes.test.ts.
  test("docs/configuration.md Errors lists exactly the codes the plugin raises", () => {
    expect([...tableCodes(section(read("docs/configuration.md"), "## Errors"), 0)].sort()).toEqual([...PLUGIN_CODES].sort())
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
