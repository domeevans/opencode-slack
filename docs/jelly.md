# In Jelly

[Jelly](https://heyjelly.ai) runs OpenCode agents. It reads the `jelly` section of this
package's `package.json` as JSON, without loading the plugin, when a person reviews the exact
version, and uses it as follows.

Jelly names the plugin **Slack** (`jelly.title`), with the package name and version beneath. Under
that name it shows the one line in `jelly.summary`, and beside it the mark in `jelly.icon`
(`assets/icon.svg`, shipped in the package): Jelly reads that file once, when it records the
plugin, and keeps it only if it is a clean SVG of drawing elements, with no script, style, link
or outside reference. A Jelly whose declaration schema lacks `summary` or `icon` refuses this
declaration, because that schema accepts no unknown keys.

## Tools and permissions

27 tools are declared (14 read-only). Jelly's agents have no base "allow everything"
rule, so this plugin's own default rules, which it puts after that rule, never reach them. Jelly
writes each declared `ask` or `deny` as that tool's default instead (the person's own choice
replaces it), and denies a read-only helper every tool not marked `readOnly`. A declared `allow`
changes nothing in Jelly.

- Ask: `slack_slack_search_public_and_private`, `slack_slack_read_file`, `slack_slack_send_message`, `slack_slack_send_message_draft`, `slack_slack_schedule_message`, `slack_slack_create_canvas`, `slack_slack_update_canvas`, `slack_slack_add_reaction`, `slack_slack_get_file_upload_url`, `slack_slack_complete_file_upload`, `slack_slack_create_conversation`, `slack_slack_create_list`, `slack_slack_update_list`, `slack_slack_add_list_record`, `slack_slack_update_list_record`.
- Off: none.
- Everything else runs, as the plugin's own rules let it.

Private search and file reads ask, as the plugin's own rules do, and are marked read-only.

A tool the upstream server adds later is not declared, so in Jelly it is not asked about by
default. Keep `jelly.tools` in step with the known-tool list; `test/**/jelly.test.ts` checks
each declared effect against the plugin's own default rules.

## Skills

Declared: `slack-search`. Jelly refuses an install whose
skill ids collide with another plugin's or the agent's own.

## Views

None yet.

## Signing in

`jelly.signIns` declares two steps. First `app`: the key integration `slack-app`, your organisation's Slack app client ID, pasted once; the row links to [the app manifest](slack-app-manifest.json). Then `slack`, Slack's MCP server, which signs in with OAuth (`after: "app"`: until the app is in, its row reads After Slack app and offers nothing to press).

**`presetBy`.** The `app` step declares `"presetBy": "oauth.client_id"`: a dotted path into the plugin's options. When the options Jelly gives the plugin set that path, for example from a deployment's own Slack app, the step is done: the plugin registers no `slack-app` integration, Jelly shows no row to paste into, and `slack`, which waits for `app`, can start at once, so the person only sees Slack. A Jelly whose sign-in schema lacks `presetBy` refuses this declaration, because that schema accepts no unknown keys.

**The callback.** The default is `http://localhost:8765/callback`, which reaches only a browser on the engine's machine, and two agents signing in to Slack at once collide on that port. The plugin accepts an `https:` `oauth.redirect_uri` with an `oauth.callback_port`, so a deployment can send the browser to its host's return address, for example `https://<host>/oauth/return`, with a free port for each agent's engine. Add that address to the Slack app's Redirect URLs ([The callback: loopback or hosted](configuration.md#the-callback-loopback-or-hosted)).

Jelly folds the declared sign-ins into this plugin's one card, which shows each as Connected, Not signed in or Sign in again (expired or revoked), and starts, renews and signs out of each. An agent's `jelly_connection_request`, or a tool result that names this plugin's "Run /connect and choose …" next step, opens the same card. The plugin still signs in through OpenCode, as it does without Jelly; the declaration only tells Jelly which of the engine's integrations and servers are this plugin's.

## Versions

Jelly's curated catalogue pins an exact version. Publish each release under a new version, so a
review in Jelly can tell the two apart.
