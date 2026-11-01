import { expect, test } from "bun:test"
import { classify, READ_TOOLS, type ToolClass } from "../../src/tools.js"

// Every entry of the classification table. A change to src/tools.ts must change this list too.
const TABLE: readonly (readonly [string, Exclude<ToolClass, "unknown">])[] = [
  ["slack_search_public", "read"],
  ["slack_search_channels", "read"],
  ["slack_search_users", "read"],
  ["slack_read_channel", "read"],
  ["slack_read_thread", "read"],
  ["slack_read_user_profile", "read"],
  ["slack_read_canvas", "read"],
  ["slack_list_channel_members", "read"],
  ["slack_get_reactions", "read"],
  ["slack_list_user_channels", "read"],
  ["slack_read_list", "read"],
  ["slack_search_emojis", "read"],
  ["slack_search_public_and_private", "private"],
  ["slack_read_file", "file"],
  ["slack_send_message", "write"],
  ["slack_send_message_draft", "write"],
  ["slack_schedule_message", "write"],
  ["slack_create_canvas", "write"],
  ["slack_update_canvas", "write"],
  ["slack_add_reaction", "write"],
  ["slack_get_file_upload_url", "write"],
  ["slack_complete_file_upload", "write"],
  ["slack_create_conversation", "write"],
  ["slack_create_list", "write"],
  ["slack_update_list", "write"],
  ["slack_add_list_record", "write"],
  ["slack_update_list_record", "write"],
]

test.each(TABLE)("%s is %s", (tool, toolClass) => {
  expect(classify(tool)).toBe(toolClass)
})

test.each([
  "slack_brand_new_tool",
  "slack_delete_message",
  "search_public",
  "SLACK_SEARCH_PUBLIC",
  "slack_slack_search_public",
  "",
  "constructor",
  "toString",
  "__proto__",
  "hasOwnProperty",
])("%p is unknown", (tool) => {
  expect(classify(tool)).toBe("unknown")
})

test("READ_TOOLS lists exactly the read entries, in table order", () => {
  expect(READ_TOOLS).toEqual(TABLE.filter(([, toolClass]) => toolClass === "read").map(([tool]) => tool))
})
