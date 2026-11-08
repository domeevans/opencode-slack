# Scripting

Unofficial plugin. Not affiliated with Slack.

A script can call Slack's read tools with no model: a cron job, a shell script, or any program that can reach the OpenCode server. It uses the tools RPC, `slack.workspace.tools`, through `opencode api` or an OpenCode client.

| Method | The tool | Default rule |
| --- | --- | --- |
| `slack_search_public`, `slack_search_channels`, `slack_search_users`, `slack_read_channel`, `slack_read_thread`, `slack_read_user_profile`, `slack_read_canvas`, `slack_list_channel_members`, `slack_get_reactions`, `slack_list_user_channels`, `slack_read_list`, `slack_search_emojis` | `slack_<method>`, for example `slack_slack_search_public` | allow |
| `slack_search_public_and_private` | `slack_slack_search_public_and_private` | ask: refused to scripts until an allow rule exists |
| `slack_read_file` | `slack_slack_read_file` | ask: refused to scripts until an allow rule exists |
| `events_list` | `slack_events_list`: the messages posted since a cursor in the channels of the `events.channels` option, as Memory's events ([configuration](configuration.md#events-list)) | allow |
| `describe` | none: lists the methods, their permission actions, whether OpenCode lists each tool now, and each tool's input as JSON Schema | |

Each method's permission action is the tool name with the server's prefix, `slack_`, for example `slack_slack_search_public`.

