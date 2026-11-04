// The input schema of each tool Slack's hosted MCP server lists, as OpenCode's catalog showed it on 2026-11-04 (a
// signed-in OpenCode 2.2.3, all 27 tools): every parameter, its type, its allowed values and whether it is required.
// Slack's descriptions are left out. The fake server serves these schemas, and docs.test.ts checks every parameter
// the skill and the docs name against them, so refresh this file whenever Slack changes a tool.

type Schema = Readonly<Record<string, unknown>>

const string = { type: "string" } as const
const integer = { type: "integer" } as const
const boolean = { type: "boolean" } as const
const object = { type: "object" } as const
const strings = { type: "array", items: string } as const
const oneOf = (...values: string[]) => ({ type: "string", enum: values })
const tool = (properties: Record<string, Schema>, required: string[]): Schema => ({ type: "object", properties, required })

const DETAIL = oneOf("detailed", "concise")
const SEARCH = {
  query: string,
  content_types: string,
  context_channel_id: string,
  cursor: string,
  limit: integer,
  after: string,
  before: string,
  include_bots: boolean,
  sort: oneOf("score", "timestamp"),
  sort_dir: oneOf("asc", "desc"),
  response_format: DETAIL,
  include_context: boolean,
  max_context_length: integer,
  only_my_channels: boolean,
}
const LIST_COLUMN_TYPES = [
  "text", "rich_text", "message", "link", "number", "date", "user", "attachment", "checkbox", "email", "phone", "channel",
  "rating", "created_by", "last_edited_by", "created_time", "last_edited_time", "vote", "assignee", "due_date", "completed",
  "select", "multi_select",
]
const column = (types: string[]) => ({
  type: "object",
  properties: { name: string, type: oneOf(...types), options: object },
  required: ["name", "type"],
})

export const SLACK_SCHEMAS: Readonly<Record<string, Schema>> = {
  slack_search_public: tool(SEARCH, ["query"]),
  slack_search_channels: tool({ query: string, channel_types: string, cursor: string, limit: integer, response_format: DETAIL, include_archived: boolean }, ["query"]),
  slack_search_users: tool({ query: string, cursor: string, limit: integer, response_format: DETAIL }, ["query"]),
  slack_read_channel: tool({ channel_id: string, limit: integer, cursor: string, latest: string, oldest: string, response_format: string }, ["channel_id"]),
  slack_read_thread: tool({ channel_id: string, message_ts: string, limit: integer, cursor: string, latest: string, oldest: string, response_format: string }, ["channel_id", "message_ts"]),
  slack_read_user_profile: tool({ user_id: string, include_locale: boolean, response_format: DETAIL }, []),
  slack_read_canvas: tool({ canvas_id: string }, ["canvas_id"]),
  slack_list_channel_members: tool({
    channel_id: string, limit: integer, cursor: string, response_format: oneOf("detailed", "concise", "ids_only"), include_deleted: boolean, include_bots: boolean,
  }, ["channel_id"]),
  slack_get_reactions: tool({ channel_id: string, message_ts: string }, ["channel_id", "message_ts"]),
  slack_list_user_channels: tool({ types: string, name_prefix: string, exclude_archived: boolean, limit: integer, cursor: string, format: string, team_id: string }, []),
  slack_read_list: tool({ list_id: string, list_title: string, format: oneOf("markdown", "csv"), limit: integer, cursor: string, schema_only: boolean }, []),
  slack_search_emojis: tool({ query: string }, ["query"]),
  slack_search_public_and_private: tool({ ...SEARCH, channel_types: string }, ["query"]),
  slack_read_file: tool({ file_id: string }, ["file_id"]),
  slack_send_message: tool({ channel_id: string, message: string, thread_ts: string, reply_broadcast: boolean, draft_id: string, unfurl_app_links: boolean }, ["channel_id", "message"]),
  slack_send_message_draft: tool({ channel_id: string, message: string, thread_ts: string }, ["channel_id", "message"]),
  slack_schedule_message: tool({ channel_id: string, message: string, post_at: integer, thread_ts: string, reply_broadcast: boolean }, ["channel_id", "message", "post_at"]),
  slack_create_canvas: tool({ title: string, content: string }, ["title", "content"]),
  slack_update_canvas: tool({
    canvas_id: string,
    sections: {
      type: "array",
      items: { type: "object", properties: { edit_type: oneOf("append", "prepend", "replace", "delete"), section_id: string, content: string }, required: ["edit_type"] },
    },
    action: oneOf("append", "prepend", "replace"),
    content: string,
    section_id: string,
  }, ["canvas_id"]),
  slack_add_reaction: tool({ channel_id: string, message_ts: string, emoji: string }, ["channel_id", "message_ts", "emoji"]),
  slack_get_file_upload_url: tool({ filename: string, content_length: integer, snippet_type: string, alt_txt: string }, ["filename", "content_length"]),
  slack_complete_file_upload: tool({ file_id: string, title: string, channel_id: string, thread_ts: string, initial_comment: string }, ["file_id"]),
  slack_create_conversation: tool({ user_ids: strings, channel_name: string, is_private: boolean }, []),
  slack_create_list: tool({
    name: string,
    description: string,
    columns: {
      type: "array",
      items: column(["text", "rich_text", "number", "currency", "rating", "select", "multi_select", "date", "user", "checkbox", "email", "phone", "channel", "attachment"]),
    },
  }, ["name"]),
  slack_update_list: tool({
    list_id: string,
    name: string,
    description: string,
    icon: string,
    columns_to_add: { type: "array", items: column(LIST_COLUMN_TYPES) },
    columns_to_update: {
      type: "array",
      items: { type: "object", properties: { key: string, name: string, type: oneOf(...LIST_COLUMN_TYPES), options: object }, required: ["key"] },
    },
    columns_to_delete: { type: "array", items: { type: "object", properties: { key: string }, required: ["key"] } },
  }, ["list_id"]),
  slack_add_list_record: tool({ list_id: string, columns: object }, ["list_id", "columns"]),
  slack_update_list_record: tool({ list_id: string, record_id: string, updated_columns: object }, ["list_id", "record_id", "updated_columns"]),
}

/** The parameter names of a tool's input. */
export const parameters = (name: string): string[] => Object.keys((SLACK_SCHEMAS[name]?.properties ?? {}) as object)
