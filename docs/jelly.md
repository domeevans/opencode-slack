# In Jelly

[Jelly](https://heyjelly.ai) runs OpenCode agents. It reads the `jelly` section of this
package's `package.json` as JSON, without loading the plugin, when a person reviews the exact
version, and uses it as follows.

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

Two steps: the key integration `slack-app` takes your organisation's Slack app client ID, then Slack's MCP server `slack` signs in with OAuth (callback `http://localhost:8765/callback`). Jelly shows `integration:slack-app` first; `mcp:slack` appears once a client ID is saved.

<!-- AUTH-PLACEHOLDER (Jelly rd152): settings and secrets for signing in from Jelly are being
designed by Jelly's auth lane. Until that lands this package declares no `contributes.settings`;
add the auth declarations here and in package.json when that design is agreed. -->
**Not yet declared for Jelly.** How this plugin's sign-in appears in Jelly (desktop and web,
expiry, reconnect and sign-out) is still being designed; this section and
`jelly.contributes.settings` will say it once it is.

## Versions

Jelly's curated catalogue pins an exact version. `latest` is `0.0.0`; publish each release
under a new version so a review in Jelly can tell the two apart.
