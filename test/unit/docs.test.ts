// The skill and the docs name Slack's tools and their parameters for the model and for script authors. Every name
// must exist in Slack's live schemas, which test/host/slack-catalog.ts holds, so the text cannot drift from them.
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { parameters, SLACK_SCHEMAS } from "../host/slack-catalog.js"
import { parseOptions } from "../../src/options.js"
import { buildStatus, statusRows } from "../../src/status.js"
import { classify, NAMESPACE_DESCRIPTION } from "../../src/tools.js"
import { TESTED_HOSTS } from "../../src/defaults.js"
import { defaultRules } from "../../src/permissions.js"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const markdown = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)))
const FILES = [
  ...readdirSync(ROOT).filter((name) => name.endsWith(".md")),
  ...markdown("docs"),
  ...markdown("skills"),
]
const read = (file: string) => readFileSync(join(ROOT, file), "utf8")

interface Use {
  readonly file: string
  readonly tool: string
  readonly parameter: string
}

/** The keys of a JavaScript object literal's body: strings and arrays are blanked first, so their commas don't split. */
const keys = (body: string) =>
  body
    .replace(/"[^"]*"|'[^']*'/g, '""')
    .replace(/\[[^\]]*\]/g, "[]")
    .split(",")
    .flatMap((part) => /^\s*([A-Za-z_]\w*)\s*(?::|$)/.exec(part)?.[1] ?? [])

/** Every parameter the text passes to or names for a Slack tool. */
function uses(file: string, text: string): Use[] {
  const found: Use[] = []
  // A call in code or prose: `slack_read_thread({ channel_id, message_ts })`, `tools.slack.slack_search_public({ query: "…" })`.
  for (const match of text.matchAll(/\b(slack_[a-z_]+)\(\{([\s\S]*?)\}\)/g))
    for (const parameter of keys(match[2]!)) found.push({ file, tool: match[1]!, parameter })
  // A tools RPC call: the keys of the tool's input after the method, up to the end of its code block or paragraph.
  for (const match of text.matchAll(/slack\.workspace\.tools\/(slack_[a-z_]+)([\s\S]*?)(?:```|\n\n|$)/g))
    for (const key of match[2]!.matchAll(/"(\w+)"\s*:/g))
      if (key[1] !== "input" && key[1] !== "sessionID") found.push({ file, tool: match[1]!, parameter: key[1]! })
  // In a table whose header names parameters, a row that names one tool in a cell and its parameters in the next.
  // Values in parentheses are not names.
  let header = ""
  for (const line of text.split("\n")) {
    if (!line.startsWith("|")) {
      header = ""
      continue
    }
    if (header === "") header = line
    if (!/parameter/i.test(header) || line === header) continue
    const cells = line.split("|").map((cell) => cell.trim())
    cells.forEach((cell, index) => {
      const tool = /^`(slack_[a-z_]+)`$/.exec(cell)?.[1]
      const next = cells[index + 1]
      if (tool === undefined || next === undefined || next === "") return
      let names = next
      while (/\([^()]*\)/.test(names)) names = names.replace(/\([^()]*\)/g, "")
      for (const name of names.matchAll(/`([a-z_]+)`/g)) found.push({ file, tool, parameter: name[1]! })
    })
  }
  return found
}

const ALL_PARAMETERS = new Set(Object.keys(SLACK_SCHEMAS).flatMap(parameters))

describe("the skill and the docs", () => {
  test("name only parameters that Slack's schema for that tool has", () => {
    const all = FILES.flatMap((file) => uses(file, read(file)))
    // The skill's table, its read examples, the README's Code Mode and script examples and the scripting doc's.
    expect(all.filter((use) => use.file.startsWith("skills/")).length).toBeGreaterThan(10)
    for (const file of ["README.md", "docs/scripting.md"]) expect({ file, uses: all.some((use) => use.file === file) }).toEqual({ file, uses: true })
    const wrong = all.filter((use) => SLACK_SCHEMAS[use.tool] === undefined || !parameters(use.tool).includes(use.parameter))
    expect(wrong).toEqual([])
  })

  test("name a parameter in a `name: value` example only when some Slack tool has it", () => {
    // The plugin's own options are not tool parameters: `access: "read-only"` is an option example.
    const OPTIONS = new Set(["access", "allowUntestedHost"])
    const wrong = ["skills/slack-search/SKILL.md", "README.md"].flatMap((file) => [...read(file).matchAll(/`([a-z_]+): [^`]+`/g)].map((match) => ({ file, parameter: match[1]! })))
      .filter((use) => !OPTIONS.has(use.parameter) && !ALL_PARAMETERS.has(use.parameter))
    expect(wrong).toEqual([])
  })

  test("teach the search tools' one required parameter, query", () => {
    for (const tool of ["slack_search_public", "slack_search_channels", "slack_search_users", "slack_search_public_and_private"])
      expect({ tool, required: SLACK_SCHEMAS[tool]!.required }).toEqual({ tool, required: ["query"] })
    const skill = read("skills/slack-search/SKILL.md")
    for (const tool of ["slack_search_public", "slack_search_channels", "slack_search_users"])
      expect({ tool, query: uses("skill", skill).some((use) => use.tool === tool && use.parameter === "query") }).toEqual({ tool, query: true })
  })
})

