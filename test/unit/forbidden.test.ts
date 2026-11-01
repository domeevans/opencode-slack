// The forbidden APIs in AGENTS.md: fork-only and legacy host APIs, private host source and unstable host packages.
// No file in src/, test/ or skills/ may use them. This file names them, so it is the only one not searched.
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"

const REPO = fileURLToPath(new URL("../..", import.meta.url))
const SELF = relative(REPO, fileURLToPath(import.meta.url)).split(sep).join("/")

interface Rule {
  readonly name: string
  readonly pattern: RegExp
  /** A line the rule must flag. */
  readonly example: string
  /** Files where the same word means something else, with the reason. */
  readonly except?: Readonly<Record<string, string>>
}

const RULES: readonly Rule[] = [
  { name: "ctx.mcp.catalog", pattern: /mcp\.catalog/, example: "await ctx.mcp.catalog()" },
  { name: "ctx.mcp.attest", pattern: /mcp\.attest/, example: "ctx.mcp.attest(entry)" },
  { name: "supports* markers", pattern: /\bsupports[A-Z]/, example: "if (ctx.permission.supportsCancellation) {}" },
  { name: "a second argument to permission.assert", pattern: /permission\.assert\([^)]*,/, example: "await ctx.permission.assert(input, { signal })" },
  { name: "tool options.mcp delegation", pattern: /options\.mcp\b/, example: "tool.options.mcp = server" },
  {
    name: "config capabilities",
    pattern: /\bcapabilities\b/,
    example: "capabilities: { dispatch: true },",
    except: { "test/host/fake-slack-mcp.ts": "the MCP handshake's server capabilities, not plugin config" },
  },
  { name: "responsePolicy", pattern: /responsePolicy/, example: "responsePolicy: \"text-only\"," },
  { name: "Plugin.image and profile images", pattern: /\bimage\b|PROFILE_IMAGE/, example: "Plugin.define({ id, image: PROFILE_IMAGE, setup })" },
  { name: "ctx.generate.text", pattern: /generate\.text/, example: "await ctx.generate.text(prompt)" },
  { name: "experimental.policies", pattern: /experimental\.policies/, example: "experimental.policies.push(policy)" },
  { name: "ctx.experimental.artifact", pattern: /\bexperimental\s*\??\.\s*artifact\b/, example: "await ctx.experimental?.artifact.create(file)" },
  { name: "ctx.permission.hook", pattern: /permission\.hook/, example: "ctx.permission.hook(escalate)" },
  { name: "@opencode-ai/plugin", pattern: /@opencode-ai\/plugin/, example: "import { tool } from \"@opencode-ai/plugin\"" },
  { name: "@opencode/ai imports", pattern: /(["'`])@opencode\/ai(?:\/[^"'`\s]*)?\1/, example: "import { generate } from \"@opencode/ai/provider\"" },
  { name: "a server() export", pattern: /\bexport\s+(?:async\s+)?(?:function|const|let)\s+server\b/, example: "export async function server(input) {}" },
  { name: "OpenCode host source", pattern: /packages\/(?:core|plugin|schema|sdk|server)\/src/, example: "import { Agent } from \"../../opencode/packages/core/src/agent\"" },
]

/** Lines no rule may flag: the public host API this plugin uses. */
const ALLOWED = [
  "import { Plugin } from \"@opencode/plugin\"",
  "import type { Plugin } from '@opencode/plugin'",
  "import { Rpc } from \"@opencode/plugin/rpc\"",
  "import { OpenCode } from \"@opencode/sdk\"",
  "await ctx.permission.assert(input)",
  "ctx.experimental",
]

function files(): string[] {
  return ["src", "test", "skills"]
    .flatMap((dir) => readdirSync(join(REPO, dir), { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name !== ".DS_Store")
    .map((entry) => relative(REPO, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .filter((path) => path !== SELF && !path.split("/").includes("node_modules"))
    .sort()
}

function uses(rule: Rule): string[] {
  return files()
    .filter((path) => rule.except?.[path] === undefined)
    .flatMap((path) => readFileSync(join(REPO, path), "utf8").split("\n")
      .flatMap((line, index) => (rule.pattern.test(line) ? [`${path}:${index + 1}: ${line.trim()}`] : [])))
}

describe("forbidden APIs", () => {
  test("the search covers the source, the tests and the skills", () => {
    expect(files()).toEqual(expect.arrayContaining(["src/index.ts", "src/tui.tsx", "test/host/harness.ts", "skills/slack-search/SKILL.md"]))
  })

  test.each(RULES.map((rule) => [rule.name, rule] as const))("no file uses %s", (_name, rule) => {
    expect(rule.pattern.test(rule.example)).toBe(true)
    expect(uses(rule)).toEqual([])
  })

  test("the public host API is not flagged", () => {
    for (const line of ALLOWED) expect({ line, flagged: RULES.filter((rule) => rule.pattern.test(line)).map((rule) => rule.name) }).toEqual({ line, flagged: [] })
  })

  test("every exception names a file that exists", () => {
    const all = new Set(files())
    for (const rule of RULES) for (const path of Object.keys(rule.except ?? {})) expect({ rule: rule.name, path, exists: all.has(path) }).toEqual({ rule: rule.name, path, exists: true })
  })
})
