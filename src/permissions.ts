import type { Plugin } from "@opencode/plugin"
import { SERVER } from "./defaults.js"
import { EVENTS_LIST } from "./host/events-list.js"
import { READ_TOOLS } from "./tools.js"

type AgentEditor = Parameters<Parameters<Plugin.Context["agent"]["transform"]>[0]>[0]

export interface Rule {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "ask" | "deny"
}

/**
 * Ask before every tool on the server, then allow the known reads, and the plugin's own `slack_events_list`, which only
 * reads and which Memory's collector runs with no one there. Later rules win.
 */
export function defaultRules(): Rule[] {
  return [
    { action: `${SERVER}_*`, resource: "*", effect: "ask" },
    ...[...READ_TOOLS, EVENTS_LIST].map((tool): Rule => ({ action: `${SERVER}_${tool}`, resource: "*", effect: "allow" })),
  ]
}

const same = (a: Rule, b: Rule) => a.action === b.action && a.resource === b.resource && a.effect === b.effect
const BASE_ALLOW: Rule = { action: "*", resource: "*", effect: "allow" }

/**
 * Puts the default rules directly after each agent's first base `* * allow` rule. Everything evaluated later
 * still wins: the agent's own rules, the user's `permissions`, and saved "Always allow" approvals. Agents
 * without a base allow keep their stricter policy. Replaying the transform leaves agents unchanged, also when
 * another plugin has since inserted its own block between the base allow and this one.
 *
 * Verified on OpenCode 2.2.3. Agents created after plugins run, such as agents defined only in user config,
 * get no rules; status names them as unguarded and shows these rules for each agent's own permissions.
 */
export function insertDefaultRules(editor: AgentEditor): void {
  const block = defaultRules()
  for (const agent of editor.list()) {
    const at = agent.permissions.findIndex((rule) => same(rule, BASE_ALLOW))
    if (at === -1) continue
    // Other plugins insert their own blocks at the same place, so the block may sit anywhere after the base allow.
    const present = agent.permissions.some((_rule, start) => start > at && block.every((rule, offset) => {
      const existing = agent.permissions[start + offset]
      return existing !== undefined && same(existing, rule)
    }))
    if (present) continue
    editor.update(agent.id, (draft) => {
      draft.permissions.splice(at + 1, 0, ...block)
    })
  }
}
