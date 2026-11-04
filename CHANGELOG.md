# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- OpenCode 2.2.5 is a tested release, next to 2.2.3 and 2.2.4.
- Code Mode's catalog now describes the `slack` namespace: what the tools do, what asks first, and that Slack content is untrusted.
- The status RPC has `version`, the plugin's version.
- The `jelly` section declares the tools RPC's 14 methods in `jelly.rpc`, each read-only and under the permission of the tool it runs.

### Changed

- The status RPC (`slack.workspace` `status`) uses the field names every plugin of this family shares. Scripts that read it need these changes:
  - `next` is now `nextStep`;
  - `state` uses the shared states: `not_signed_in` is now `sign_in_required`; `no_client_id` and `config_invalid` are now `not_configured`; `not_registered` is now `conflict` for a server name in use (`SERVER_NAME_IN_USE`) and `failed` for a server OpenCode did not load;
  - `tools.unknown` is now the number of unknown tools, and their names are in `tools.unknownNames`: at most 20, and only plain tool names;
  - `host.tested` is true only for 2.2.3, 2.2.4 and 2.2.5, and `host.range` is the supported range; `host.version` is `null` when OpenCode reports no version.
- On a release inside `>=2.2.3 <2.3.0` other than 2.2.3, 2.2.4 and 2.2.5, Slack still sets everything up, and status calls the version untested. The `OpenCode` row reads, for example, `2.2.5 (tested; supported range >=2.2.3 <2.3.0)`.
- Status always shows the `Agents without default rules` row, with `none` when every agent is covered.
- While Slack is connecting, the next step says to run `/slack-status` again (or press `r` in `/slack`) instead of "refresh".
- Status no longer shows OpenCode's text for a needed sign-in, which can hold an authorization URL. For a failed connection it shows OpenCode's reason on one line of at most 160 characters, with any URL cut before its query.

### Fixed

- The `slack-search` skill, the README and `docs/scripting.md` taught search parameters that Slack's server does not have. Every search tool takes one required `query`: keywords or a question, narrowed with Slack's search modifiers such as `in:#channel`, `from:<@U…>`, `after:` and `before:`. A test now checks every parameter the skill and the docs name against Slack's live tool schemas.
- The README's Uninstall steps failed: once the plugin was removed, `opencode mcp logout slack` answered "MCP server not found", and the Slack sign-in and the saved client ID stayed in OpenCode's credential store. Uninstall now signs out first, checks with `opencode auth list`, then removes the plugin.
- The README now says what to do after `opencode plugin add` (run `opencode reload`, then `/slack-status`) and how to update the plugin.
- `docs/scripting.md` said `opencode api` runs in the directory you call it from. It runs in the OpenCode service's default location, your home directory; the doc now says how to target a project. It also says that `opencode api` exits with status 1 for an RPC error, and that a result with only text has that text as its `output`.

## [0.0.2] - 2026-11-03

### Added

- The tools RPC, `slack.workspace.tools`: a script can call Slack's twelve reads, `slack_search_public_and_private` and `slack_read_file` with no model, through `opencode api`, as a session and its agent. It gets exactly the access that agent's model has: a tool its rules hide is refused, OpenCode checks each call against the agent's and the session's rules, and an ask is refused at once because no one is there to answer it, so the private search and the file read need an allow rule. `describe` lists the methods with each tool's live input schema. Slack's writes and sends, and any tool Slack adds later, are never methods. `docs/scripting.md` explains it.

## [0.0.1] - 2026-11-03

### Added

- A `jelly` section in `package.json`: each tool with its permission, its default effect and whether it only reads, the skill ids. Jelly reads it without loading the plugin and applies the declared asks, because its agents have no base allow rule for this plugin's own default rules to follow. `docs/jelly.md` explains it.
- `title` and `signIns` in the `jelly` section: the name Jelly shows on the plugin's card, and what the plugin signs in to, so that one card can say whether each sign-in is connected and start, renew or end it. `docs/jelly.md` lists them.
- Hosted callbacks, so sign-in works when OpenCode runs on another machine ([#1](https://github.com/joe-broadhead/opencode-slack/issues/1)): `oauth.redirect_uri` also accepts an `https:` URL with a path and no credentials, query or fragment, together with the new `oauth.callback_port`, the port of OpenCode's local callback listener, which a reverse proxy forwards the address to. The server config then carries `callback_port`, and status shows the port in `callbackPort` and its `Callback` row. `oauth.callback_port` is refused with a loopback redirect, whose own port is the listener's. The docs explain how to add a hosted address to the Slack app's Redirect URLs, and how two sign-ins on one machine avoid colliding on port 8765.
- `presetBy` on the `jelly.signIns` Slack app step: with `oauth.client_id` set in the plugin options, the step is done, so Jelly asks nobody to paste a client ID.

### Changed

- The `oauth.redirect_uri` errors say which rule an `http:` URL broke, and their next step names both a loopback and a hosted example. The `Callback` status row says to register the URL in the app's Redirect URLs.

## [0.0.0] - 2026-11-01

### Added

- Slack's hosted MCP server, `https://mcp.slack.com/mcp`, registered as the MCP server `slack` with your Slack app's OAuth client. OpenCode signs in with PKCE and refreshes the token.
- Sign-in from `/connect`: **Slack app** stores the app's client ID (and an optional client secret) in OpenCode's credential store, and **Slack** signs in. A change to the stored client applies without a restart.
- Options: `oauth.client_id` (pins the client, for example in an organisation's managed config), `oauth.redirect_uri` (default `http://localhost:8765/callback`), `oauth.scopes` (default `channels:history channels:read search:read.public users:read`), `oauth.client_secret` through `{env:NAME}`, `server` and `allowUntestedHost`.
- Default permissions: the known read tools run without asking. Private search, file reads, writes (messages, drafts, schedules, reactions, canvases, lists, new conversations and file uploads) and unknown tools ask. Your `permissions` rules and "Always allow" answers override them.
- `/slack-status`, the TUI dialog **Slack: Status** (`/slack`) and the status RPC, sharing one status model: the state, an error code, the client and its source, the tools by class, the agents without the default rules, the host check and one next step.
- A host check: on an OpenCode version outside `>=2.2.3 <2.3.0`, only the status surfaces are registered unless `allowUntestedHost` is `true`.
- The `slack-search` skill: search public channels first, read for context, cite permalinks, and treat Slack content as untrusted.
- A Slack app manifest, `docs/slack-app-manifest.json`.
