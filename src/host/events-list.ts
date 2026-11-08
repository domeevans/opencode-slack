/**
 * The events_list source contract: how Memory's collector reads what happened in a source since it last looked
 * (opencode-mem `docs/design/memory-v1-contracts.md` §2.3 and §4.5, `memory-funnel-v1.md` §4 and §5).
 *
 *   events_list({ since?, cursor?, limit?, account?, source? })
 *     → { source, account, owner, events, cursor, more, trust: "untrusted" }
 *
 * A source plugin adds one read-only tool and tools-RPC method named `events_list`. It never writes, never asks and
 * never calls a model, so a scheduled check can run it with no one there. The rules, which `eventsListConformance`
 * tests against any source:
 *
 * - **Input.** `since` is an ISO date (a UTC day) or an ISO date-time with `Z` or an offset. `cursor` is a string a
 *   previous result of the same source and account returned. `limit` is an integer from 1 to 500, 100 by default.
 *   `account` names one of the source's accounts; without it the source uses its default. `source` names one of the
 *   plugin's sources (gws: `gmail`, later `calendar`, `drive`); without it the plugin uses its first, and it refuses a
 *   source it does not have. A cursor wins over `since`.
 *   With neither, the source starts `FIRST_RUN_HOURS` before now. Anything else is refused, and a cursor the source
 *   did not issue (another source, another account, a malformed one) is refused rather than restarted.
 * - **Events.** Each is a `SourceEvent`: the source's own record of one thing, normalised. `text` is at most 4096
 *   characters, `title` at most 300, `actors` at most 20, and `hash` is `eventHash` of the rest. Memory sets the
 *   event's `id` from `source:account:external_id`, so a repeat is harmless. Events are oldest first within a result.
 * - **Cursor.** Opaque: only the source reads it, through `encodeCursor` and `decodeCursor`. Every result carries one,
 *   empty pages included, at most 1024 characters. Calling again with it lists what follows the result's last event
 *   and never skips anything; calling again with an older cursor lists the same events again, so a collector that
 *   failed to store its batch retries safely. `more` is true when another call now would list more.
 * - **Size.** A result's JSON is at most `MAX_PAGE_BYTES`; a source that would pass it stops early (`fitPage`).
 * - **Source, account, owner and trust.** Every result names its `source` and `account`, empty pages included, so a
 *   first call that finds nothing can still be bound; every event names the same two. `owner` is the signed-in source
 *   account (`{ id, label }`), which Memory checks against the person's binding before it stores anything. `trust` is
 *   always "untrusted": events are data, never instructions.
 *
 * Shared module. Each source plugin keeps an identical copy at `src/host/events-list.ts`, because each bundle stands
 * alone; the plugin's `scripts/check-copies.mjs` fails its check when the copy differs from the one every source
 * plugin carries. Change it in every plugin at once, then update the hash there. It imports only `node:crypto`.
 */
import { createHash } from "node:crypto"

/** The tool's and the tools-RPC method's name. */
export const EVENTS_LIST = "events_list"

export const EVENT_KINDS = ["message", "meeting", "session", "bookmark", "issue", "pr", "commit", "doc", "event"] as const
export type EventKind = (typeof EVENT_KINDS)[number]

/** The most characters each field takes, and the most items each list takes. */
export const EVENT_LIMITS = {
  source: 64,
  account: 128,
  externalId: 512,
  thread: 512,
  title: 300,
  text: 4096,
  url: 2048,
  actors: 20,
  actorRole: 32,
  actorId: 320,
  actorName: 200,
  labels: 20,
  label: 64,
  ownerId: 320,
  ownerLabel: 200,
  cursor: 1024,
} as const

/** `limit`'s default and inclusive range. */
export const PAGE = { default: 100, min: 1, max: 500 } as const

/** The most bytes of JSON one result holds. A source stops early, and says `more`, rather than pass it. */
export const MAX_PAGE_BYTES = 900_000

