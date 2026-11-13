import { eventsError, micros } from "./events.js"
import type { JsonSchema } from "./host/tools-rpc.js"
import { DMS_LIST } from "./tools.js"
import {
  boundText, inputProblems, ISO_PATTERN, limitOf, parseTime, readCall, readCallUnless, record, signedIn, str, TS, tsMillis, tsTime,
  type ReadOptions, type ReadSpec,
} from "./web-reads.js"

/**
 * `slack_dms_list`: the signed-in user's direct messages and group direct messages with their latest message and
 * whether it is unread, newest first, as JSON. Slack's MCP server lists conversation ids only. This read lists the
 * user's conversations with `users.conversations`, reads each one's latest message and read state with
 * `conversations.info`, the members of a group message with `conversations.members`, and names with `users.info`.
 * Class `read`, with its own action `slack_dms_list`. It needs `im:read` and `mpim:read` (listing and read state),
 * `im:history` and `mpim:history` (the latest message) and `users:read` (names).
 */

export const DMS_ACTION = `slack_${DMS_LIST}`
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
/** The most pages of 200 conversations listed, and the most conversations whose latest message is read, per call. */
const LIST_PAGE = 200
const MAX_LIST_PAGES = 5
const MAX_CHECKED = 100
/** How many conversations are read at once, and the most members a group message names. */
const CONCURRENCY = 4
const MAX_MEMBERS = 20

const CONVERSATION_ID = /^[DG][A-Z0-9]{8,12}$/
const USER_ID = /^[UW][A-Z0-9]{2,20}$|^USLACKBOT$/
const BOT_ID = /^B[A-Z0-9]{2,20}$/
/** Slack's answers for a listed conversation it will not open, which leave that one conversation out. */
const UNREADABLE = ["channel_not_found", "method_not_supported_for_channel_type"]

export interface DmMember {
  readonly id: string
  readonly name: string
}

export interface DmLatest {
  readonly ts: string
  readonly user_id: string
  readonly text: string
  readonly time: string
  readonly permalink?: string
}

export interface DmConversation {
  readonly channel_id: string
  readonly kind: "dm" | "group-dm"
  readonly members: readonly DmMember[]
  readonly latest: DmLatest
  readonly unread: boolean
}

export interface DmsOutput {
  readonly conversations: readonly DmConversation[]
}

export const DMS_INPUT: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    since: { type: "string", pattern: ISO_PATTERN, description: "An ISO date and time with a zone: list only conversations whose latest message is at or after it" },
    limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: `The most conversations to return, newest first (${DEFAULT_LIMIT} by default)` },
  },
}

const string = { type: "string" }
export const DMS_OUTPUT: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["conversations"],
  properties: {
    conversations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["channel_id", "kind", "members", "latest", "unread"],
        properties: {
          channel_id: string,
          kind: { type: "string", enum: ["dm", "group-dm"] },
          members: {
            type: "array",
            items: { type: "object", additionalProperties: false, required: ["id", "name"], properties: { id: string, name: string } },
          },
          latest: {
            type: "object",
            additionalProperties: false,
            required: ["ts", "user_id", "text", "time"],
            properties: { ts: string, user_id: string, text: string, time: string, permalink: string },
          },
          unread: { type: "boolean" },
        },
      },
    },
  },
}

const DESCRIPTION = "Lists the signed-in user's Slack direct and group messages with their latest message and whether it is unread, newest first, as JSON."

function parse(input: unknown): { since?: number; limit: number } {
  const { record: fields, problems } = inputProblems(input === undefined ? {} : input, ["since", "limit"])
  const since = fields?.["since"] === undefined ? undefined : parseTime(fields["since"])
  const limit = limitOf(fields?.["limit"], 1, MAX_LIMIT, DEFAULT_LIMIT)
  if (fields !== undefined) {
    if (fields["since"] !== undefined && since === undefined) problems.push(`"since" must be an ISO date and time with a zone, such as 2026-11-13T09:00:00Z`)
    if (limit === undefined) problems.push(`"limit" must be a whole number from 1 to ${MAX_LIMIT}`)
  }
  if (problems.length > 0 || limit === undefined) {
    throw eventsError("INPUT_INVALID", `The ${DMS_LIST} input is invalid: ${problems.join("; ")}.`, `Pass since and limit as ${DMS_LIST}'s schema describes them.`)
  }
  return since === undefined ? { limit } : { since, limit }
}

interface Listed {
  readonly id: string
  readonly kind: "dm" | "group-dm"
  /** The other person of a direct message. */
  readonly user?: string
  readonly dormant: boolean
  readonly updated: number
}

