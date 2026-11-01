import { Rpc } from "@opencode/plugin/rpc"
import type { Status } from "./status.js"

const text = { type: "string" } as const
const texts = { type: "array", items: text } as const
const object = (properties: Record<string, object>, required: readonly string[]) =>
  ({ type: "object", properties, required, additionalProperties: false }) as const

const status = object({
  state: { enum: ["connected", "not_signed_in", "connecting", "disabled", "failed", "not_registered", "no_client_id", "config_invalid", "host_untested"] },
  code: {
    enum: ["OPTIONS_INVALID", "SERVER_NAME_IN_USE", "HOST_UNTESTED", "CLIENT_ID_MISSING", "CLIENT_ID_INVALID", "AUTH_REQUIRED", "CONNECTION_FAILED", "SERVER_DISABLED"],
  },
  message: text,
  detail: text,
  next: text,
  server: object({ name: text, url: text }, ["name", "url"]),
  client: object({ id: text, mode: { enum: ["public_pkce", "confidential"] }, source: { enum: ["options", "connect"] } }, ["id", "mode", "source"]),
  callback: text,
  scopes: texts,
  asksBefore: texts,
  tools: object({
    read: { type: "integer" }, private: { type: "integer" }, file: { type: "integer" }, write: { type: "integer" }, unknown: texts,
  }, ["read", "private", "file", "write", "unknown"]),
  unguardedAgents: texts,
  host: object({ version: text, range: text, tested: { type: "boolean" } }, ["version", "range", "tested"]),
}, ["state", "message", "next", "server", "asksBefore", "tools", "unguardedAgents", "host"])

/** The status contract shared by the server, the TUI view and other clients. */
export const SlackRpc = Rpc.define({
  id: "slack.workspace",
  methods: {
    status: {
      input: object({}, []),
      output: status,
      errors: { unavailable: {} },
    },
  },
  events: {},
})

/** JSON Schema outputs reach clients unchecked, so readers confirm the fields they use. */
export function isStatus(value: unknown): value is Status {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Record<string, unknown>
  return status.required.every((key) => key in candidate)
    && typeof candidate.state === "string" && typeof candidate.message === "string" && typeof candidate.next === "string"
}
