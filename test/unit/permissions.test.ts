import { describe, expect, test } from "bun:test"
import { defaultRules, insertDefaultRules, type Rule } from "../../src/permissions.js"
import { READ_TOOLS } from "../../src/tools.js"
import { agent, agentEditor, BASE_ALLOW, BASE_RULES } from "./fakes.js"

const ask = (action: string): Rule => ({ action, resource: "*", effect: "ask" })
const allow = (action: string): Rule => ({ action, resource: "*", effect: "allow" })
const deny = (action: string): Rule => ({ action, resource: "*", effect: "deny" })

describe("defaultRules", () => {
  test("asks before every tool on the server, then allows each known read", () => {
    expect(defaultRules()).toEqual([
      ask("slack_*"),
      allow("slack_slack_search_public"),
      allow("slack_slack_search_channels"),
      allow("slack_slack_search_users"),
      allow("slack_slack_read_channel"),
      allow("slack_slack_read_thread"),
      allow("slack_slack_read_user_profile"),
      allow("slack_slack_read_canvas"),
      allow("slack_slack_list_channel_members"),
      allow("slack_slack_get_reactions"),
      allow("slack_slack_list_user_channels"),
      allow("slack_slack_read_list"),
      allow("slack_slack_search_emojis"),
      // The plugin's own slack_events_list, which only reads, for Memory's collector.
      allow("slack_events_list"),
    ])
  })

  test("allows exactly the read tools and the plugin's own events_list", () => {
    expect(defaultRules().slice(1)).toEqual([...READ_TOOLS, "events_list"].map((tool) => allow(`slack_${tool}`)))
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
