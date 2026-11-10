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

28 tools are declared (15 read-only). Jelly's agents have no base "allow everything"
rule, so this plugin's own default rules, which it puts after that rule, never reach them. Jelly
writes each declared `ask` or `deny` as that tool's default instead (the person's own choice
replaces it), and denies a read-only helper every tool not marked `readOnly`. A declared `allow`
changes nothing in Jelly.

- Ask: none. Every tool is declared `allow`, so a Jelly agent runs what the plugin's own default allows.
- Off: none. To make one ask or stop, declare `ask` or `deny` for it, or set the plugin's `access` option in the agent's options.

Private search and file reads are marked read-only and, like every tool, allowed by default; declare a later `ask` rule if the agent should not read private content. The plugin's own `slack.events_list` is for Memory's collector, which runs it unattended, so it never asks; each Slack read it makes follows that read's own effect.

A tool the upstream server adds later is not declared, so in Jelly it is not asked about by
default. Keep `jelly.tools` in step with the known-tool list; `test/**/jelly.test.ts` checks
each declared effect against the plugin's own default rules.

## Skills

Declared: `slack-search`. Jelly refuses an install whose
skill ids collide with another plugin's or the agent's own.

## Views

None.

## Signing in

`jelly.signIns` declares two steps. First `app`: the key integration `slack-app`, your organisation's Slack app client ID, pasted once; the row links to [the app manifest](slack-app-manifest.json). Then `slack`, Slack's MCP server, which signs in with OAuth (`after: "app"`: until the app is in, its row reads After Slack app client ID and offers nothing to press).

**`presetBy`.** The `app` step declares `"presetBy": "oauth.client_id"`: a dotted path into the plugin's options. When the options Jelly gives the plugin set that path, for example from a deployment's own Slack app, the step is done: the plugin registers no `slack-app` integration, Jelly shows no row to paste into, and `slack`, which waits for `app`, can start at once, so the person only sees Slack. A Jelly whose sign-in schema lacks `presetBy` refuses this declaration, because that schema accepts no unknown keys.

**`hostClient`.** The `app` step also declares `"hostClient": { "id": "slack", "option": "oauth.client_id" }`: the Slack app a Jelly host holds by the name `slack` (a deployment's own) goes into that option, so `presetBy` marks the step done and the person signs in to Slack once. Jelly writes it into the plugin's options in each agent's engine document, and never over a client ID the agent's own options set. A Jelly before 0.3.2 refuses this declaration's new key.

**The callback.** The default is `http://localhost:8765/callback`, which reaches only a browser on the engine's machine, and two agents signing in to Slack at once collide on that port. The plugin accepts an `https:` `oauth.redirect_uri` with an `oauth.callback_port`, so a deployment can send the browser to its host's return address, for example `https://<host>/oauth/return`, with a free port for each agent's engine. Add that address to the Slack app's Redirect URLs ([The callback: loopback or hosted](configuration.md#the-callback-loopback-or-hosted)).

**The relay.** The `slack` step declares `"relay": {}`. A Jelly web tab cannot reach the engine's loopback, and a Slack app sends the browser back only to the addresses it lists, so Jelly may send a web tab's sign-in back through its fixed relay at Jelly ID instead. For that, add the relay address your Jelly host gives you, such as `https://host.example/connect/callback`, to your Slack app's Redirect URLs beside the loopback one. [The app manifest](slack-app-manifest.json) lists only the loopback address, so an app made from it trusts no third-party address unless you add one.

Jelly folds the declared sign-ins into this plugin's one card, which shows each as Connected, Not signed in or Sign in again (expired or revoked), and starts, renews and signs out of each. An agent's `jelly_connection_request`, or a tool result that names this plugin's "Run /connect and choose …" next step, opens the same card. The plugin still signs in through OpenCode, as it does without Jelly; the declaration only tells Jelly which of the engine's integrations and servers are this plugin's.

## Versions

Jelly's curated catalogue pins an exact version. Publish each release under a new version, so a
review in Jelly can tell the two apart.

The declaration test runs the shared kit, `test/support/jelly-kit.ts`, which checks the declaration and this page against Jelly's plugin authors' standard. `scripts/check-copies.mjs` holds the kit, and the shared part of the tools RPC (`src/host/tools-rpc.ts`), equal to the copy every plugin carries.