/** Where a listing starts when the call has neither cursor nor since: this many hours before now. */
export const FIRST_RUN_HOURS = 24

export const TRUST = "untrusted" as const

/** Someone or something an event involves. `id` is a stable, scheme-qualified id: `mailto:…`, `slack:U…`, `github:…`. */
export interface EventActor {
  readonly role: string
  readonly id: string
  readonly name?: string
}

/** One normalised event, as a source lists it. Memory adds `id`. */
export interface SourceEvent {
  readonly source: string
  readonly account: string
  readonly external_id: string
  readonly kind: EventKind
  /** UTC, as `Date.prototype.toISOString` writes it. */
  readonly occurred_at: string
  readonly thread: string | null
  readonly actors: EventActor[]
  readonly title: string
  readonly text: string
  /** An https link to the thing in the source, or null when it has none. */
  readonly url: string | null
  readonly labels: string[]
  /** `sha256:<hex>` of every other field, from `eventHash`. */
  readonly hash: string
}

/** The signed-in source account. */
export interface EventsOwner {
  readonly id: string
  readonly label: string
}

export interface EventsListInput {
  readonly since?: string
  readonly cursor?: string
  readonly limit?: number
  readonly account?: string
  readonly source?: string
}

export interface EventsListResult {
  /** The source every event names, also on an empty page. */
  readonly source: string
  /** The account every event names, also on an empty page. */
  readonly account: string
  readonly owner: EventsOwner
  readonly events: SourceEvent[]
  readonly cursor: string
  readonly more: boolean
  readonly trust: typeof TRUST
}

/** An input after `parseEventsListInput`: `since` in epoch milliseconds, `limit` with its default. */
export interface EventsListRequest {
  readonly since?: number
  readonly cursor?: string
  readonly limit: number
  readonly account?: string
  readonly source?: string
}

// ── Input ───────────────────────────────────────────────────────────────

/** An ISO date (a UTC day), or an ISO date-time with seconds optional and `Z` or an offset. */
export const SINCE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/

/** A source's name: a lowercase word such as gmail or history. */
export const SOURCE_PATTERN = /^[a-z][a-z0-9-]*$/

const INPUT_KEYS: readonly string[] = ["since", "cursor", "limit", "account", "source"]
/** True when the text has a control character (U+0000 to U+001F, or U+007F). */
const hasControl = (text: string) => [...text].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)

const plainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** `since` in epoch milliseconds; undefined when it is not one of the accepted forms or not a real time. */
export function sinceTime(since: string): number | undefined {
  if (!SINCE_PATTERN.test(since)) return undefined
  const time = Date.parse(since.length === 10 ? `${since}T00:00:00Z` : since)
  return Number.isFinite(time) ? time : undefined
}

/** The input checked and normalised, or the problems with it, one sentence each, naming fields and never values. */
export function parseEventsListInput(input: unknown): { ok: true; value: EventsListRequest } | { ok: false; problems: string[] } {
  const value = input === undefined || input === null ? {} : input
  if (!plainObject(value)) return { ok: false, problems: ["the input must be an object"] }
  const problems = Object.keys(value).filter((key) => !INPUT_KEYS.includes(key)).map((key) => `"${key}" is not an input of events_list`)
  const { since, cursor, limit, account, source } = value
  let time: number | undefined
  if (since !== undefined) {
    time = typeof since === "string" ? sinceTime(since) : undefined
    if (time === undefined) problems.push(`"since" must be an ISO date, or an ISO date-time with Z or an offset`)
  }
  if (cursor !== undefined && (typeof cursor !== "string" || cursor.length === 0 || cursor.length > EVENT_LIMITS.cursor)) {
    problems.push(`"cursor" must be a cursor from a previous result`)
  }
  if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < PAGE.min || limit > PAGE.max)) {
    problems.push(`"limit" must be an integer from ${PAGE.min} to ${PAGE.max}`)
  }
  if (account !== undefined && (typeof account !== "string" || account.length === 0 || account.length > EVENT_LIMITS.account || hasControl(account))) {
    problems.push(`"account" must be a non-empty account name of at most ${EVENT_LIMITS.account} characters`)
  }
  if (source !== undefined && (typeof source !== "string" || source.length > EVENT_LIMITS.source || !SOURCE_PATTERN.test(source))) {
    problems.push(`"source" must be a source's name, a lowercase word such as gmail`)
  }
  if (problems.length > 0) return { ok: false, problems }
  return {
    ok: true,
    value: {
      ...(time === undefined ? {} : { since: time }),
      ...(cursor === undefined ? {} : { cursor: cursor as string }),
      limit: (limit as number | undefined) ?? PAGE.default,
      ...(account === undefined ? {} : { account: account as string }),
      ...(source === undefined ? {} : { source: source as string }),
    },
  }
}

