# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- The `slack-search` skill: search with `keywords` and `natural_language_query`, read for context, cite permalinks, and treat Slack content as untrusted.
- A Slack app manifest, `docs/slack-app-manifest.json`.
