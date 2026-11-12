import { SERVER } from "./defaults.js"
import { eventsError } from "./events.js"
import type { OwnedMethod } from "./host/tools-rpc.js"
import { STATUS_SCHEMA } from "./rpc.js"
import type { Status } from "./status.js"
import { STATUS_METHOD } from "./tools.js"

/**
 * `status` as a tools RPC method: the same status model as the `slack.workspace` RPC's `status`, the signed-in account
 * included, for a script that already speaks the tools RPC. Class `read`, with its own permission action, which the
 * default rules allow at every `access` value. It calls no Slack tool.
 */

export const STATUS_ACTION = `${SERVER}_${STATUS_METHOD}`

export function statusMethod(status: () => Promise<Status>): OwnedMethod {
  return {
    kind: "plugin",
    class: "read",
    name: STATUS_METHOD,
    action: STATUS_ACTION,
    description: "The plugin's status, with the signed-in Slack workspace and user.",
    input: { type: "object", additionalProperties: false, properties: {} },
    output: STATUS_SCHEMA,
    run: async (input) => {
      if (typeof input !== "object" || input === null || Array.isArray(input) || Object.keys(input).length > 0) {
        throw eventsError("INPUT_INVALID", "The status input is invalid: it takes no fields.", "Pass an empty object as the input.")
      }
      return status()
    },
  }
}

export { STATUS_METHOD }