/** Where a listing without a cursor starts: `since`, or `FIRST_RUN_HOURS` before `now`. */
export function startTime(request: Pick<EventsListRequest, "since">, now: number): number {
  return request.since ?? now - FIRST_RUN_HOURS * 3_600_000
}

// ── Cursor ──────────────────────────────────────────────────────────────

const CURSOR_VERSION = 1

/**
 * An opaque cursor for `source` holding `state`: base64url JSON that names the source, so another source's cursor is
 * refused. Throws when it would be longer than `EVENT_LIMITS.cursor`, a bug in the source.
 */
export function encodeCursor(source: string, state: Readonly<Record<string, unknown>>): string {
  const cursor = Buffer.from(JSON.stringify({ ...state, v: CURSOR_VERSION, s: source }), "utf8").toString("base64url")
  if (cursor.length > EVENT_LIMITS.cursor) throw new Error(`events-list: a ${source} cursor is ${cursor.length} characters, over ${EVENT_LIMITS.cursor}`)
  return cursor
}

/** The state `encodeCursor` stored for `source`; undefined when the cursor is malformed or another source's. */
export function decodeCursor(source: string, cursor: string): Record<string, unknown> | undefined {
  if (cursor.length === 0 || cursor.length > EVENT_LIMITS.cursor || !/^[A-Za-z0-9_-]+$/.test(cursor)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
  } catch {
    return undefined
  }
  if (!plainObject(parsed) || parsed["v"] !== CURSOR_VERSION || parsed["s"] !== source) return undefined
  const { v: _v, s: _s, ...state } = parsed
  return state
}

// ── Events ──────────────────────────────────────────────────────────────

/** At most `max` characters, ending in `…` when cut, never splitting a surrogate pair. */
export function cut(text: string, max: number): string {
  if (text.length <= max) return text
  let end = Math.max(0, max - 1)
  const code = text.charCodeAt(end - 1)
  if (end > 0 && code >= 0xd800 && code <= 0xdbff) end--
  return `${text.slice(0, end)}…`
}

/** `sha256:` and the hex digest of every field but the hash, in a fixed order. */
export function eventHash(event: Omit<SourceEvent, "hash">): string {
  const fields = [
    event.source,
    event.account,
    event.external_id,
    event.kind,
    event.occurred_at,
    event.thread,
    event.actors.map((actor) => [actor.role, actor.id, actor.name ?? null]),
    event.title,
    event.text,
    event.url,
    event.labels,
  ]
  return `sha256:${createHash("sha256").update(JSON.stringify(fields)).digest("hex")}`
}

/** What a source fills in for `makeEvent`; it normalises the rest. */
export interface EventDraft {
  readonly source: string
  readonly account: string
  readonly external_id: string
  readonly kind: EventKind
  /** A Date, epoch milliseconds, or a string `Date.parse` reads. */
  readonly occurred_at: Date | number | string
  readonly thread?: string | null
  readonly actors?: readonly { readonly role: string; readonly id: string; readonly name?: string | null }[]
  readonly title?: string | null
  readonly text?: string | null
  readonly url?: string | null
  readonly labels?: readonly string[]
}

