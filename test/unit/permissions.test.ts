import { describe, expect, test } from "bun:test"
import { defaultRules, evaluate, insertDefaultRules, type Rule } from "../../src/permissions.js"
import { KNOWN_TOOLS, READ_TOOLS } from "../../src/tools.js"
import { agent, agentEditor, BASE_ALLOW, BASE_RULES } from "./fakes.js"

const ask = (action: string): Rule => ({ action, resource: "*", effect: "ask" })
const allow = (action: string): Rule => ({ action, resource: "*", effect: "allow" })
const deny = (action: string): Rule => ({ action, resource: "*", effect: "deny" })

describe("defaultRules", () => {
  const OTHER = Object.keys(KNOWN_TOOLS).filter((tool) => KNOWN_TOOLS[tool] !== "read")

  test("at the default access, allows every tool on the server and any it adds later", () => {
    expect(defaultRules()).toEqual([
      allow("slack_*"),
      ...READ_TOOLS.map((tool) => allow(`slack_${tool}`)),
      allow("slack_events_list"),
      allow("slack_status"),
      ...OTHER.map((tool) => allow(`slack_${tool}`)),
      allow("slack_mark_read"),
    ])
    expect(defaultRules().every((rule) => rule.effect === "allow")).toBe(true)
  })

  test("at ask-changes, allows each read and asks for the rest, the namespace included", () => {
    const rules = defaultRules("ask-changes")
    expect(rules[0]).toEqual(ask("slack_*"))
    expect(rules.slice(1, 1 + READ_TOOLS.length)).toEqual(READ_TOOLS.map((tool) => allow(`slack_${tool}`)))
    expect(rules.slice(1 + READ_TOOLS.length, 3 + READ_TOOLS.length)).toEqual([allow("slack_events_list"), allow("slack_status")])
    expect(rules.slice(3 + READ_TOOLS.length)).toEqual([...OTHER, "mark_read"].map((tool) => ask(`slack_${tool}`)))
  })

  test("at read-only, allows each read and denies the rest, the namespace included", () => {
    const rules = defaultRules("read-only")
    expect(rules[0]).toEqual(deny("slack_*"))
    expect(rules.slice(1, 1 + READ_TOOLS.length)).toEqual(READ_TOOLS.map((tool) => allow(`slack_${tool}`)))
    expect(rules.slice(1 + READ_TOOLS.length, 3 + READ_TOOLS.length)).toEqual([allow("slack_events_list"), allow("slack_status")])
    expect(rules.slice(3 + READ_TOOLS.length)).toEqual([...OTHER, "mark_read"].map((tool) => deny(`slack_${tool}`)))
  })

  test("gives a tool Slack adds later the value's effect, and always runs the reads", () => {
    for (const [access, effect] of [["all", "allow"], ["ask-changes", "ask"], ["read-only", "deny"]] as const) {
      expect({ access, effect: evaluate([allow("*"), ...defaultRules(access)], "slack_new_tool") }).toEqual({ access, effect })
      for (const read of READ_TOOLS) expect({ access, read, effect: evaluate([allow("*"), ...defaultRules(access)], `slack_${read}`) }).toEqual({ access, read, effect: "allow" })
    }
  })

  test("names every known tool, and the plugin's own methods, exactly once, after its namespace rule", () => {
    const named = defaultRules("all").slice(1).map((rule) => rule.action)
    expect(named.sort()).toEqual([...Object.keys(KNOWN_TOOLS), "events_list", "status", "mark_read"].map((tool) => `slack_${tool}`).sort())
  })
})

describe("insertDefaultRules", () => {
  test("puts the block directly after the base allow, before the .env rules", () => {
    const build = agent("build", BASE_RULES)
    insertDefaultRules(agentEditor([build]).editor)
    expect(build.permissions).toEqual([BASE_ALLOW, ...defaultRules(), ...BASE_RULES.slice(1)])
  })

  test("keeps the agent's own later rules after the block, so they still win", () => {
    const explore = agent("explore", [...BASE_RULES, deny("*"), allow("read"), allow("grep")])
    insertDefaultRules(agentEditor([explore]).editor)
    expect(explore.permissions.slice(0, 1 + defaultRules().length)).toEqual([BASE_ALLOW, ...defaultRules()])
    expect(explore.permissions.slice(1 + defaultRules().length)).toEqual([...BASE_RULES.slice(1), deny("*"), allow("read"), allow("grep")])
  })

  test("uses only the first base allow", () => {
    const twice = agent("twice", [BASE_ALLOW, ask("bash"), BASE_ALLOW])
    insertDefaultRules(agentEditor([twice]).editor)
    expect(twice.permissions).toEqual([BASE_ALLOW, ...defaultRules(), ask("bash"), BASE_ALLOW])
  })

  test.each([
    ["no rules", []],
    ["only a deny-all", [deny("*")]],
    ["only specific allows", [allow("read"), allow("slack_*")]],
    ["an allow-all on another resource", [{ action: "*", resource: "src/**", effect: "allow" } as Rule]],
    ["an ask-all", [ask("*")]],
  ])("leaves an agent with %s untouched", (_label, permissions: Rule[]) => {
    const strict = agent("strict", permissions)
    const { editor, updated } = agentEditor([strict])
    insertDefaultRules(editor)
    expect(updated).toEqual([])
    expect(strict.permissions).toEqual(permissions)
  })

  test("updates every agent with a base allow and only those", () => {
    const agents = [agent("build", BASE_RULES), agent("locked", [deny("*")]), agent("plan", [...BASE_RULES, deny("edit")])]
    const { editor, updated } = agentEditor(agents)
    insertDefaultRules(editor)
    expect(updated).toEqual(["build", "plan"])
  })

  test("replaying the transform leaves agents unchanged", () => {
    const agents = [agent("build", BASE_RULES), agent("explore", [...BASE_RULES, deny("*")])]
    const { editor, updated } = agentEditor(agents)
    insertDefaultRules(editor)
    const once = structuredClone(agents)
    insertDefaultRules(editor)
    insertDefaultRules(editor)
    expect(agents).toEqual(once)
    expect(updated).toEqual(["build", "explore"])
  })

  test("replaying after another plugin inserted its block at the same place adds nothing", () => {
    const build = agent("build", BASE_RULES)
    const { editor } = agentEditor([build])
    insertDefaultRules(editor)
    build.permissions.splice(1, 0, ask("linear_*"), allow("linear_get_issue"))
    const before = structuredClone(build.permissions)
    insertDefaultRules(editor)
    expect(build.permissions).toEqual(before)
  })

  test("a rebuilt agent gets the block exactly once", () => {
    insertDefaultRules(agentEditor([agent("build", BASE_RULES)]).editor)
    const rebuilt = agent("build", BASE_RULES)
    insertDefaultRules(agentEditor([rebuilt]).editor)
    expect(rebuilt.permissions.filter((rule) => rule.action === "slack_*")).toHaveLength(1)
  })
})