describe("tool names and files the text names", () => {
  // `slack_*` is the catch-all rule, and `slack_<tool>` a pattern; `slack_archive` is the docs' example of another
  // server's tool that the catch-all also matches; `slack_events_list` is the plugin's own tool.
  const NOT_TOOLS = new Set(["slack_", "slack_archive", "slack_events_list"])

  test("every slack_ tool named in the skill and the docs is one of Slack's, after one permission prefix", () => {
    const named = FILES.flatMap((file) => [...read(file).matchAll(/`(slack_[a-z_]*)/g)].map((match) => ({ file, name: match[1]! })))
    expect(named.length).toBeGreaterThan(50)
    const tool = (name: string) => (SLACK_SCHEMAS[name] === undefined && name.startsWith("slack_slack_") ? name.slice("slack_".length) : name)
    expect(named.filter(({ name }) => !NOT_TOOLS.has(name) && SLACK_SCHEMAS[tool(name)] === undefined)).toEqual([])
  })

  test("the skill links only to files the package ships, or to absolute URLs", () => {
    const shipped = (JSON.parse(read("package.json")) as { files: string[] }).files
    const skill = read("skills/slack-search/SKILL.md")
    const targets = [
      ...[...skill.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]!),
      ...[...skill.matchAll(/`([\w./-]+\.(?:md|json|ts|js))`/g)].map((match) => match[1]!),
    ]
    const unshipped = targets.filter((target) => !/^https:\/\//.test(target) && !shipped.some((entry) => target === entry || target.startsWith(`${entry}/`)))
    expect(unshipped).toEqual([])
  })
})

describe("what the access option restricts", () => {
  // The three classes a restricted access affects, and how each text names them.
  const NAMES: Record<string, RegExp> = { private: /private(-channel)? (search|channels)/i, file: /(file reads?|reading files)/i, write: /writes?\b|write and send/i }

  test("status names every class it restricts, for each restricted value, and nothing at the default", () => {
    const rows = (access: "all" | "ask-changes" | "read-only") => {
      const status = buildStatus({
        version: "9.9.9", hostVersion: "2.2.3", hostSupported: true, hostTested: true, parsed: parseOptions({}), access, active: true,
        nameInUse: false, client: { invalid: false }, servers: [], tools: [], agents: [], shadowedSkills: [],
      })
      return { status, text: statusRows(status).find((row) => row.label === "Access")!.value }
    }
    expect(rows("all").status.asksBefore).toEqual([])
    for (const access of ["ask-changes", "read-only"] as const) {
      expect(rows(access).status.asksBefore.length).toBeGreaterThan(0)
      for (const [toolClass, pattern] of Object.entries(NAMES)) expect({ access, toolClass, named: pattern.test(rows(access).text) }).toEqual({ access, toolClass, named: true })
    }
  })

  test("the Code Mode namespace names what each access value does", () => {
    expect(NAMESPACE_DESCRIPTION).toContain("`ask-changes` asks")
    expect(NAMESPACE_DESCRIPTION).toContain("`read-only` denies")
  })
})

describe("the catalog the fake Slack server serves", () => {
  test("lists exactly the tools the plugin classifies, each with an object input", () => {
    const names = Object.keys(SLACK_SCHEMAS)
    expect(names.length).toBe(27)
    expect(names.filter((name) => classify(name) === "unknown")).toEqual([])
    for (const name of names) expect({ name, type: SLACK_SCHEMAS[name]!.type }).toEqual({ name, type: "object" })
    const jelly = JSON.parse(read("package.json")) as { jelly: { tools: { name: string }[] } }
    // Every tool Slack lists is declared, and the plugin's own events_list.
    expect(jelly.jelly.tools.map((tool) => tool.name.replace(/^slack\./, "")).sort()).toEqual([...names, "events_list"].sort())
  })
})

// The block an administrator copies into managed config: the README prints it in full, and the configuration guide
// prints it for every access value, generated from defaultRules().
describe("the default rules block", () => {
  test("the README's Permissions section prints defaultRules() in full", () => {
    const section = /## Permissions([\s\S]*?)## Configure/.exec(read("README.md"))?.[1] ?? ""
    const printed = /generated from[\s\S]*?```json\n([\s\S]*?)\n\s*```/.exec(section)?.[1] ?? "[]"
    expect(JSON.parse(printed)).toEqual(defaultRules())
  })

  test("the configuration guide prints the block for every access value", () => {
    const raw = read("docs/configuration.md")
    for (const access of ["all", "ask-changes", "read-only"] as const) {
      const block = new RegExp(`\`access: "${access}"\`[\\s\\S]*?\n\n\`\`\`json\n([\\s\\S]*?)\n\`\`\``).exec(raw)?.[1] ?? "[]"
      expect({ access, block: JSON.parse(block) }).toEqual({ access, block: defaultRules(access) })
    }
  })
})

// Every "tested on …" mention states TESTED_HOSTS, so a release added to the list cannot leave a stale sentence behind.
describe("tested hosts", () => {
  const UNRELEASED = /## \[Unreleased\]([\s\S]*?)(?=\n## |$)/.exec(read("CHANGELOG.md"))?.[1] ?? ""
  const SOURCES: [string, string][] = [
    ["README.md", read("README.md")],
    ["AGENTS.md", read("AGENTS.md")],
    ["SECURITY.md", read("SECURITY.md")],
    ["docs/configuration.md", read("docs/configuration.md")],
    ["CHANGELOG.md (Unreleased)", UNRELEASED],
  ]

  test.each(SOURCES)("%s names exactly TESTED_HOSTS wherever it says what is tested", (file, text) => {
    const mentions = text
      .split("\n")
      .flatMap((line) => line.split(/\.\s+/))
      .filter((sentence) => /\btested\b/i.test(sentence))
      // The supported range is not a tested release: drop a backticked `>=a.b.c <d.e.f` span before reading versions.
      .map((sentence) => sentence.replace(/`[^`]*>=[^`]*`/g, ""))
      .map((sentence) => [...sentence.matchAll(/\b\d+\.\d+\.\d+\b/g)].map((version) => version[0]!))
      .filter((versions) => versions.length > 0)
    for (const versions of mentions) expect({ file, versions: [...new Set(versions)].sort() }).toEqual({ file, versions: [...TESTED_HOSTS].sort() })
  })

  test("the untested example is 2.2.99, and no doc names a future release as tested", () => {
    const all = SOURCES.map(([, text]) => text).join("\n")
    expect(all).toContain("2.2.99")
    expect(all).not.toMatch(/\b2\.2\.(?:7|8|9[0-8])\b(?!\d)/)
  })
})