const clean = (text: string) => text.replaceAll("\u0000", "")
const oneLine = (text: string) => clean(text).replace(/\s+/g, " ").trim()

/**
 * A `SourceEvent` from a draft: the time in UTC ISO form, the title on one line and cut to 300 characters, the text cut
 * to 4096, actors without blanks or repeats and at most 20, labels likewise, a url only when it is https, and the hash.
 * Throws when the time is not a real time.
 */
export function makeEvent(draft: EventDraft): SourceEvent {
  const time = draft.occurred_at instanceof Date ? draft.occurred_at.getTime() : typeof draft.occurred_at === "number" ? draft.occurred_at : Date.parse(draft.occurred_at)
  if (!Number.isFinite(time)) throw new Error("events-list: an event's occurred_at is not a time")
  const seen = new Set<string>()
  const actors: EventActor[] = []
  for (const actor of draft.actors ?? []) {
    const role = oneLine(actor.role).toLowerCase()
    const id = oneLine(actor.id)
    const key = `${role}\u0000${id}`
    if (!role || !id || seen.has(key) || actors.length >= EVENT_LIMITS.actors) continue
    seen.add(key)
    const name = actor.name ? cut(oneLine(actor.name), EVENT_LIMITS.actorName) : ""
    actors.push(name ? { role, id, name } : { role, id })
  }
  const labels = [...new Set((draft.labels ?? []).map((label) => oneLine(label).replace(/\s/g, "-")).filter((label) => label.length > 0 && label.length <= EVENT_LIMITS.label))].slice(0, EVENT_LIMITS.labels)
  const url = draft.url && /^https:\/\/\S+$/.test(draft.url) && draft.url.length <= EVENT_LIMITS.url ? draft.url : null
  const thread = draft.thread ? oneLine(draft.thread) || null : null
  const event = {
    source: draft.source,
    account: draft.account,
    external_id: draft.external_id,
    kind: draft.kind,
    occurred_at: new Date(time).toISOString(),
    thread,
    actors,
    title: cut(oneLine(draft.title ?? ""), EVENT_LIMITS.title),
    text: cut(clean(draft.text ?? "").trim(), EVENT_LIMITS.text),
    url,
    labels,
  }
  return { ...event, hash: eventHash(event) }
}

/** Events oldest first; events at the same time keep their order. */
export function oldestFirst<T extends Pick<SourceEvent, "occurred_at">>(events: readonly T[]): T[] {
  return events
    .map((event, index) => ({ event, index, time: Date.parse(event.occurred_at) }))
    .sort((a, b) => a.time - b.time || a.index - b.index)
    .map(({ event }) => event)
}

/**
 * How many of `events`, in the order given, fit in one result: at most `limit`, and as many as keep the result's JSON
 * within `MAX_PAGE_BYTES`, but always at least one, since one event is far smaller than that.
 */
export function fitPage(events: readonly SourceEvent[], limit: number): number {
  let bytes = 2_048
  let count = 0
  for (const event of events) {
    if (count >= limit) break
    bytes += Buffer.byteLength(JSON.stringify(event)) + 1
    if (count > 0 && bytes > MAX_PAGE_BYTES) break
    count++
  }
  return count
}

/** Whose a result is: the source and account it lists, and the signed-in owner of that account. */
export interface EventsListIdentity {
  readonly source: string
  readonly account: string
  readonly owner: EventsOwner
}

/** A result, with its source, account, owner and trust marker. */
export function eventsListResult(identity: EventsListIdentity, events: readonly SourceEvent[], cursor: string, more: boolean): EventsListResult {
  return { source: identity.source, account: identity.account, owner: identity.owner, events: [...events], cursor, more, trust: TRUST }
}

