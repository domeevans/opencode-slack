import { eventsError } from "./events.js"
import type { JsonSchema } from "./host/tools-rpc.js"
import { MENTIONS_LIST } from "./tools.js"
import {
  boundText, inputProblems, ISO_PATTERN, limitOf, parseTime, readCall, record, signedIn, str, TS, tsMillis, tsTime,
  type ReadOptions, type ReadSpec,
} from "./web-reads.js"

/**
 * `slack_mentions_list`: the messages that mention the signed-in user since a time, newest first, as JSON. Slack's MCP
 * search answers in Markdown, and a script cannot put each viewer's own user id in its query; this read takes the id
 * from status's `auth.test` and searches for `<@U…>` with Slack's search API, `assistant.search.context`, over public
 * and private channels, group messages and direct messages. Class `read`, with its own action `slack_mentions_list`.
 * It needs the search scopes the plugin's private search needs: `search:read.public`, `search:read.private`,
 * `search:read.im` and `search:read.mpim`.
 */

export const MENTIONS_ACTION = `slack_${MENTIONS_LIST}`
/** Slack's most results per search page, and the most pages one call reads. */
const PAGE = 20
const MAX_PAGES = 5
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

const CHANNEL_ID = /^[CDG][A-Z0-9]{8,12}$/
const USER_ID = /^[UW][A-Z0-9]{2,20}$/

export interface Mention {
  readonly id: string
  readonly channel_id: string
  readonly channel_name: string
  readonly ts: string
  readonly thread_ts?: string
  readonly user_id: string
  readonly user_name?: string
  readonly text: string
  readonly permalink: string
  readonly time: string
}

export interface MentionsOutput {
  readonly events: readonly Mention[]
}

export const MENTIONS_INPUT: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["since"],
  properties: {
    since: { type: "string", pattern: ISO_PATTERN, description: "An ISO date and time with a zone, such as 2026-11-13T09:00:00Z: list mentions at or after it" },
    limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: `The most mentions to return, newest first (${DEFAULT_LIMIT} by default)` },
  },
}

const string = { type: "string" }
export const MENTIONS_OUTPUT: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["events"],
  properties: {
    events: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "channel_id", "channel_name", "ts", "user_id", "text", "permalink", "time"],
        properties: {
          id: string, channel_id: string, channel_name: string, ts: string, thread_ts: string, user_id: string,
          user_name: string, text: string, permalink: string, time: string,
        },
      },
    },
  },
}

const DESCRIPTION = "Lists Slack messages that mention the signed-in user since a time, newest first, as JSON: channel, author, text, permalink and time."

function parse(input: unknown): { since: number; limit: number } {
  const { record: fields, problems } = inputProblems(input, ["since", "limit"])
  const since = parseTime(fields?.["since"])
  const limit = limitOf(fields?.["limit"], 1, MAX_LIMIT, DEFAULT_LIMIT)
  if (fields !== undefined) {
    if (since === undefined) problems.push(`"since" must be an ISO date and time with a zone, such as 2026-11-13T09:00:00Z`)
    if (limit === undefined) problems.push(`"limit" must be a whole number from 1 to ${MAX_LIMIT}`)
  }
  if (problems.length > 0 || since === undefined || limit === undefined) {
    throw eventsError("INPUT_INVALID", `The ${MENTIONS_LIST} input is invalid: ${problems.join("; ")}.`, `Pass since and limit as ${MENTIONS_LIST}'s schema describes them.`)
  }
  return { since, limit }
}

/** The thread a permalink names in its `thread_ts` query, as Slack writes it for a message in a thread. */
function threadOf(permalink: string): string | undefined {
  try {
    return new URL(permalink).searchParams.get("thread_ts") ?? undefined
  } catch {
    return undefined
  }
}

/** One search result as a mention, or undefined when it lacks what a mention needs. */
function mentionOf(value: unknown, self: string): Mention | undefined {
  const item = record(value)
  const channel = str(item["channel_id"])
  const ts = str(item["message_ts"])
  const user = str(item["author_user_id"])
  const permalink = str(item["permalink"])
  const text = typeof item["content"] === "string" ? item["content"] : undefined
  if (channel === undefined || !CHANNEL_ID.test(channel) || ts === undefined || !TS.test(ts)) return undefined
  if (user === undefined || !USER_ID.test(user) || user === self) return undefined
  if (permalink === undefined || !permalink.startsWith("https://") || text === undefined) return undefined
  const thread = str(item["thread_ts"]) ?? threadOf(permalink)
  const name = str(item["author_name"])
  return {
    id: `${channel}:${ts}`,
    channel_id: channel,
    channel_name: str(item["channel_name"]) ?? channel,
    ts,
    ...(thread !== undefined && TS.test(thread) ? { thread_ts: thread } : {}),
    user_id: user,
    ...(name === undefined ? {} : { user_name: name }),
    text: boundText(text),
    permalink,
    time: tsTime(ts),
  }
}

async function mentionsList(options: ReadOptions, input: unknown, signal: AbortSignal): Promise<MentionsOutput> {
  const { since, limit } = parse(input)
  const { userId } = await signedIn(options, MENTIONS_LIST)
  const events: Mention[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES && events.length < limit; page += 1) {
    const body = await readCall(options, MENTIONS_LIST, "assistant.search.context", {
      query: `<@${userId}>`,
      channel_types: "public_channel,private_channel,mpim,im",
      content_types: "messages",
      sort: "timestamp",
      sort_dir: "desc",
      after: String(Math.floor(since / 1000)),
      limit: String(PAGE),
      ...(cursor === undefined ? {} : { cursor }),
    }, signal)
    const messages = record(body["results"])["messages"]
    if (!Array.isArray(messages)) break
    let older = false
    for (const item of messages) {
      const mention = mentionOf(item, userId)
      if (mention === undefined || seen.has(mention.id)) continue
      if (tsMillis(mention.ts) < since) {
        older = true
        continue
      }
      seen.add(mention.id)
      events.push(mention)
    }
    cursor = str(record(body["response_metadata"])["next_cursor"])
    if (cursor === undefined || older) break
  }
  events.sort((a, b) => tsMillis(b.ts) - tsMillis(a.ts))
  return { events: events.slice(0, limit) }
}

export const MENTIONS_SPEC: ReadSpec<MentionsOutput> = {
  name: MENTIONS_LIST,
  description: DESCRIPTION,
  input: MENTIONS_INPUT,
  output: MENTIONS_OUTPUT,
  run: mentionsList,
  content: (output) => `${output.events.length} Slack mention${output.events.length === 1 ? "" : "s"}.`,
}

export { MENTIONS_LIST }
