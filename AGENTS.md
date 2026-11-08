# Repository rules

This repository builds `@joe-broadhead/opencode-slack`, an unofficial OpenCode plugin that connects Slack's hosted MCP server. The README describes what users see; [docs/configuration.md](docs/configuration.md) is the contract for options, permissions, status and errors; [docs/architecture.md](docs/architecture.md) maps the code.

## Design

- **Thin plugin.** Register `https://mcp.slack.com/mcp` through `ctx.mcp.transform`. OpenCode owns transport, OAuth, token storage and refresh, Code Mode and permission prompts. Add no wrapper tools, no other plugin tools and no Slack Web API client.
- **Events list.** The one plugin tool is `slack_events_list` (`src/events.ts`), Memory's source of Slack events: a Code Mode tool in the `slack` namespace and the tools RPC's owned method `events_list`. It reads only `slack_read_user_profile` and `slack_read_channel` for the channels in `events.channels`, through the host's executors, never the private search, a file or anything that asks. It keeps the shared contract in `src/host/events-list.ts`, a copy every source plugin carries unchanged (`scripts/check-copies.mjs` pins its hash); its tests run the contract's conformance check on synthetic answers in Slack's Markdown layout.
- **Tools RPC.** `src/host/tools-rpc.ts` lets scripts call the known reads (`SCRIPTABLE_TOOLS`: classes `read`, `private` and `file`) through OpenCode's own executors from `ctx.tool.list()`, never its own MCP client. Writes, sends and unknown tools are never methods. It is a copy of a module shared by several plugins: change only its block between the `PLUGIN-SPECIFIC` markers here, and the rest in the shared copy first.
- **Client ID.** Options first, then the `/connect` **Slack app client ID** key method (key: the client ID; form: optional secret). No default client ships, ever. Without a client, register no server and say so in status. Never put a client ID or secret in `ctx.storage`.
- **Stable IDs.** Plugin `slack.workspace`, TUI `slack.workspace.tui`, RPC `slack.workspace`, tools RPC `slack.workspace.tools` with `describe`, one method per known read and `events_list`, tool `slack_events_list`, `/connect` entry `slack-app`, MCP server `slack` (no option renames it).
- **Setup never throws** for bad input. For invalid options or a host outside the supported range (`opencode.host`), register only `/slack-status`, the status RPC and the TUI dialog. Every error has a code, a message and exactly one next step, rendered as `CODE: What happened. Next step: What to do.`, skill loading included. Never echo option values or secrets.
- **One status model.** `src/status.ts` builds it; `/slack-status`, the RPC and the dialog render it, with the rows Connection, Account, Access, Server, Client, Callback, Scopes, Skills (a user or project skill that shadows a bundled one, from the public `ctx.skill.list()`), Tools, Agents without default rules, OpenCode and exactly one Next step (`Nothing to do.` when nothing is needed). Connection shows the shared labels; the RPC carries the same states in machine form (`sign_in_required`, `not_configured`), and the shared fields `version`, `host`, `state`, `unguardedAgents` and `nextStep`. Error codes carry no service prefix. Host error text is shown only for a failed connection, cut to one line of 160 characters with no URL query. `TESTED_HOSTS` in `src/defaults.ts` is the one list of tested releases; status calls only those tested.
- **TUI.** One global palette command, **Slack: Status** (`/slack`), opening one dialog. No `ctx.ui.slot` calls.
- **Permissions.** `src/permissions.ts` inserts the `slack_*` ask rule and one allow rule per read tool directly after each agent's first base `* * allow`, unless the block already appears anywhere after it. User rules and saved approvals must keep winning; a stricter agent never gets weaker. Agents created after plugins run get no rules: status names them and gives the per-agent fix, never the top-level `permissions`.
- **Skills.** At most three, under `skills/<id>/SKILL.md`, with real tool and parameter names checked against Slack's live schemas.
- **Greenfield.** No compatibility paths, migrations or dead code. Delete old code, docs and tests with the behaviour they cover.

## Forbidden APIs

`test/unit/forbidden.test.ts` scans `src/`, `test/` and `skills/` for these, and is the list: `ctx.mcp.catalog`, `ctx.mcp.attest`, `supports*` markers, a second argument to `permission.assert`, tool `options.mcp`, config `capabilities`, `responsePolicy`, `Plugin.image` and profile images, `ctx.generate.text`, `experimental.policies`, `ctx.experimental.artifact`, `ctx.permission.hook` (except the tools RPC's one `evaluate` hook in `src/host/tools-rpc.ts`, which turns an ask on one of its own script calls in flight into a deny because no one can answer it, and touches nothing else), `@opencode-ai/plugin`, `@opencode/ai` imports, a `server()` export, and OpenCode host source paths.

## Package

- No runtime or peer dependencies, and no install, `prepare` or `prepack` scripts. `@opencode/plugin` (exactly 2.2.3), OpenTUI and Solid are dev dependencies; `opencode.host` states compatibility.
- `files` is a whitelist. `npm run build` (`scripts/build.ts`) emits exactly two self-contained esbuild bundles, `dist/index.js` and `dist/tui.js`, with shared code inlined and no relative, dynamic or required imports; only `@opencode/plugin`, `@opentui/*`, `solid-js` and `node:*` stay external. The TUI goes through Babel's Solid universal transform first. No `.tsx`, no `.d.ts`, no chunks. `tsc` only typechecks.
- Releases follow CONTRIBUTING.md: a `vX.Y.Z` tag on `master`, approved in the `release` environment, which CI publishes with npm trusted publishing and provenance.

## Checks

- `npm ci --ignore-scripts`, then `npm run check`. See [CONTRIBUTING.md](CONTRIBUTING.md).
- Host tests run OpenCode with HOME, `OPENCODE_TEST_HOME`, XDG directories and TMPDIR inside a temporary root, which is a git repository under the system's `/tmp` (never under TMPDIR or HOME), each stock host on its own port, and never call Slack.
- `test/host/slack-catalog.ts` holds Slack's live tool schemas; the fake server serves them and `test/unit/docs.test.ts` checks every parameter the skill and the docs name against them. Refresh it when Slack changes a tool; `npm run drift` compares the reads with a live, signed-in OpenCode (manual, not part of `check`).
- Do not skip, weaken or delete a test to get green.

## Writing

- Never commit tokens, client secrets, real client IDs, personal data, Slack content or absolute local paths. Docs use `YOUR_SLACK_CLIENT_ID`.
- Commit messages use `type(scope): summary`.
- Keep the README, `docs/`, `SECURITY.md` and `CHANGELOG.md` in step with the code.