// ── Checks ──────────────────────────────────────────────────────────────

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/
const ROLE = /^[a-z][a-z0-9_-]*$/
const SCHEMED = /^[a-z][a-z0-9+.-]*:\S+$/
const HASH = /^sha256:[0-9a-f]{64}$/

const text = (value: unknown, max: number, empty = false): value is string =>
  typeof value === "string" && value.length <= max && (empty || value.length > 0) && !value.includes("\u0000")
const line = (value: unknown, max: number, empty = false): value is string => text(value, max, empty) && !hasControl(value)

/** One event's problems, one sentence each; none when it keeps the contract. */
export function eventProblems(event: unknown, where = "event"): string[] {
  if (!plainObject(event)) return [`${where} is not an object`]
  const problems: string[] = []
  const keys = ["source", "account", "external_id", "kind", "occurred_at", "thread", "actors", "title", "text", "url", "labels", "hash"]
  for (const key of Object.keys(event)) if (!keys.includes(key)) problems.push(`${where} has the field "${key}", which the contract does not define`)
  for (const key of keys) if (!Object.hasOwn(event, key)) problems.push(`${where} has no "${key}"`)
  const e = event as Record<string, unknown>
  if (!line(e.source, EVENT_LIMITS.source) || !SOURCE_PATTERN.test(e.source)) problems.push(`${where}.source must be a lowercase name such as gmail`)
  if (!line(e.account, EVENT_LIMITS.account)) problems.push(`${where}.account must be a non-empty name of at most ${EVENT_LIMITS.account} characters`)
  if (!line(e.external_id, EVENT_LIMITS.externalId)) problems.push(`${where}.external_id must be a non-empty id of at most ${EVENT_LIMITS.externalId} characters`)
  if (!(EVENT_KINDS as readonly unknown[]).includes(e.kind)) problems.push(`${where}.kind must be one of ${EVENT_KINDS.join(", ")}`)
  if (typeof e.occurred_at !== "string" || !ISO_UTC.test(e.occurred_at) || !Number.isFinite(Date.parse(e.occurred_at))) {
    problems.push(`${where}.occurred_at must be a UTC ISO date-time ending in Z`)
  }
  if (e.thread !== null && !line(e.thread, EVENT_LIMITS.thread)) problems.push(`${where}.thread must be null or a non-empty id of at most ${EVENT_LIMITS.thread} characters`)
  if (!line(e.title, EVENT_LIMITS.title, true)) problems.push(`${where}.title must be one line of at most ${EVENT_LIMITS.title} characters`)
  if (!text(e.text, EVENT_LIMITS.text, true)) problems.push(`${where}.text must be at most ${EVENT_LIMITS.text} characters`)
  if (e.url !== null && (typeof e.url !== "string" || e.url.length > EVENT_LIMITS.url || !/^https:\/\/\S+$/.test(e.url))) problems.push(`${where}.url must be null or an https URL`)
  if (!Array.isArray(e.labels) || e.labels.length > EVENT_LIMITS.labels || e.labels.some((label) => !line(label, EVENT_LIMITS.label) || /\s/.test(label))) {
    problems.push(`${where}.labels must be at most ${EVENT_LIMITS.labels} labels of at most ${EVENT_LIMITS.label} characters without spaces`)
  } else if (new Set(e.labels).size !== e.labels.length) problems.push(`${where}.labels repeats a label`)
  if (!Array.isArray(e.actors) || e.actors.length > EVENT_LIMITS.actors) problems.push(`${where}.actors must be a list of at most ${EVENT_LIMITS.actors}`)
  else {
    const seen = new Set<string>()
    for (const [index, actor] of (e.actors as unknown[]).entries()) {
      const at = `${where}.actors[${index}]`
      if (!plainObject(actor)) {
        problems.push(`${at} is not an object`)
        continue
      }
      for (const key of Object.keys(actor)) if (!["role", "id", "name"].includes(key)) problems.push(`${at} has the field "${key}", which the contract does not define`)
      if (!line(actor.role, EVENT_LIMITS.actorRole) || !ROLE.test(actor.role)) problems.push(`${at}.role must be a lowercase word such as from`)
      if (!line(actor.id, EVENT_LIMITS.actorId) || !SCHEMED.test(actor.id)) problems.push(`${at}.id must be a scheme-qualified id such as mailto:someone@example.com`)
      if (actor.name !== undefined && !line(actor.name, EVENT_LIMITS.actorName)) problems.push(`${at}.name must be one non-empty line of at most ${EVENT_LIMITS.actorName} characters`)
      const key = `${String(actor.role)}\u0000${String(actor.id)}`
      if (seen.has(key)) problems.push(`${at} repeats an actor`)
      seen.add(key)
    }
  }
  if (typeof e.hash !== "string" || !HASH.test(e.hash)) problems.push(`${where}.hash must be sha256: and 64 hex digits`)
  else if (problems.length === 0) {
    const { hash, ...rest } = e as unknown as SourceEvent
    if (eventHash(rest) !== hash) problems.push(`${where}.hash is not the eventHash of its fields`)
  }
  return problems
}