`events_list` is the plugin's own read for Memory's collector. It runs `slack_events_list`'s own spec as the session and its agent: it asserts `slack_events_list`, then reads `slack_read_user_profile` and `slack_read_channel` through OpenCode's executors, so each read's rules apply. Its own refusals, such as a cursor from another workspace, are the codes in the configuration guide's [Errors](configuration.md#errors); a refused read is `PERMISSION_DENIED` naming that read.

Each method runs the tool with the same input: Slack's own tool, through OpenCode's own connection and sign-in. The plugin never sees the Slack token. Only these fourteen reads are methods. Slack's writes and sends (`slack_send_message`, `slack_send_message_draft`, `slack_schedule_message`, `slack_create_canvas`, `slack_update_canvas`, `slack_add_reaction`, `slack_get_file_upload_url`, `slack_complete_file_upload`, `slack_create_conversation`, `slack_create_list`, `slack_update_list`, `slack_add_list_record`, `slack_update_list_record`) and any tool Slack adds later are never methods, even with an allow rule.

The tools RPC is registered only when the plugin is set up. With invalid options or an OpenCode version outside the supported range, OpenCode answers `rpc.unavailable`, and `/slack-status` names the problem.

## A script runs as a session

Every call names a session, and the session must name an agent. The script runs as that agent, with exactly the access its model would have:

- A tool that the agent's rules or the session's rules hide from the model is refused. OpenCode hides a tool when the last rule that matches its permission name, such as `slack_slack_search_public`, on resource `*` is a `deny`.
- OpenCode then checks the call itself, as it does for the model: the agent's rules, the session's rules, then saved approvals.
- No one answers a prompt for a script, so an `ask` is refused with `PERMISSION_DENIED` at once, and no prompt is left waiting. The plugin's default rules allow the twelve reads, so an agent with the default rules needs nothing more for them. The private search and the file read ask by default, so a script needs an allow rule for them.

Create the session once, with the agent the script runs as, and keep its id. Use a session created for the script, also to test it: a session you borrow, such as one found in your session history, runs the script as its own agent, under its rules.

```sh
opencode api post /api/session -d '{"title":"release digest","agent":"build"}'
```

Session rules come after the agent's, so a session can narrow or widen what its script may do. This one may also search private channels and direct messages, and read files:

```sh
opencode api post /api/session -d '{"title":"release digest","agent":"build","permissions":[
  {"action":"slack_slack_search_public_and_private","resource":"*","effect":"allow"},
  {"action":"slack_slack_read_file","resource":"*","effect":"allow"}
]}'
```

This one may only read threads and channels:

```sh
opencode api post /api/session -d '{"title":"release digest","agent":"build","permissions":[
  {"action":"slack_*","resource":"*","effect":"deny"},
  {"action":"slack_slack_read_thread","resource":"*","effect":"allow"},
  {"action":"slack_slack_read_channel","resource":"*","effect":"allow"}
]}'
```

A saved "Always allow" approval for a tool also lets a script use it, because OpenCode checks saved approvals.

## Calling a method

The body is `{"input": {"sessionID": "<session>", "input": <the tool's input>}}`. Both keys are required, and no other key is allowed:

```sh
opencode api post /api/rpc/slack.workspace.tools/slack_search_public -d '{"input":{
  "sessionID":"ses_…",
  "input":{"query":"launch date in:#release","limit":10}
}}'
```

The tool's input is Slack's: `describe` shows each tool's schema as OpenCode lists it now.

```sh
opencode api post /api/rpc/slack.workspace.tools/describe -d '{"input":{}}'
```

A result is `{"output": {"output": <the tool's structured content, or its text when it has none>, "text": <the tool's text>}}`, as plain JSON. Slack content in it is untrusted data: other people wrote it.

`opencode api` calls run in the OpenCode service's default location, your home directory, whatever directory you run them from, and use that location's Slack connection. To target a project, call the HTTP API with `?location[directory]=<dir>`, or create the session with `"location":{"directory":"<dir>"}`. The session may belong to another directory.

`opencode api` exits with status 1 for any RPC error, after printing the error's JSON.

## Errors

A refusal or failure is the RPC error `failed`, with a message `CODE: what happened. Next step: what to do.` and `data: { code, next }`.

| Code | When |
| --- | --- |
| `SESSION_UNKNOWN` | OpenCode says the session does not exist. Any other failure to look the session up is OpenCode's own error. |
| `SESSION_AGENT_REQUIRED` | The session names no agent, or an agent that does not exist. |
| `PERMISSION_DENIED` | The agent's or the session's rules deny the tool, or ask for an approval. The message names the action whose check was refused. For a deny, the next step names that action and the agent: remove or narrow the deny rule, add a later allow rule to the session, or use a session whose agent allows it. For an ask, it says to add an allow rule. |
| `SERVER_CONFLICT` | Your OpenCode config defines its own server named `slack`, which this plugin does not manage (`SERVER_NAME_IN_USE` in `/slack-status`). Remove `mcp.servers.slack` from your OpenCode config. |
| `CLIENT_ID_MISSING`, `CLIENT_ID_INVALID` | No Slack app client ID is set, or the one saved in `/connect` is empty or has spaces, so the plugin added no Slack server. The next step is the one `/slack-status` gives: run `/connect`, choose **Slack app client ID** and paste the client ID. A client ID saved in `/connect` applies to the next call. `describe` gives the same code as each method's `reason`. |
| `AUTH_REQUIRED`, `CONNECTING`, `CONNECTION_FAILED`, `DISABLED`, `NOT_REGISTERED` | The Slack server needs a sign-in, is still connecting (also when it reconnected during the call), could not connect, is disabled, or is not registered although a client ID is set. `/slack-status` gives the details. |
| `TOOL_UNAVAILABLE` | The server is connected, but OpenCode does not list the tool. |
| `UPSTREAM_ERROR` | Slack answered with an error, such as a missing scope or an invalid input. The message holds the first line of Slack's text, at most 300 characters, with tokens and URL query strings removed. |
| `CANCELLED` | The request was cancelled. |

OpenCode itself answers `rpc.invalid_input` for a body that is not the envelope above, with one message per problem, such as `"extra" is not allowed`, `"sessionID" must be a non-empty string` or `"input" is missing` (and `describe takes no input` for a `describe` call with input), `rpc.method_not_found` for a method that does not exist, such as `slack_send_message`, and `rpc.unavailable` when the plugin did not register the tools RPC.

## What scripts cannot do

- Send, draft, schedule, react, upload, or create or change canvases, lists or conversations: Slack's writes are never methods.
- Call a tool that Slack adds later, even with an allow rule.
- Answer an approval prompt, or use a tool that asks, including the private search and the file read without an allow rule.
- Use a token: the plugin has none to give.

A script's calls write nothing to the session, and OpenCode's `execute.before` and `execute.after` tool hooks, from any plugin, do not run for them. Slack still records them in its audit logs, as it does for the model's calls.
