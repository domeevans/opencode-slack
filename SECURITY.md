# Security

## Supported versions

Fixes go into the newest release only.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: on this repository, open **Security → Report a vulnerability**. Do not open a public issue. Include the plugin version, the OpenCode version and the steps to reproduce. Do not include tokens, client secrets or Slack content.

## Data handling

### What the plugin does

The plugin is configuration and status code. It makes no network requests, defines no tools and never reads your Slack tokens. When OpenCode loads it, it:

- adds Slack's hosted MCP server, `https://mcp.slack.com/mcp`, to OpenCode with your Slack app's OAuth client;
- without `oauth.client_id` in its options, adds **Slack app client ID** to `/connect` and reads that entry (the client ID and an optional client secret) from OpenCode's credential store;
- adds the default rules to each agent: at the default `access: "all"` every Slack tool is allowed;
- registers `/slack-status`, the status RPC, the tools RPC for scripts, the TUI `/slack` dialog and the `slack-search` skill.

OpenCode does everything else. It connects to Slack over HTTPS, runs the OAuth sign-in (PKCE for public apps), stores the credential outside your project config, refreshes it, and asks before tool calls according to your permission rules. `opencode mcp logout slack` deletes the Slack sign-in, and `opencode auth logout slack-app` deletes the saved client.

The client ID is public. A client secret is needed only for apps without PKCE. Give it in the `/connect` **Slack app client ID** entry, where OpenCode stores it in its credential store (the field is not masked while you type), or through `{env:NAME}` in the options; never as text in a config file. Status reports only that a secret is set, never its value.

### Data flow

- **To Slack:** each tool call with the arguments the agent chose, sent with your Slack user token. OpenCode also sends the session ID in the call's `_meta["ai.opencode/sessionID"]` field. The session ID is an opaque correlation value, not a credential, and Slack may log or keep it.
- **To your model provider:** the Slack tool descriptions and schemas the agent looks up, and every Slack result the agent reads: messages, threads, profiles, canvases and files. Slack's tool descriptions include the signed-in user's Slack user ID, so the provider receives that ID too.
- **On your machine:** OpenCode keeps session history, including Slack results. When a tool result exceeds the output limit (by default 2,000 lines or 50 KiB), OpenCode shortens it for the model and saves the full text locally.
- **At Slack:** Slack records MCP activity in its [audit logs](https://docs.slack.dev/reference/audit-logs-api/methods-actions-reference#mcp-server), which workspace admins can review.

Your Slack token acts as you. Agents can reach everything that you can see and that the granted scopes allow. The default scopes are read-only and cover public channels and user profiles. Add more scopes only when you need them: with private-history scopes, the read tools read private channels and direct messages without asking (see the README's [Permissions](https://github.com/joe-broadhead/opencode-slack/blob/HEAD/README.md#permissions)).

### Slack content is untrusted

Other people write Slack messages, files, canvases, profiles and channel topics. They can contain text that tries to direct an agent (prompt injection). The `slack-search` skill tells agents to treat Slack content as data and never follow instructions in it. That reduces the risk but does not remove it.

**Every tool is allowed by default.** Nothing asks before a covered agent reads a private channel or a file, or sends a message, posts in a channel, starts a direct message, creates a canvas or a list, reacts, or uploads a file. Injected text in a Slack message or file can therefore make the agent do any of those as you: the skill's instruction to treat Slack content as data reduces the risk but does not stop it. Everything an agent reads reaches your model provider, and with Code Mode one program can make many calls.

To restrict it in one line, set the plugin's `access` option to `"ask-changes"` (the private-channel search, file reads, writes and sends ask first) or `"read-only"` (they are denied). A later rule in an agent's own `permissions` or in your top-level `permissions` can also ask or deny any tool, such as `{ "action": "slack_slack_send_message", "resource": "*", "effect": "deny" }`. See the README's [Permissions](https://github.com/joe-broadhead/opencode-slack/blob/HEAD/README.md#permissions).

## Permissions

- **Some agents get no default rules.** Agents defined only in your config (non-built-in `agents.<id>` entries and Markdown agent files), and agents added by plugins that load after this one, are created after the plugin adds its rules. They run Slack tools under OpenCode's own default rather than this plugin's block, so they may run a write without asking even when you set a restricted `access`. `/slack-status` lists them in its `Agents without default rules` row. The [README](https://github.com/joe-broadhead/opencode-slack/blob/HEAD/README.md#agents-without-the-default-rules) gives the fix: put the default block first in that agent's own `permissions`, followed by your top-level rules for Slack actions. Never put the block in the top-level `permissions`, where it would loosen Explore.
- **Saved approvals are project-wide.** An "Always allow" answer is saved for the whole project and applies to every agent in it, Plan included. A directory with no git commit belongs to OpenCode's shared `global` project, so an approval saved there applies in every such directory. Review saved approvals and remove the ones you no longer need.
- **The `slack_*` rule matches other servers.** The plugin's catch-all rule also matches tools of any other MCP server whose name starts with `slack_`. Those tools then ask instead of running. The rule never allows them.
- **Deny is final.** A configured `deny` rule wins over every `ask`, `allow` and saved approval. Use `deny` for anything that must never run, including in non-interactive runs, because a client that approves prompts automatically still cannot pass a deny.
- **Approval is not a Slack permission.** Approving a write in OpenCode does not grant its Slack scope. Without the scope, the call fails at Slack.

## Scripts

The tools RPC (`slack.workspace.tools`, see [docs/scripting.md](https://github.com/joe-broadhead/opencode-slack/blob/HEAD/docs/scripting.md)) runs every Slack tool this plugin knows for a script, with no model. It adds no authority:

- A script names a session that names an agent, and runs as them. The rule for the tool's permission action is resolved before it runs, in OpenCode's own order (the agent's rules, then the session's, the last match winning). Only an `allow` runs; an `ask` and a `deny` are refused with no tool call.
- **A script gets the same default as the model:** at `access: "all"` the plugin's block allows every tool, so a script can read and write everything the account can. Under `"ask-changes"` or `"read-only"`, or with a later rule, a write or private read is refused. An ask is refused, not prompted: no one is there to answer it. A saved "Always allow" approval is not part of the agent's and the session's rules, so it does not authorize an ad-hoc script. The plugin's permission hook changes only an ask on one of its own script calls in flight, only to a deny, and leaves every other call alone.
- Every known tool is a method, with its class (read, send or write) shown by `describe`. A tool that Slack adds later is not a method until this plugin classifies it.
- OpenCode's own executor then checks the call against the agent's rules, the session's rules and saved approvals, as it does for the model, and runs it through OpenCode's own MCP connection and sign-in. The plugin never sees the Slack token, and returns none.
- Slack's error text reaches the script only as the first line, at most 300 characters, with tokens and URL query strings removed. Results are Slack content, which is untrusted, as for the model.
- OpenCode's `execute.before` and `execute.after` tool hooks, from any plugin, do not run for a script's call, so another plugin's policy hook does not see it. Slack's model path has no such hook either, so a script sees what a direct model call would. A script's calls are not recorded in the session; Slack records them in its audit logs.
- The RPC is reachable only by callers of the OpenCode server API, who already hold the server's full authority. The session is not a login: it scopes a script to what its agent may do.