/** A result's problems: its shape, every event, the order, the limit and the size. None when it keeps the contract. */
export function resultProblems(result: unknown, limit: number = PAGE.max): string[] {
  if (!plainObject(result)) return ["the result is not an object"]
  const problems: string[] = []
  const keys = ["source", "account", "owner", "events", "cursor", "more", "trust"]
  for (const key of Object.keys(result)) if (!keys.includes(key)) problems.push(`the result has the field "${key}", which the contract does not define`)
  const { source, account } = result
  const named = line(source, EVENT_LIMITS.source) && SOURCE_PATTERN.test(source)
  if (!named) problems.push("the result's source must be a lowercase name such as gmail")
  if (!line(account, EVENT_LIMITS.account)) problems.push(`the result's account must be a non-empty name of at most ${EVENT_LIMITS.account} characters`)
  const owner = result["owner"]
  if (!plainObject(owner) || !line(owner["id"], EVENT_LIMITS.ownerId) || !line(owner["label"], EVENT_LIMITS.ownerLabel) || Object.keys(owner).some((key) => key !== "id" && key !== "label")) {
    problems.push("the result's owner must be { id, label }, two non-empty lines")
  }
  const cursor = result["cursor"]
  if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > EVENT_LIMITS.cursor) problems.push(`the result's cursor must be a non-empty string of at most ${EVENT_LIMITS.cursor} characters`)
  if (typeof result["more"] !== "boolean") problems.push("the result's more must be true or false")
  if (result["trust"] !== TRUST) problems.push(`the result's trust must be "${TRUST}"`)
  const events = result["events"]
  if (!Array.isArray(events)) return [...problems, "the result's events must be a list"]
  if (events.length > limit) problems.push(`the result has ${events.length} events, over the limit of ${limit}`)
  for (const [index, event] of events.entries()) {
    problems.push(...eventProblems(event, `events[${index}]`))
    if (plainObject(event) && named && event["source"] !== source) problems.push(`events[${index}] names another source than the result`)
    if (plainObject(event) && typeof account === "string" && event["account"] !== account) problems.push(`events[${index}] names another account than the result`)
  }
  const times = events.map((event) => Date.parse(plainObject(event) ? String(event["occurred_at"]) : ""))
  if (times.some((time, index) => index > 0 && time < times[index - 1]!)) problems.push("the result's events are not oldest first")
  const ids = events.map((event) => (plainObject(event) ? `${String(event["source"])}:${String(event["account"])}:${String(event["external_id"])}` : ""))
  if (new Set(ids).size !== ids.length) problems.push("the result lists one event twice")
  const bytes = Buffer.byteLength(JSON.stringify(result))
  if (bytes > MAX_PAGE_BYTES) problems.push(`the result is ${bytes} bytes of JSON, over ${MAX_PAGE_BYTES}`)
  return problems
}

