# Configuration

This page lists every option of the Slack plugin, where the Slack app client ID comes from, what the plugin registers with OpenCode, the permission rules it adds, the Slack scopes, and the status model with its error codes. For setup from zero, start with the [README](../README.md).

## Options

Every option is optional. Pass options in the object form of a `plugins` entry:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:joe-broadhead/opencode-slack#v0.0.0",
      "options": {
        "oauth": {
          "client_id": "YOUR_SLACK_CLIENT_ID",
          "redirect_uri": "http://localhost:8765/callback",
          "scopes": ["channels:history", "channels:read", "search:read.public", "users:read"],
          "client_secret": "{env:SLACK_CLIENT_SECRET}"
        },
        "allowUntestedHost": false
      }
    }
  ]
}
```

| Option | Default | Rule |
| --- | --- | --- |
| `oauth.client_id` | Not set: the client ID saved in the `/connect` Slack app client ID entry is used | A non-empty string without spaces. The client ID is public. Find it under **Basic Information → App Credentials** in your Slack app. When set, it wins over `/connect`, and `/connect` shows no Slack app entry. |
| `oauth.redirect_uri` | `http://localhost:8765/callback` | Either a loopback `http:` URL on host `localhost` or `127.0.0.1` with an explicit port, or an `https:` URL on any host. Both need a path, and neither may have a user name, password, query or fragment. It must exactly match a redirect URL registered in the Slack app. See [The callback: loopback or hosted](#the-callback-loopback-or-hosted). |
| `oauth.callback_port` | Not set | A whole number from 1 to 65535: the port of OpenCode's local callback listener on `127.0.0.1`. Required with an `https:` `oauth.redirect_uri`, and refused with a loopback one, whose own port is the listener's. |
| `oauth.scopes` | `["channels:history", "channels:read", "search:read.public", "users:read"]` | A non-empty list of unique Slack user scopes, each without spaces. Your list replaces the default list. See [Scopes](#scopes). |
| `oauth.client_secret` | Not set (public client with PKCE) | A non-empty string, and only together with `oauth.client_id`. Set it only for a Slack app that does not use PKCE, and only through `{env:NAME}`. See [Client secret](#client-secret). |
| `allowUntestedHost` | `false` | `true` or `false`. If it is `true`, the plugin runs on an OpenCode version outside its supported range, and status keeps warning. See [Host check](#host-check). |
| `access` | `"all"` | `"all"`, `"ask-changes"` or `"read-only"`. It generates the default rules: every tool allowed, the reads allowed and the rest asking, or the reads allowed and the rest denied. See [The access option](#the-access-option). |
| `events.channels` | `[]`: none | At most 16 unique Slack ids: channels (`C…`), private channels and group messages (`G…`), direct messages (`D…`), or users whose direct messages to read (`U…`, `W…`). Only these conversations are listed by `slack_events_list` for Memory's collector. See [Events list](#events-list). |

Unknown keys are rejected, at the top level and inside `oauth`.

The MCP server is always named `slack`. That name is the prefix of every Slack tool name and permission action (`slack_<tool>`, for example `slack_slack_send_message`) and the Code Mode namespace (`tools.slack`).

### The callback: loopback or hosted

After Slack approves a sign-in, it sends the browser to `oauth.redirect_uri` with a one-time code. OpenCode takes the code on a listener at `127.0.0.1`, on the path of `oauth.redirect_uri`, and only while a sign-in waits.

- **Loopback, the default:** `http://localhost:<port>/<path>` or `http://127.0.0.1:<port>/<path>`. OpenCode listens on that port. This works when the browser runs on the same machine as OpenCode. Leave `oauth.callback_port` unset: with a loopback redirect it is refused, because OpenCode would listen on one port while Slack sends the browser to another.
- **Hosted:** when OpenCode runs on another machine, such as a server, a container or a remote workspace, the browser cannot reach that machine's loopback. Set `oauth.redirect_uri` to an `https:` address the browser can reach, and `oauth.callback_port` to a free local port. A reverse proxy on OpenCode's machine forwards the address, with its path and query unchanged, to `http://127.0.0.1:<callback_port><path>`.

  ```jsonc
  "oauth": {
    "client_id": "YOUR_SLACK_CLIENT_ID",
    "redirect_uri": "https://host.example/oauth/return",
    "callback_port": 8766
  }
  ```

  The proxy then forwards `https://host.example/oauth/return?code=…&state=…` to `http://127.0.0.1:8766/oauth/return?code=…&state=…`. Status shows both in its `Callback` row.

Whichever you use, add it to the Slack app's redirect URLs: see [Create the Slack app](#create-the-slack-app). Slack matches the host and port exactly, so register the address as the browser reaches it, path included.

**Two sign-ins at once.** The listener holds its port while a sign-in waits. Two OpenCode processes on one machine that sign in at the same time with the default `http://localhost:8765/callback` collide, and the second sign-in fails because the port is in use. Finish one sign-in first, or give each process its own callback: another loopback port, such as `http://localhost:8767/callback`, or its own hosted address with its own `oauth.callback_port`. Register each one in the Slack app.

### Where the client ID comes from

Slack has no dynamic client registration, so OpenCode signs in with one fixed Slack app. No client ID ships with the plugin. It takes the client ID from the first of:

1. `oauth.client_id` in the plugin options, for example from an organisation's [managed config](../README.md#organisation-rollout);
2. the **Slack app client ID** entry in `/connect` (`opencode auth login slack-app` in a terminal). It is a key method: the key is the client ID, and an optional form field holds the client secret for an app without PKCE. OpenCode keeps both in its credential store. Saving, switching or removing the entry takes effect without a restart. An entry that is empty or has spaces is reported as `CLIENT_ID_INVALID`, and `/connect` marks it as needing sign-in.

Without a client ID, the plugin adds no Slack server, and status shows `not configured` with the code `CLIENT_ID_MISSING` and the next step `Run /connect and choose Slack app client ID, then paste your Slack app's client ID.`

### Validation errors

The plugin checks the options when OpenCode loads it. Invalid options never stop OpenCode. The plugin then registers only `/slack-status`, the TUI view and the status RPC. They show the connection `not configured` with the code `OPTIONS_INVALID`, the message `Option <field>: <message>` and one next step. Messages name the field and never repeat its value. Status reports invalid options before an untested OpenCode version, because they need fixing on any version.

The checks run in this order, and status reports only the first problem:

| Field | Message | Next step |
| --- | --- | --- |
| `options` | Plugin options must be an object. | Set options to an object, or remove them. |
| any other top-level key | This option is not supported. | Remove it. Supported options: oauth, allowUntestedHost. |
| `oauth` | Must be an object. | Set oauth to an object such as `{ "client_id": "..." }`. |
| any other `oauth` key | This option is not supported. | Remove it. Supported oauth options: client_id, redirect_uri, callback_port, scopes, client_secret. |
| `oauth.client_id` | Must be a non-empty string without spaces. | Copy the client ID from the Basic Information page of your Slack app. |
| `oauth.redirect_uri` | Must be a string. / Must be a valid URL. / Must use http: or https:. / An http: URL must use the host localhost or 127.0.0.1. / An http: URL must include an explicit port. / Must not include credentials. / Must not include a query or fragment. / Must include a path, such as /callback. | Use a URL listed in the app's Redirect URLs, for example `http://localhost:8765/callback` or `https://host.example/oauth/return`. |
| `oauth.callback_port` | Must be a whole number from 1 to 65535. | Set it to the local port that receives the forwarded callback, for example 8766. |
| `oauth.callback_port` | Applies only to an https: oauth.redirect_uri. | Remove it: with a loopback oauth.redirect_uri, OpenCode listens on that URL's port. |
| `oauth.callback_port` | Must be set with an https: oauth.redirect_uri. | Set it to the local port your proxy forwards the redirect to, for example 8766. |
| `oauth.scopes` | Must be a non-empty list of scope names without spaces. | List Slack user scopes, for example `["channels:history","channels:read","search:read.public","users:read"]`. |
| `oauth.scopes` | Lists a scope more than once. | Remove the duplicate scope. |
| `oauth.client_secret` | Must be a non-empty string. | Set it to `{env:SLACK_CLIENT_SECRET}` and export that variable, or remove it to use PKCE. |
| `oauth.client_secret` | Needs oauth.client_id. | Set oauth.client_id to your Slack app's client ID, or remove oauth.client_secret. |
| `allowUntestedHost` | Must be true or false. | Set it to true only to run on an OpenCode version outside the supported range. |
| `events` | Must be an object. | Set events to an object such as `{ "channels": ["C0123ABCD45"] }`. |
| `events.<key>` | This option is not supported. | Remove it. Supported events options: channels. |
| `events.channels` | Must be a list of Slack conversation or user ids, such as C0123ABCD45. | List the ids of the channels and direct messages to collect: a channel's id is at the bottom of its details in Slack. |
| `events.channels` | Lists a channel more than once. | Remove the duplicate id. |
| `events.channels` | Lists more than 16 channels. | Keep the 16 channels and direct messages that matter most. |

### Client secret

Slack apps with PKCE turned on are public clients and need no secret. That is the recommended setup, and [the app manifest](slack-app-manifest.json) turns PKCE on. If your organisation's app does not use PKCE, give OpenCode its client secret in one of two ways:

- in the `/connect` **Slack app client ID** entry, in the **Client secret** field. OpenCode stores it in its credential store, but shows the field unmasked while you type;
- in the options, through an environment variable:

  ```jsonc
  "oauth": {
    "client_id": "YOUR_SLACK_CLIENT_ID",
    "client_secret": "{env:SLACK_CLIENT_SECRET}"
  }
  ```

  OpenCode replaces `{env:NAME}` across the whole config text when it loads the config. If the variable is not set, the result is an empty string, which the plugin rejects with `OPTIONS_INVALID`. Do not put the secret itself in a config file.

Status shows the client mode as `confidential, secret set` and never shows the value.

### Host check

When it loads, the plugin compares the OpenCode version with its supported range, `>=2.2.3 <2.3.0`, which `package.json` declares as `opencode.host`. Every check runs on OpenCode 2.2.3, 2.2.4, 2.2.5 and 2.2.6, the tested releases. A later release in the range, such as 2.2.99, runs untested. Status shows the version, whether it is tested and the supported range in its `OpenCode` row, for example `2.2.5 (tested; supported range >=2.2.3 <2.3.0)`.

- **A tested release:** the plugin sets everything up.
- **Another release inside the range, such as 2.2.99:** the plugin sets everything up too. Status marks the version `untested` (the RPC's `host.tested` is `false`), and its state is the connection's.
- **Outside the range, including prereleases and development builds:** the plugin registers only `/slack-status`, the TUI view and the status RPC. They show the connection `host untested` and the code `HOST_UNTESTED`, with the next step `Use OpenCode >=2.2.3 <2.3.0, or set "allowUntestedHost": true in this plugin's options to run anyway.` If an option is also invalid, they show `OPTIONS_INVALID` first.
- **Outside the range with `"allowUntestedHost": true`:** the plugin sets everything up, and status marks the version as untested.

## Create the Slack app

Someone who can create apps in your Slack workspace does this once for the organisation. If your organisation already has an internal app for Slack's MCP server, reuse it: add the redirect URL and the user scopes below, and turn on PKCE and the MCP server.

1. Open [Slack app settings](https://api.slack.com/apps). Choose **Create New App → From a manifest**, and pick your workspace. Paste [`slack-app-manifest.json`](slack-app-manifest.json) and create the app. The manifest sets the redirect URL `http://localhost:8765/callback`, the user scopes `channels:history`, `channels:read`, `search:read.public` and `users:read`, PKCE on, token rotation off, and Slack's MCP server on (`is_mcp_enabled`).
2. Slack does not document `is_mcp_enabled` in manifests, so confirm in the app's **Agents** section that **Slack Model Context Protocol (MCP) Server** is on. Turn it on if it is not.
3. Get the app approved if your workspace requires admin approval for apps. Keep the app internal to your organisation, or publish it in the Slack Marketplace. Slack refuses unlisted distributed apps.
4. Copy the **Client ID** from **Basic Information → App Credentials**. You do not need the client secret, because the app uses PKCE.

**Add a hosted callback.** For a [hosted callback](#the-callback-loopback-or-hosted), add its address to the app's redirect URLs as well: under **OAuth & Permissions → Redirect URLs**, choose **Add New Redirect URL**, or list it in the manifest's `oauth_config.redirect_urls` before you create the app:

```json
"redirect_urls": [
  "http://localhost:8765/callback",
  "https://host.example/oauth/return"
]
```

Slack matches the host and port exactly: `https://host.example/oauth/return` does not cover `https://host.example:8443/oauth/return` or `https://www.host.example/oauth/return`. Add one entry per address that people sign in through, and one per extra loopback port.

Turning on PKCE makes the app a public client. Slack cannot turn PKCE off again without its support team. To let agents do more, such as search private channels, read files or send messages, add scopes from the [scope table](#scopes).

## What the plugin registers

With a client ID, the plugin adds one MCP server named `slack`:

```json
{
  "type": "remote",
  "url": "https://mcp.slack.com/mcp",
  "oauth": {
    "client_id": "YOUR_SLACK_CLIENT_ID",
    "redirect_uri": "http://localhost:8765/callback",
    "scope": "channels:history channels:read search:read.public users:read"
  }
}
```

With a client secret, it also passes `client_secret`. With an `https:` `oauth.redirect_uri`, it also passes `callback_port`, the port OpenCode's listener takes; with a loopback one it does not, and OpenCode listens on the redirect's own port. It leaves out `protocol`, `timeout`, `headers` and `codemode`, so OpenCode's defaults apply: the classic MCP handshake and Code Mode on. Code Mode keeps Slack's tool schemas out of every turn. The model finds the tools as `tools.slack.<tool>` inside `execute`.

The plugin always sends `redirect_uri`. Without it, OpenCode would use `http://127.0.0.1:<port>/callback`, which does not match a Slack app registered with `http://localhost:8765/callback`.

**In `/connect`:** OpenCode lists the server's own sign-in, which the plugin names **Slack**. Without `oauth.client_id` in the options, the plugin also adds **Slack app client ID** (ID `slack-app`) for the client ID. With it, there is no **Slack app client ID** entry, and no status line or next step mentions one: nobody is asked to paste a client ID.

**Name collision.** If your config already defines an MCP server with the same name, for example `mcp.servers.slack`, the plugin leaves it alone. Status then shows the state `conflict` with the code `SERVER_NAME_IN_USE`. Remove your entry: Slack's tools then come from the plugin's server.

The plugin defines two tools of its own in the `slack` namespace: `slack_events_list`, for Memory's collector ([Events list](#events-list)), and `slack_mark_read` ([Mark as read](#mark-as-read)). Besides the server, those tools and the `/connect` entries, it registers the default permission rules, the `/slack-status` command, the status RPC, the tools RPC with its `status` method, the TUI `/slack` dialog and the `slack-search` skill.

## Permissions

**Every tool is allowed by default.** The plugin adds a generated block of rules to each agent, and at the default `access: "all"` every Slack tool runs without asking: reads, the private-channel search, file reads, writes, sends and any tool Slack adds later. What that means for this plugin is in [SECURITY](../SECURITY.md). Restrict it in any of these three ways.

### The access option

The option has three values, and the plugin generates its block from the tool classes for the one you set:

| Value | What runs | What asks or is denied |
| --- | --- | --- |
| `"all"` (the default) | every tool, and any tool Slack adds later | nothing |
| `"ask-changes"` | the read tools | the private-channel search, file reads, writes and sends, and new tools: they ask |
| `"read-only"` | the read tools | the private-channel search, file reads, writes and sends, and new tools: they are **denied** |

<!-- The three blocks below are generated from defaultRules(access); a test asserts each one equals it. -->

`access: "all"`:

```json
[
  { "action": "slack_*", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_search_public", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_search_channels", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_search_users", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_read_channel", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_read_thread", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_read_user_profile", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_read_canvas", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_list_channel_members", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_get_reactions", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_list_user_channels", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_read_list", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_search_emojis", "resource": "*", "effect": "allow" },
  { "action": "slack_events_list", "resource": "*", "effect": "allow" },
  { "action": "slack_status", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_search_public_and_private", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_read_file", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_send_message", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_send_message_draft", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_schedule_message", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_create_canvas", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_update_canvas", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_add_reaction", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_get_file_upload_url", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_complete_file_upload", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_create_conversation", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_create_list", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_update_list", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_add_list_record", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_update_list_record", "resource": "*", "effect": "allow" },
  { "action": "slack_mark_read", "resource": "*", "effect": "allow" }
]
```

`access: "ask-changes"`:

```json
[
  { "action": "slack_*", "resource": "*", "effect": "ask" },
  { "action": "slack_slack_search_public", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_search_channels", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_search_users", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_read_channel", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_read_thread", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_read_user_profile", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_read_canvas", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_list_channel_members", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_get_reactions", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_list_user_channels", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_read_list", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_search_emojis", "resource": "*", "effect": "allow" },
  { "action": "slack_events_list", "resource": "*", "effect": "allow" },
  { "action": "slack_status", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_search_public_and_private", "resource": "*", "effect": "ask" },
  { "action": "slack_slack_read_file", "resource": "*", "effect": "ask" },
  { "action": "slack_slack_send_message", "resource": "*", "effect": "ask" },
  { "action": "slack_slack_send_message_draft", "resource": "*", "effect": "ask" },
  { "action": "slack_slack_schedule_message", "resource": "*", "effect": "ask" },
  { "action": "slack_slack_create_canvas", "resource": "*", "effect": "ask" },
  { "action": "slack_slack_update_canvas", "resource": "*", "effect": "ask" },
  { "action": "slack_slack_add_reaction", "resource": "*", "effect": "ask" },
  { "action": "slack_slack_get_file_upload_url", "resource": "*", "effect": "ask" },
  { "action": "slack_slack_complete_file_upload", "resource": "*", "effect": "ask" },
  { "action": "slack_slack_create_conversation", "resource": "*", "effect": "ask" },
  { "action": "slack_slack_create_list", "resource": "*", "effect": "ask" },
  { "action": "slack_slack_update_list", "resource": "*", "effect": "ask" },
  { "action": "slack_slack_add_list_record", "resource": "*", "effect": "ask" },
  { "action": "slack_slack_update_list_record", "resource": "*", "effect": "ask" },
  { "action": "slack_mark_read", "resource": "*", "effect": "ask" }
]
```

`access: "read-only"`:

```json
[
  { "action": "slack_*", "resource": "*", "effect": "deny" },
  { "action": "slack_slack_search_public", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_search_channels", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_search_users", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_read_channel", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_read_thread", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_read_user_profile", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_read_canvas", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_list_channel_members", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_get_reactions", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_list_user_channels", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_read_list", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_search_emojis", "resource": "*", "effect": "allow" },
  { "action": "slack_events_list", "resource": "*", "effect": "allow" },
  { "action": "slack_status", "resource": "*", "effect": "allow" },
  { "action": "slack_slack_search_public_and_private", "resource": "*", "effect": "deny" },
  { "action": "slack_slack_read_file", "resource": "*", "effect": "deny" },
  { "action": "slack_slack_send_message", "resource": "*", "effect": "deny" },
  { "action": "slack_slack_send_message_draft", "resource": "*", "effect": "deny" },
  { "action": "slack_slack_schedule_message", "resource": "*", "effect": "deny" },
  { "action": "slack_slack_create_canvas", "resource": "*", "effect": "deny" },
  { "action": "slack_slack_update_canvas", "resource": "*", "effect": "deny" },
  { "action": "slack_slack_add_reaction", "resource": "*", "effect": "deny" },
  { "action": "slack_slack_get_file_upload_url", "resource": "*", "effect": "deny" },
  { "action": "slack_slack_complete_file_upload", "resource": "*", "effect": "deny" },
  { "action": "slack_slack_create_conversation", "resource": "*", "effect": "deny" },
  { "action": "slack_slack_create_list", "resource": "*", "effect": "deny" },
  { "action": "slack_slack_update_list", "resource": "*", "effect": "deny" },
  { "action": "slack_slack_add_list_record", "resource": "*", "effect": "deny" },
  { "action": "slack_slack_update_list_record", "resource": "*", "effect": "deny" },
  { "action": "slack_mark_read", "resource": "*", "effect": "deny" }
]
```

The class is the worst thing a tool can do; the rule decides whether it runs. The private-channel search and the file read are not reads for this purpose: they return data from outside the public channels, so `ask-changes` and `read-only` treat them with the writes.

### The inserted rules

For every agent whose rules contain the base rule `{ "action": "*", "resource": "*", "effect": "allow" }`, the plugin inserts its block directly after the first such rule, unless the block already appears anywhere after it.

OpenCode uses the last matching rule. Everything after the block therefore still wins:

- the agent's own built-in rules, so Explore, Title and Summary keep denying Slack and Plan keeps its limits;
- your top-level and per-agent `permissions`;
- saved "Always allow" approvals.

A configured `deny` always wins, even over a saved approval. Agents without a base allow get no rules and keep their own stricter policy.

The `slack_*` rule also matches tools of any other MCP server whose name begins with `slack_`, such as `slack_archive`. Those tools then take the same effect as the namespace rule.

### Tool classes

The plugin classifies the tools Slack's MCP server lists by name. Tool names and permission actions are `slack_<tool>`, for example `slack_slack_send_message`.

| Class | `all` | `ask-changes` | `read-only` | Slack tools |
| --- | --- | --- | --- | --- |
| read | runs | runs | runs | `slack_search_public`, `slack_search_channels`, `slack_search_users`, `slack_read_channel`, `slack_read_thread`, `slack_read_user_profile`, `slack_read_canvas`, `slack_list_channel_members`, `slack_get_reactions`, `slack_list_user_channels`, `slack_read_list`, `slack_search_emojis` |
| private | runs | asks | denied | `slack_search_public_and_private` |
| file | runs | asks | denied | `slack_read_file` |
| write | runs | asks | denied | `slack_send_message`, `slack_send_message_draft`, `slack_schedule_message`, `slack_create_canvas`, `slack_update_canvas`, `slack_add_reaction`, `slack_get_file_upload_url`, `slack_complete_file_upload`, `slack_create_conversation`, `slack_create_list`, `slack_update_list`, `slack_add_list_record`, `slack_update_list_record` |
| unknown | runs | asks | denied | any other tool on the server |

The plugin's own `slack_mark_read` is a write: it runs at `all`, asks at `ask-changes` and is denied at `read-only`. Its own `slack_events_list` and the tools RPC's `status` method (`slack_status`) are allowed at every value.

Slack can add tools at any time. A tool the plugin does not know follows the namespace rule until the plugin classifies it. Status counts the tools that Slack actually lists by class and names the unknown ones.

### Changing the defaults

- **Allow** a tool that asks or is denied: choose "Always allow" when OpenCode asks, or add a later rule such as `{ "action": "slack_slack_read_file", "resource": "*", "effect": "allow" }` to `permissions`. "Always allow" saves `slack_<tool> *` for the current project. It applies to every agent in that project, Plan included.
- **Deny** a tool: add `{ "action": "slack_slack_search_public_and_private", "resource": "*", "effect": "deny" }`. A deny on a tool also hides it from the model. Deny `slack_*` to deny every Slack tool, for one agent or for all of them.

## Scopes

The plugin requests the scopes in `oauth.scopes`. List each one in the Slack app too, under **OAuth & Permissions → User Token Scopes** (`oauth_config.scopes.user` in a manifest). Some workspaces also need an admin to approve them.

The default scopes are read-only. They cover public message and channel search (`search:read.public`), public channel history and threads (`channels:history`), public channel details and members (`channels:read`) and user profiles (`users:read`). Other tools need more scopes. Without one, a call can fail with Slack's missing-scope error.

Scopes per tool, from Slack's [MCP scope table](https://docs.slack.dev/ai/slack-mcp-server#oauth-scopes):

| To use | Add these user scopes |
| --- | --- |
| Private channels, direct messages and group direct messages in search (`slack_search_public_and_private`) | `search:read.private`, `search:read.im`, `search:read.mpim` |
| File search | `search:read.files` |
| User search (`slack_search_users`) | `search:read.users` |
| Emoji search (`slack_search_emojis`) | `emoji:read` |
| Private channel, direct message and group direct message history | `groups:history`, `im:history`, `mpim:history` |
| Members of private channels and group direct messages (`slack_list_channel_members`) | `groups:read`, `mpim:read` |
| The user's channels of every type (`slack_list_user_channels`) | `channels:read`, `groups:read`, `im:read`, `mpim:read` |
| Email addresses in profiles | `users:read.email` |
| Reading reactions (`slack_get_reactions`) | `reactions:read` |
| Reading files (`slack_read_file`) | `files:read` |
| Reading lists (`slack_read_list`) | `lists:read` |
| Sending and scheduling messages (`slack_send_message`, `slack_schedule_message`) | `chat:write` |
| Adding reactions (`slack_add_reaction`) | `reactions:write` |
| Creating and updating canvases (`slack_create_canvas`, `slack_update_canvas`) | `canvases:read`, `canvases:write` |
| Creating and updating lists and their records (`slack_create_list`, `slack_update_list`, `slack_add_list_record`, `slack_update_list_record`) | `lists:read`, `lists:write` |
| Creating conversations (`slack_create_conversation`) | `channels:write` (public channels), `groups:write` (private channels), `im:write` (direct messages), `mpim:write` (group direct messages) |
| Uploading files (`slack_get_file_upload_url`, `slack_complete_file_upload`) | `files:write` |
| Marking conversations read (`slack_mark_read`, the plugin's own) | `channels:write` (public channels), `groups:write` (private channels), `im:write` (direct messages), `mpim:write` (group direct messages) |

The default scopes and the default app manifest stay read-only, so `slack_mark_read` needs one of these added first. Without it, Slack answers `missing_scope` and the tool gives `SCOPE_MISSING` with the scope Slack names.

The read tools read whatever your scopes reach. With the default scopes, that is public channels. If you add `groups:history`, `im:history` or `mpim:history`, `slack_read_channel` and `slack_read_thread` also read private channels and direct messages, without asking at the default `access`. To make those reads ask, add `{ "action": "slack_slack_read_channel", "resource": "*", "effect": "ask" }`, and the same for `slack_slack_read_thread` and `slack_slack_list_user_channels`, or set `access: "ask-changes"`.

To add scopes:

1. Add them to the Slack app. Reinstall it or get approval if Slack asks.
2. List every scope you want in `oauth.scopes`, including the defaults you keep.
3. Run `opencode mcp logout slack`, then sign in again. The new token carries the new scopes.

Approving a write tool in OpenCode does not grant its Slack scope. Without the scope, the call fails at Slack.

## Status and RPC

`/slack-status`, the TUI `/slack` dialog and the RPC method `status` (RPC ID `slack.workspace`) share one status model. It holds no client secret, no token and no URL query. `version`, `host`, `state`, `unguardedAgents` and `nextStep` are the fields every plugin of this family shares, with the same names and meanings:

| Field | Content |
| --- | --- |
| `version` | The plugin's version |
| `access` | `all`, `ask-changes` or `read-only`: what the generated default rules allow |
| `state` | `connected`, `sign_in_required`, `connecting`, `disabled`, `failed`, `not_configured`, `conflict` or `host_untested`. The text surfaces show the same states as `connected`, `sign-in required`, `connecting`, `disabled`, `failed` (also for a server OpenCode did not load), `not configured` (no client ID or invalid options), `conflict` (a server name in use) and `host untested`. |
| `code` | One of the codes in [Errors](#errors); absent when there is no problem to report |
| `message` | What happened |
| `detail` | For a failed connection only: OpenCode's reason, on one line of at most 160 characters, with any URL cut before its query. The text for a needed sign-in can hold an authorization URL, so it is never shown. |
| `nextStep` | Exactly one next step: the `Next step` row, `Nothing to do.` when nothing is needed |
| `server` | `name` and `url` |
| `client` | `id`, `mode` (`public_pkce` or `confidential`) and `source` (`options` or `connect`), when there is a client |
| `callback` | The redirect URI to register in the Slack app, when the plugin is set up |
| `callbackPort` | OpenCode's local listener port, for an `https:` callback |
| `scopes` | The requested scopes, when the plugin is set up |
| `asksBefore` | What asks under the current `access`; empty at `"all"` and `"read-only"` |
| `tools` | Counts of `read`, `private`, `file`, `write` and `unknown` tools on the server, and `unknownNames`: at most 20 of the unknown tools' names, only those made of lowercase letters, digits and `_` |
| `unguardedAgents` | Agents that lack the default block and would run an unknown Slack tool without asking; empty when there are none. An agent whose own rules already ask or deny for every Slack tool is not listed. |
| `host` | `version` (`null` if OpenCode reports none), `range` (the supported range) and `tested` (true only for the tested releases) |
| `account` | While connected: the signed-in Slack account, from Slack's `auth.test`, as `teamId` (the workspace, `T…`), `userId` (`U…` or `W…`) and, on an Enterprise Grid workspace, `enterpriseId` (`E…`). Read once per sign-in and kept for that credential; absent when not connected or when Slack did not answer, never an error. |
| `shadowedSkills` | Skills with a bundled skill's id, `slack-search`, that OpenCode loads instead of the bundled one, each as `id` and `path`: for example a skill in your own or the project's skill folders. Empty when there are none. |

Scripts have a second RPC, `slack.workspace.tools`, which calls the Slack tools with no model. Its `status` method returns this same model. It has its own error codes; see [Scripting](scripting.md).

The text surfaces show the rows `Connection`, `Account`, `Access`, `Server`, `Client`, `Callback`, `Scopes`, `Skills`, `Tools`, `Agents without default rules`, `OpenCode` and `Next step`, in that order. `Client`, `Callback`, `Scopes` and `Skills` appear when they apply; every other row is always there, with `none` when no agent lacks the default rules. The RPC has one error, `unavailable`. OpenCode does not record which Slack account signed in, so the plugin asks Slack: on the first status after a sign-in it calls `auth.test` once with that sign-in, through `src/slack-api.ts`, the only code that reads the token, and keeps the ids for that credential. A failed `auth.test` is tried again after a minute. The `Account` row shows `workspace T…, user U…` (and `, Enterprise Grid E…`), or, without them, that Slack shows the account on its sign-in page.

## Events list

`slack_events_list` (Code Mode `tools.slack.events_list`, and the tools RPC method `events_list`) is this plugin's side of the `events_list` source contract that Memory's collector reads. It is not for answering questions: the model searches and reads threads for that.

```text
events_list({ since?, cursor?, limit?, account?, source? })
  → { source: "slack", account, owner: { id, label }, events, cursor, more, trust: "untrusted" }
```

- **What it lists**, oldest first: the messages posted in the conversations listed in `events.channels`, read one at a time with `slack_read_channel` and `oldest`. It never uses the private search, never reads a file, and calls nothing that asks under the default rules. A thread's replies are listed only when Slack shows them in the channel (sent to the channel too); a channel read does not include the rest. With no channel enabled, it lists nothing and says so.
- **Scopes**: the default scopes read public channels only. To list private channels, group messages or direct messages, add `groups:history`, `mpim:history` or `im:history` to `oauth.scopes` and sign in again. Listing a direct message is reading it without a prompt: enabling it in `events.channels` is the consent.
- **An event**: kind `message`, `external_id` `<channel id>:<ts>`, `occurred_at` from the ts, thread `slack-thread:<channel id>:<thread ts>` for a thread's parent and its replies, the author as `slack:<user id>` with their name, the first line as the title, the text (at most 4,096 characters), the permalink, and the labels `channel`, `group` or `dm`, `channel:<id>`, and `thread-parent` or `thread-reply`. Slack's own permalink is kept; otherwise one is built from the workspace's address when Slack's profile answer names it, and none for a user id.
- **Account and owner**: `owner` is the signed-in user, from `slack_read_user_profile`, as `slack:<user id>` with their name. `account` is the workspace's team id when Slack names it, else its address's first label, else `default`. Memory compares the owner with the person it collects for. `account` and `source` are optional inputs: another workspace is `ACCOUNT_UNKNOWN`, another source `SOURCE_UNKNOWN`.
- **Reading Slack's answer**: Slack's tools answer in Markdown text. The plugin reads structured JSON when Slack gives it, and otherwise the labelled lines Slack writes for each message (`From`, `Message TS` or `Message_ts`, `Thread TS`, `Reply count`, `Permalink`, `Text`), and the next page's cursor. An answer with message timestamps it cannot read is `UPSTREAM_UNREADABLE`, never an empty page.
- **Cursor**: opaque, at most 1,024 characters. It holds each conversation's last listed ts and a digest of the workspace and user, so another workspace's or sign-in's cursor is `CURSOR_INVALID`. A cursor wins over `since`; without either, or for a conversation added to `events.channels` later, the listing starts 24 hours ago. An older cursor lists the same events again.
- **Limits**: `limit` is 1 to 500 (100 by default); a result stops early, with `more: true`, rather than pass 900 KB. A conversation with more than 5 pages of 100 new messages is read in halves of its time window, oldest first, with `more: true`; one that does not fit in 30 reads is `TOO_MANY_MESSAGES`, never a skip.
- **Permissions**: it asserts `slack_events_list`, then each read goes through OpenCode's own executor with its own rules. Every result carries `trust: "untrusted"`: other people wrote the messages.

## Mark as read

`slack_mark_read` (Code Mode `tools.slack.mark_read`, and the tools RPC method `mark_read`, class `write`) marks a conversation read for the signed-in user up to and including a message, as opening it in Slack does. Slack's MCP server has no tool for it.

```text
mark_read({ channel_id, ts }) → { channel_id, ts }
```

- **Input**: `channel_id` is a channel (`C…`), private channel (`G…`) or direct or group message (`D…`); `ts` is a message ts such as `1700000000.000100`. Anything else is `INPUT_INVALID`, with no call to Slack.
- **What it calls**: it asserts `slack_mark_read`, then calls Slack's `conversations.mark` once, through `src/slack-api.ts`, with the `slack` server's sign-in. The token goes only into that request's `Authorization` header; it is never stored, logged or returned.
- **Scopes**: `channels:write`, `groups:write`, `im:write` or `mpim:write`, for the conversation's type ([Scopes](#scopes)). Without it, `SCOPE_MISSING`, naming the scope Slack asks for.
- **Errors**: without a Slack sign-in, status's code and next step, such as `AUTH_REQUIRED`; Slack's other refusals are `UPSTREAM_ERROR` with Slack's error code only, such as `channel_not_found`.

## Errors

Every error the plugin raises reads `CODE: What happened. Next step: What to do.` In status, the code and what happened are in the `Connection` row and the next step is the last row. The tools RPC gives `CLIENT_ID_MISSING` and `CLIENT_ID_INVALID` with the same next step ([scripting](scripting.md#errors)).


| Code | Connection | Next step |
| --- | --- | --- |
| `CLIENT_ID_MISSING` | not configured | Run /connect and choose Slack app client ID, then paste your Slack app's client ID. |
| `CLIENT_ID_INVALID` | not configured | Run /connect and choose Slack app client ID, then paste your Slack app's client ID. |
| `AUTH_REQUIRED` | sign-in required | Run /connect and choose Slack, then press o or Enter to open the sign-in page (in a terminal, opencode mcp auth slack opens the browser automatically). |
| `CONNECTION_FAILED` | failed | Fix the error shown, then reconnect slack in /mcps. |
| none: connecting | connecting | Wait a few seconds, then run /slack-status again (or press r in /slack). |
| none: OpenCode has not loaded the server | failed | Run opencode reload, then check again. |
| `SERVER_DISABLED` | disabled | Enable slack in /mcps. |
| `SERVER_NAME_IN_USE` | conflict | Remove mcp.servers.slack from your OpenCode config. |
| `OPTIONS_INVALID` | not configured | See [Validation errors](#validation-errors). |
| `HOST_UNTESTED` | host untested | Use OpenCode >=2.2.3 <2.3.0, or set "allowUntestedHost": true in this plugin's options to run anyway. |
| none: a shadowed skill | connected | Move or rename the skill at `<path>`, so that this plugin's slack-search skill loads, then run opencode reload. |
| none: agents without default rules | connected | Put the default rules shown by /slack-status first in each listed agent's own permissions, in opencode.json or the agent's Markdown file, followed by your top-level rules for Slack tools. |
| `STATUS_UNAVAILABLE` | none: status itself failed | Run /slack-status again in a moment (in the dialog: press r to retry). |
| `SKILLS_INVALID` | none: the plugin does not load | Reinstall the plugin: opencode plugin remove github:joe-broadhead/opencode-slack#v0.0.0, then opencode plugin add github:joe-broadhead/opencode-slack#v0.0.0, then opencode reload. A bundled skill is missing or has invalid frontmatter. |
| `INPUT_INVALID` | none: `slack_events_list` | Pass since, cursor, limit, account or source as events_list's schema describes them. |
| `SOURCE_UNKNOWN` | none: `slack_events_list` | Leave "source" out, or pass "slack". |
| `CURSOR_INVALID` | none: `slack_events_list` | Call events_list without a cursor, with since, to start again. |
| `ACCOUNT_UNKNOWN` | none: `slack_events_list` | Leave "account" out, or pass the signed-in workspace. |
| `TOO_MANY_MESSAGES` | none: `slack_events_list` | Call events_list again with a later since, without a cursor. |
| `UPSTREAM_UNREADABLE` | none: `slack_events_list` | Call the tool directly to see Slack's answer, and run /slack-status. |
| `INPUT_INVALID` | none: `slack_events_list` | Pass since, cursor, limit, account or source as events_list's schema describes them. |
| `SOURCE_UNKNOWN` | none: `slack_events_list` | Leave "source" out, or pass "slack". |
| `ACCOUNT_UNKNOWN` | none: `slack_events_list` | Leave "account" out, or pass the workspace the message names. |
| `CURSOR_INVALID` | none: `slack_events_list` | Call events_list without a cursor, with since, to start again. |
| `TOO_MANY_MESSAGES` | none: `slack_events_list` | Call events_list again with a later since, without a cursor. |
| `UPSTREAM_ERROR` | none: `slack_events_list`, Slack refused a read (the message names the channel) | Check that the channel id in events.channels is one you can read, then call events_list again with the same cursor. |
| `UPSTREAM_UNREADABLE` | none: `slack_events_list`, Slack answered in a shape it does not read | Call the tool the message names directly to see Slack's answer, and run /slack-status. |
| `INPUT_INVALID` | none: `slack_mark_read` | Pass channel_id and ts as mark_read's schema describes them. |
| `SCOPE_MISSING` | none: `slack_mark_read` | Add the scope the message names to the Slack app's user scopes and to the plugin's oauth.scopes, then sign in to Slack again. |
| `UPSTREAM_ERROR` | none: `slack_mark_read`, Slack refused conversations.mark (the message holds Slack's error code) | Check channel_id and ts, and run /slack-status if it keeps failing. |
| `INPUT_INVALID` | none: the tools RPC's `status` method | Pass an empty object as the input. |
| `TOOL_UNAVAILABLE` | none: `slack_events_list`, OpenCode does not list a read it needs, or `slack` is your own server | Wait a few seconds, then run /slack-status and follow its next step. While the server cannot be called, `slack_events_list` gives status's own code and next step instead. |