/** The user's open direct and group messages, from `users.conversations`, at most five pages of 200. */
async function listConversations(options: ReadOptions, self: string, signal: AbortSignal): Promise<Listed[]> {
  const listed: Listed[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const body = await readCall(options, DMS_LIST, "users.conversations", {
      types: "im,mpim",
      exclude_archived: "true",
      limit: String(LIST_PAGE),
      ...(cursor === undefined ? {} : { cursor }),
    }, signal)
    const channels = body["channels"]
    for (const value of Array.isArray(channels) ? channels : []) {
      const item = record(value)
      const id = str(item["id"])
      if (id === undefined || !CONVERSATION_ID.test(id) || item["is_archived"] === true) continue
      const im = item["is_im"] === true
      const user = str(item["user"])
      // A direct message needs another person who still exists; a note to oneself is not a conversation.
      if (im && (user === undefined || !USER_ID.test(user) || user === self || item["is_user_deleted"] === true)) continue
      if (!im && item["is_mpim"] !== true) continue
      listed.push({
        id,
        kind: im ? "dm" : "group-dm",
        ...(im && user !== undefined ? { user } : {}),
        dormant: record(item["properties"])["is_dormant"] === true,
        updated: typeof item["updated"] === "number" ? item["updated"] : 0,
      })
    }
    cursor = str(record(body["response_metadata"])["next_cursor"])
    if (cursor === undefined) break
  }
  return listed
}

/** Runs `work` on each item, `CONCURRENCY` at a time, in order. */
async function each<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await work(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker))
  return results
}

interface Read {
  readonly listed: Listed
  readonly latest: DmLatest
  readonly unread: boolean
}

/** A conversation's latest message and read state, from `conversations.info`, or undefined when it has no message. */
async function readConversation(options: ReadOptions, listed: Listed, self: string, signal: AbortSignal): Promise<Read | undefined> {
  // Slack lists some conversations that it then cannot open for the user, such as Slackbot's: those are left out.
  const body = await readCallUnless(options, DMS_LIST, "conversations.info", { channel: listed.id }, signal, UNREADABLE)
  if (body === undefined) return undefined
  const channel = record(body["channel"])
  const latest = record(channel["latest"])
  const ts = str(latest["ts"])
  const user = str(latest["user"]) ?? str(latest["bot_id"])
  if (ts === undefined || !TS.test(ts) || user === undefined || !(USER_ID.test(user) || BOT_ID.test(user))) return undefined
  const text = typeof latest["text"] === "string" ? latest["text"] : ""
  const display = channel["unread_count_display"] ?? channel["unread_count"]
  const lastRead = str(channel["last_read"])
  // Slack's own count when it gives one; otherwise a message from someone else after the read mark.
  const unread = typeof display === "number"
    ? display > 0
    : user !== self && (lastRead === undefined || !TS.test(lastRead) || micros(ts) > micros(lastRead))
  return { listed, latest: { ts, user_id: user, text: boundText(text), time: tsTime(ts) }, unread }
}

async function dmsList(options: ReadOptions, input: unknown, signal: AbortSignal): Promise<DmsOutput> {
  const { since, limit } = parse(input)
  const { userId: self } = await signedIn(options, DMS_LIST)
  // Slack lists conversations in no order of activity: the ones it marks dormant last, then the most recently updated.
  const listed = (await listConversations(options, self, signal))
    .sort((a, b) => Number(a.dormant) - Number(b.dormant) || b.updated - a.updated)
    .slice(0, MAX_CHECKED)
  const read = (await each(listed, (item) => readConversation(options, item, self, signal)))
    .filter((item): item is Read => item !== undefined && (since === undefined || tsMillis(item.latest.ts) >= since))
    .sort((a, b) => tsMillis(b.latest.ts) - tsMillis(a.latest.ts))
    .slice(0, limit)

  // Names, once per person per call. A name Slack does not give is the id.
  const names = new Map<string, Promise<string>>()
  const nameOf = (id: string) => {
    let name = names.get(id)
    if (name === undefined) {
      name = readCall(options, DMS_LIST, "users.info", { user: id }, signal).then((body) => {
        const user = record(body["user"])
        const profile = record(user["profile"])
        return str(profile["display_name"]) ?? str(user["real_name"]) ?? str(profile["real_name"]) ?? str(user["name"]) ?? id
      }, () => id)
      names.set(id, name)
    }
    return name
  }
  const memberIds = async (item: Read): Promise<string[]> => {
    if (item.listed.user !== undefined) return [item.listed.user]
    const body = await readCall(options, DMS_LIST, "conversations.members", { channel: item.listed.id, limit: String(MAX_MEMBERS + 1) }, signal)
    const members = Array.isArray(body["members"]) ? body["members"] : []
    return members.filter((id): id is string => typeof id === "string" && USER_ID.test(id) && id !== self).slice(0, MAX_MEMBERS)
  }

  const conversations = await each(read, async (item): Promise<DmConversation> => {
    const ids = await memberIds(item)
    const members = await Promise.all(ids.map(async (id) => ({ id, name: await nameOf(id) })))
    return { channel_id: item.listed.id, kind: item.listed.kind, members, latest: item.latest, unread: item.unread }
  })
  return { conversations }
}

export const DMS_SPEC: ReadSpec<DmsOutput> = {
  name: DMS_LIST,
  description: DESCRIPTION,
  input: DMS_INPUT,
  output: DMS_OUTPUT,
  run: dmsList,
  content: (output) => {
    const unread = output.conversations.filter((item) => item.unread).length
    return `${output.conversations.length} Slack conversation${output.conversations.length === 1 ? "" : "s"}, ${unread} unread.`
  },
}

export { DMS_LIST }