// ── Conformance ─────────────────────────────────────────────────────────

/** What a source's fixture holds, for `eventsListConformance`. */
export interface ConformanceFixtures {
  /** The `source` every result and event names. */
  readonly source: string
  /** The `account` every result and event names; also passed as the input's account when set. */
  readonly account?: string
  /** Pass `source` on every call, as a collector does for a plugin with several sources. */
  readonly sourceInput?: boolean
  /** The owner every result names. */
  readonly owner?: EventsOwner
  /** Passed as `since` on every call without a cursor. Every event must be at or after it. */
  readonly since?: string
  /** The external_ids a full listing from `since` yields, oldest first. At most `PAGE.max`. */
  readonly expected: readonly string[]
  /** The limit of the paged walk; 2 by default. */
  readonly pageSize?: number
}

export type EventsList = (input: EventsListInput) => Promise<unknown>

type Listed = { readonly result?: EventsListResult; readonly error?: unknown }

async function call(list: EventsList, input: EventsListInput): Promise<Listed> {
  try {
    return { result: (await list(input)) as EventsListResult }
  } catch (error) {
    return { error }
  }
}

const describeError = (error: unknown) => (error instanceof Error ? error.message.split("\n", 1)[0] : String(error))

/**
 * Every way `list` breaks the contract over `fixtures`, one sentence each; none when it keeps it. It lists everything
 * at once and page by page, checks each result, that the pages join up to exactly the expected events with nothing
 * repeated or skipped, that an earlier cursor lists the same page again, that the last cursor lists nothing, that every
 * result names the source and account, an empty first page included, that the owner, account and hashes hold steady,
 * and that a bad limit, a source the plugin does not have or a cursor it did not issue is refused. `list` runs the
 * source's events_list as its tool or RPC method does, input check included, over data that does not change.
 */
