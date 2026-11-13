import type { Plugin } from "@opencode/plugin"
import type { Access } from "./options.js"
import { SERVER } from "./defaults.js"
import { EVENTS_LIST } from "./host/events-list.js"
import { KNOWN_TOOLS, MARK_READ, STATUS_METHOD } from "./tools.js"

type AgentEditor = Parameters<Parameters<Plugin.Context["agent"]["transform"]>[0]>[0]

export interface Rule {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "ask" | "deny"
}

/** The tools that only read: they run at every `access` value. */
const READ_LIKE: readonly string[] = Object.keys(KNOWN_TOOLS).filter((tool) => KNOWN_TOOLS[tool] === "read")
/** The tools that read private channels or files, and the writes: they ask or are denied once access is restricted. */
const OTHER_TOOLS: readonly string[] = Object.keys(KNOWN_TOOLS).filter((tool) => KNOWN_TOOLS[tool] !== "read")

const rule = (action: string, effect: Rule["effect"]): Rule => ({ action, resource: "*", effect })

/**
 * The block the plugin inserts. Broad first, narrow last, because the last matching rule wins.
 *
 * At the default `access: "all"` every Slack tool is allowed, and so is one Slack adds later, through the `slack_*`
 * namespace. `"ask-changes"` keeps the reads and asks for the rest; `"read-only"` keeps the reads and denies the rest.
 * The private-channel search, the file read and every write are the rest: they are not reads.
 */
export function defaultRules(access: Access = "all"): Rule[] {
  const other: Rule["effect"] = access === "all" ? "allow" : access === "ask-changes" ? "ask" : "deny"
  return [
    rule(`${SERVER}_*`, other),
    ...READ_LIKE.map((tool) => rule(`${SERVER}_${tool}`, "allow")),
    // The plugin's own events_list only reads, and Memory's collector runs it with no one there.
    rule(`${SERVER}_${EVENTS_LIST}`, "allow"),
    // The tools RPC's status method reads only the plugin's own status and the signed-in account's ids.
    rule(`${SERVER}_${STATUS_METHOD}`, "allow"),
    ...OTHER_TOOLS.map((tool) => rule(`${SERVER}_${tool}`, other)),
    // The plugin's own mentions_list and dms_list have no rule of their own: like the private search, they read direct
    // messages and private channels, so the namespace rule above decides them.
    // The plugin's own mark_read is a write: it changes the user's read state in Slack.
    rule(`${SERVER}_${MARK_READ}`, other),
  ]
}

const same = (a: Rule | undefined, b: Rule) => a?.action === b.action && a.resource === b.resource && a.effect === b.effect
const BASE_ALLOW: Rule = { action: "*", resource: "*", effect: "allow" }

/**
 * True when the whole default block appears, in order, anywhere after the agent's first base allow: inserted by the
 * plugin or copied by the user. Other plugins insert their blocks at the same index, so it need not follow directly.
 */
function hasDefaultRules(permissions: readonly Rule[], access: Access = "all"): boolean {
  const base = permissions.findIndex((item) => same(item, BASE_ALLOW))
  if (base === -1) return false
  const block = defaultRules(access)
  return permissions.some((_, start) => start > base && block.every((item, offset) => same(permissions[start + offset], item)))
}

/**
 * Puts the default rules directly after each agent's first base `* * allow` rule. Everything evaluated later still
 * wins: the agent's own rules, the user's `permissions`, and saved "Always allow" approvals. Agents without a base
 * allow keep their stricter policy. Replaying the transform leaves agents unchanged, also when another plugin has
 * since inserted its own block between the base allow and this one.
 *
 * Verified on OpenCode 2.2.3. Agents created after plugins run, such as agents defined only in user config, get no
 * rules; status names them as unguarded and shows these rules for each agent's own permissions.
 */
export function insertDefaultRules(editor: AgentEditor, access: Access = "all"): void {
  const block = defaultRules(access)
  for (const agent of editor.list()) {
    if (hasDefaultRules(agent.permissions, access)) continue
    const at = agent.permissions.findIndex((item) => same(item, BASE_ALLOW))
    if (at === -1) continue
    editor.update(agent.id, (draft) => {
      draft.permissions.splice(at + 1, 0, ...block.map((item) => ({ ...item })))
    })
  }
}

const wildcard = (pattern: string) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`)

/** The host's evaluation for an MCP call (resource `*`): the last matching rule wins, and no match asks. */
export function evaluate(permissions: readonly Rule[], action: string): Rule["effect"] {
  return permissions.findLast((item) => wildcard(item.action).test(action) && wildcard(item.resource).test("*"))?.effect ?? "ask"
}

/** An action no Slack tool can have: OpenCode limits tool names to letters, digits, `_` and `-`. */
const UNKNOWN_ACTION = `${SERVER}_.`

/**
 * Agents that need the per-agent fix: they have a base allow but not the block (for example agents defined only in
 * the user's config, which OpenCode creates after plugins run), and their own rules would let a Slack tool this
 * plugin does not know run without asking. An agent whose rules already ask or deny for every Slack tool is not listed.
 */
export const unguardedAgents = (
  agents: readonly { readonly id: string; readonly permissions: readonly Rule[] }[],
  access: Access = "all",
) =>
  agents
    .filter((agent) => agent.permissions.some((item) => same(item, BASE_ALLOW)) && !hasDefaultRules(agent.permissions, access) && evaluate(agent.permissions, UNKNOWN_ACTION) === "allow")
    .map((agent) => agent.id)
