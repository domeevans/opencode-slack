# Scripting

Unofficial plugin. Not affiliated with Slack.

A script can call every Slack tool this plugin knows, with no model: a cron job, a shell script, or any program that can reach the OpenCode server. It uses the tools RPC, `slack.workspace.tools`, through `opencode api` or an OpenCode client.

| Class | Methods |
| --- | --- |
| read | `slack_search_public`, `slack_search_channels`, `slack_search_users`, `slack_read_channel`, `slack_read_thread`, `slack_read_user_profile`, `slack_read_canvas`, `slack_list_channel_members`, `slack_get_reactions`, `slack_list_user_channels`, `slack_read_list`, `slack_search_emojis`, `slack_search_public_and_private`, `slack_read_file` |
| send | `slack_send_message`, `slack_send_message_draft`, `slack_schedule_message` |
| write | `slack_create_canvas`, `slack_update_canvas`, `slack_add_reaction`, `slack_get_file_upload_url`, `slack_complete_file_upload`, `slack_create_conversation`, `slack_create_list`, `slack_update_list`, `slack_add_list_record`, `slack_update_list_record` |
| `describe` | not a tool: lists the methods, their classes and permission actions, whether OpenCode lists each tool now, each tool's input as JSON Schema, and — with a session — that session's permission for each |

The class is the worst thing a tool can do. It never decides whether a call runs: the rules do. It is what `describe` reports and what a job's approval shows.

Each method's permission action is the tool name with the server's prefix, `slack_`, for example `slack_slack_search_public`. Each method runs the tool with the same input: Slack's own tool, through OpenCode's own connection and sign-in. The plugin never sees the Slack token. A tool Slack adds later is not a method until it is classified in this plugin's table; `describe` lists it under `unclassified`, and `/slack-status` names it.

The tools RPC is registered only when the plugin is set up. With invalid options or an OpenCode version outside the supported range, OpenCode answers `rpc.unavailable`, and `/slack-status` names the problem.

## A script runs as a session

Every call names a session, and the session must name an agent. The script runs as that agent, under the agent's rules and then the session's, in OpenCode's own order: the last rule that matches the tool's permission name on resource `*` wins.

- The rule is resolved **before** the tool runs. Only an `allow` runs. An `ask` is refused, because no one can answer a prompt for a script. A `deny` is refused.
- OpenCode then checks the call itself, as it does for the model: the agent's rules, the session's rules, then saved approvals.
- The plugin's default rules allow the twelve reads and ask for everything else, so a script needs an allow rule for the private search, the file read and every write and send.

Session rules come after the agent's, so a session can narrow or widen what its script may do. This one may send messages as well as read:

```sh
opencode api post /api/session -d '{"title":"release digest","agent":"build","permissions":[
  {"action":"slack_slack_send_message","resource":"*","effect":"allow"}
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

**A saved "Always allow" approval does not authorize an ad-hoc script.** It lives outside the agent's and the session's rules, so the resolve refuses an `ask` even after a past approval. That is deliberate: a script's permission must be reviewable in config, not in a list of past clicks. A script's grant is a rule in the agent's or the session's config, or a Jobs run session. For a one-off that needs an approval-bound grant, use Jobs's `jobs_run_script`: the user reads the source and the tools once, and approves it.

Create the session once, with the agent the script runs as, and keep its id. Use a session created for the script, also to test it: a session you borrow, such as one found in your session history, runs the script as its own agent, under its rules.

```sh
opencode api post /api/session -d '{"title":"release digest","agent":"build"}'
```

## Calling a method

The body is `{"input": {"sessionID": "<session>", "input": <the tool's input>}}`. Both keys are required, and no other key is allowed:

```sh
opencode api post /api/rpc/slack.workspace.tools/slack_search_public \
  -H "x-opencode-directory:$PWD" -d '{"input":{
  "sessionID":"ses_…",
  "input":{"query":"launch date in:#release","limit":10}
}}'
```

**Send the call to the location you mean.** Without the header the call goes to the OpenCode service's default location, and fails `rpc.unavailable` when the plugin is not loaded there. The HTTP equivalents are the `location[directory]` query parameter and the same header.

The tool's input is Slack's: `describe` shows each tool's schema as OpenCode lists it now.

```sh
opencode api post /api/rpc/slack.workspace.tools/describe \
  -H "x-opencode-directory:$PWD" -d '{"input":{}}'
```

`describe` takes nothing, or a session to resolve each method's permission for:

```sh
opencode api post /api/rpc/slack.workspace.tools/describe \
  -H "x-opencode-directory:$PWD" -d '{"input":{"sessionID":"ses_…"}}'
```

A result is `{"output": {"output": <the tool's structured content, or its text when it has none>, "text": <the tool's text>}}`, as plain JSON. Slack content in it is untrusted data: other people wrote it.

Slack's model path has no `execute.before` or `execute.after` hook, so a script's arguments and results are exactly a direct model call's.

`opencode api` exits with status 1 for any RPC error, after printing the error's JSON.

## Errors

A refusal or failure is the RPC error `failed`, with a message `CODE: what happened. Next step: what to do.` and `data: { code, next }`.

| Code | When |
| --- | --- |
| `SESSION_UNKNOWN` | OpenCode says the session does not exist in this location. Any other failure to look the session up is OpenCode's own error. |
| `SESSION_AGENT_REQUIRED` | The session names no agent, or an agent that does not exist. |
| `PERMISSION_DENIED` | The rules ask or deny. An `ask` is refused before dispatch: the message says the action would ask, and the next step says to add an allow rule. A `deny` names the action and the agent: remove or narrow the deny rule, add a later allow rule to the session, or use a session whose agent allows it. A refused check of an inner action, such as a later call the tool makes, names that action too. |
| `SERVER_CONFLICT` | Your OpenCode config defines its own server named `slack`, which this plugin does not manage (`SERVER_NAME_IN_USE` in `/slack-status`). Remove `mcp.servers.slack` from your OpenCode config. |
| `CLIENT_ID_MISSING`, `CLIENT_ID_INVALID` | No Slack app client ID is set, or the one saved in `/connect` is empty or has spaces, so the plugin added no Slack server. The next step is the one `/slack-status` gives: run `/connect`, choose **Slack app client ID** and paste the client ID. A client ID saved in `/connect` applies to the next call. `describe` gives the same code as each method's `reason`. |
| `AUTH_REQUIRED`, `CONNECTING`, `CONNECTION_FAILED`, `DISABLED`, `NOT_REGISTERED` | The Slack server needs a sign-in, is still connecting (also when it reconnected during the call), could not connect, is disabled, or is not registered although a client ID is set. `/slack-status` gives the details. |
| `TOOL_UNAVAILABLE` | The server is connected, but OpenCode does not list the tool. |
| `UPSTREAM_ERROR` | Slack answered with an error, such as a missing scope or an invalid input. The message holds the first line of Slack's text, at most 300 characters, with tokens and URL query strings removed. |
| `CANCELLED` | The request was cancelled. |

OpenCode itself answers `rpc.invalid_input` for a body that is not the envelope above, with one message per problem, such as `"extra" is not allowed`, `"sessionID" must be a non-empty string` or `"input" is missing` (and `describe takes nothing, or {"sessionID":"<session>"}` for a describe call with anything else), `rpc.method_not_found` for a method that does not exist, such as a tool Slack adds later, and `rpc.unavailable` when the plugin did not register the tools RPC or the call reached another location.

## What scripts cannot do

- Call a tool that Slack adds later, even with an allow rule, until this plugin classifies it.
- Answer an approval prompt: an `ask` is refused. The private search, the file read and every write and send need a prior allow rule.
- Rely on a past "Always allow": it does not authorize an ad-hoc script.
- Use a token: the plugin has none to give.

A script's calls write nothing to the session, and OpenCode's `execute.before` and `execute.after` tool hooks, from any plugin, do not run for them. Slack still records them in its audit logs, as it does for the model's calls.