export async function eventsListConformance(list: EventsList, fixtures: ConformanceFixtures): Promise<string[]> {
  const problems: string[] = []
  const scope: EventsListInput = { ...(fixtures.account === undefined ? {} : { account: fixtures.account }), ...(fixtures.sourceInput ? { source: fixtures.source } : {}) }
  const base: EventsListInput = { ...(fixtures.since === undefined ? {} : { since: fixtures.since }), ...scope }
  const after = (cursor: string): EventsListInput => ({ cursor, ...scope })
  const pageSize = fixtures.pageSize ?? 2
  const since = fixtures.since === undefined ? undefined : sinceTime(fixtures.since)
  const owners = new Set<string>()
  const accounts = new Set<string>()
  const hashes = new Map<string, string>()

  const check = (listed: Listed, what: string, limit: number): EventsListResult | undefined => {
    if (listed.error !== undefined) {
      problems.push(`${what} failed: ${describeError(listed.error)}`)
      return undefined
    }
    const found = resultProblems(listed.result, limit)
    problems.push(...found.map((problem) => `${what}: ${problem}`))
    if (found.length > 0) return undefined
    const result = listed.result!
    if (result.source !== fixtures.source) problems.push(`${what}: the result names the source ${result.source}, not ${fixtures.source}`)
    if (fixtures.account !== undefined && result.account !== fixtures.account) problems.push(`${what}: the result names the account ${result.account}, not ${fixtures.account}`)
    accounts.add(result.account)
    owners.add(JSON.stringify(result.owner))
    if (fixtures.owner && JSON.stringify(result.owner) !== JSON.stringify({ id: fixtures.owner.id, label: fixtures.owner.label })) problems.push(`${what}: the owner is not the fixture's owner`)
    for (const event of result.events) {
      if (event.source !== fixtures.source) problems.push(`${what}: an event names the source ${event.source}, not ${fixtures.source}`)
      if (fixtures.account !== undefined && event.account !== fixtures.account) problems.push(`${what}: an event names the account ${event.account}, not ${fixtures.account}`)
      if (since !== undefined && Date.parse(event.occurred_at) < since) problems.push(`${what}: the event ${event.external_id} is from before since`)
      const known = hashes.get(event.external_id)
      if (known !== undefined && known !== event.hash) problems.push(`${what}: the event ${event.external_id} has another hash than before`)
      hashes.set(event.external_id, event.hash)
    }
    return result
  }
  const ids = (result: EventsListResult | undefined) => result?.events.map((event) => event.external_id) ?? []

  // Everything at once.
  const whole = check(await call(list, { ...base, limit: PAGE.max }), "one call with the largest limit", PAGE.max)
  if (whole) {
    if (JSON.stringify(ids(whole)) !== JSON.stringify(fixtures.expected)) problems.push(`one call with the largest limit lists [${ids(whole).join(", ")}], not [${fixtures.expected.join(", ")}]`)
    if (fixtures.expected.length <= PAGE.max && whole.more) problems.push("one call with the largest limit lists everything but says more")
  }

  // Page by page.
  const pages: EventsListResult[] = []
  let page = check(await call(list, { ...base, limit: pageSize }), "the first page", pageSize)
  const most = fixtures.expected.length + 10
  while (page) {
    pages.push(page)
    if (!page.more) break
    if (pages.length > most) {
      problems.push(`the paged walk did not end after ${most} pages`)
      break
    }
    page = check(await call(list, { ...after(page.cursor), limit: pageSize }), `page ${pages.length + 1}`, pageSize)
  }
  const walked = pages.flatMap(ids)
  if (JSON.stringify(walked) !== JSON.stringify(fixtures.expected)) problems.push(`the pages of ${pageSize} list [${walked.join(", ")}], not [${fixtures.expected.join(", ")}]`)

  // An earlier cursor lists the same page again.
  if (pages.length >= 2) {
    const again = check(await call(list, { ...after(pages[0]!.cursor), limit: pageSize }), "the first cursor again", pageSize)
    if (again && JSON.stringify(again.events) !== JSON.stringify(pages[1]!.events)) problems.push("the first cursor, used again, does not list the second page again")
  }

  // The last cursor lists nothing.
  const last = pages.at(-1)
  if (last && !last.more) {
    const end = check(await call(list, { ...after(last.cursor), limit: pageSize }), "the last cursor", pageSize)
    if (end && (end.events.length > 0 || end.more)) problems.push("the last cursor lists events again, or says more")
  }

  // An empty first page still names its source and account, so Memory can bind a source that has nothing yet.
  const empty = check(await call(list, { ...scope, since: "2999-01-01T00:00:00Z", limit: pageSize }), "an empty first page", pageSize)
  if (empty && (empty.events.length > 0 || empty.more)) problems.push("a first page from a since in the future lists events, or says more")

  if (owners.size > 1) problems.push("the owner changes between calls")
  if (accounts.size > 1) problems.push("the account changes between calls")

  // Refusals.
  const refused = async (input: EventsListInput, what: string) => {
    const listed = await call(list, input)
    if (listed.error === undefined) problems.push(`${what} was not refused`)
  }
  await refused({ ...base, limit: PAGE.max + 1 }, `a limit of ${PAGE.max + 1}`)
  await refused({ ...base, limit: 0 }, "a limit of 0")
  await refused({ ...after("not-a-cursor"), limit: pageSize }, "a malformed cursor")
  await refused({ ...after(encodeCursor(`${fixtures.source}-other`, {})), limit: pageSize }, "another source's cursor")
  await refused({ ...base, source: `${fixtures.source}-other`, limit: pageSize }, "a source the plugin does not have")
  return problems
}

/** `eventsListConformance`, for a test: throws one error that lists every problem. */
export async function assertEventsListConformance(list: EventsList, fixtures: ConformanceFixtures): Promise<void> {
  const problems = await eventsListConformance(list, fixtures)
  if (problems.length > 0) throw new Error(`events_list breaks the contract:\n- ${problems.join("\n- ")}`)
}
