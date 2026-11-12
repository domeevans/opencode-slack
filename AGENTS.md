# Repository rules

This repository builds `@joe-broadhead/opencode-slack`, an unofficial OpenCode plugin that connects Slack's hosted MCP server. The README describes what users see; [docs/configuration.md](docs/configuration.md) is the contract for options, permissions, status and errors; [docs/architecture.md](docs/architecture.md) maps the code.

## Design

- **Thin plugin.** Register `https://mcp.slack.com/mcp` through `ctx.mcp.transform`. OpenCode owns transport, OAuth, token storage and refresh, Code Mode and permission prompts. Add no wrapper tools. The plugin's own tools are `slack_events_list` and `slack_mark_read`, for what Slack's server has no tool for.
- **One Web API client.** `src/slack-api.ts` is the only code that reads the Slack token: it resolves the `slack` server's sign-in through `ctx.integration.connection` and calls only the methods in `SLACK_API_METHODS` (`auth.test` for status's account, `conversations.mark` for `slack_mark_read`). It never stores, caches, logs or returns the token, and its errors carry Slack's error code only. Adding a method there changes `SECURITY.md`'s promise: update it in the same change.
- **Tools RPC.** `src/host/tools-rpc.ts` lets scripts call every known tool (`METHODS`, from `KNOWN_TOOLS` in `src/tools.ts`) through OpenCode's own executors from `ctx.tool.list()`, never its own MCP client, plus the plugin's own `events_list`, `mark_read` and `status`. Each method carries its class: read, send or write. The rule is resolved before dispatch, so only a prior explicit `allow` runs; an `ask` is refused. A saved approval does not authorize an ad-hoc script. A tool Slack adds later is not a method until it is classified. It is a copy of a module shared by several plugins: change only its block between the `PLUGIN-SPECIFIC` markers here, and the rest in the shared copy first.
- **Client ID.** Options first, then the `/connect` **Slack app client ID** key method (key: the client ID; form: optional secret). No default client ships, ever. Without a client, register no server and say so in status. Never put a client ID or secret in `ctx.storage`.
- **Stable IDs.** Plugin `slack.workspace`, TUI `slack.workspace.tui`, RPC `slack.workspace`, tools RPC `slack.workspace.tools` with `describe`, one method per known tool and the owned `events_list`, `mark_read` and `status`, `/connect` entry `slack-app`, MCP server `slack` (no option renames it).
- **Setup never throws** for bad input. For invalid options or a host outside the supported range (`opencode.host`), register only `/slack-status`, the status RPC and the TUI dialog. Every error has a code, a message and exactly one next step, rendered as `CODE: What happened. Next step: What to do.`, skill loading included. Never echo option values or secrets.
- **One status model.** `src/status.ts` builds it; `/slack-status`, the RPC and the dialog render it, with the rows Connection, Account, Access, Server, Client, Callback, Scopes, Skills (a user or project skill that shadows a bundled one, from the public `ctx.skill.list()`), Tools, Agents without default rules, OpenCode and exactly one Next step (`Nothing to do.` when nothing is needed). Connection shows the shared labels; the RPC carries the same states in machine form (`sign_in_required`, `not_configured`), and the shared fields `version`, `host`, `state`, `unguardedAgents` and `nextStep`, and, while connected, `account` (`teamId`, `userId`, `enterpriseId`) from one `auth.test` per sign-in; a failed lookup leaves it out, never an error. Error codes carry no service prefix. Host error text is shown only for a failed connection, cut to one line of 160 characters with no URL query. `TESTED_HOSTS` in `src/defaults.ts` is the one list of tested releases; status calls only those tested.
- **TUI.** One global palette command, **Slack: Status** (`/slack`), opening one dialog. No `ctx.ui.slot` calls.
- **Permissions.** Every tool is allowed by default. `src/permissions.ts` generates the block from the tool classes and the `access` option (`all`, the default; `ask-changes`; `read-only`) and inserts it directly after each agent's first base `* * allow`, unless the block already appears anywhere after it. User rules and saved approvals must keep winning; a stricter agent never gets weaker. Agents created after plugins run get no rules: status names them and gives the per-agent fix, never the top-level `permissions`. `defaultRules(access)` is printed in full in the README and in `docs/configuration.md` for each value; a test asserts the docs equal it.
- **Skills.** At most three, under `skills/<id>/SKILL.md`, with real tool and parameter names checked against Slack's live schemas.
- **Greenfield.** No compatibility paths, migrations or dead code. Delete old code, docs and tests with the behaviour they cover.

## Forbidden APIs

`test/unit/forbidden.test.ts` scans `src/`, `test/` and `skills/` for these, and is the list: `ctx.mcp.catalog`, `ctx.mcp.attest`, `supports*` markers, a second argument to `permission.assert`, tool `options.mcp`, config `capabilities`, `responsePolicy`, `Plugin.image` and profile images, `ctx.generate.text`, `experimental.policies`, `ctx.experimental.artifact`, `ctx.permission.hook` (except the tools RPC's one `evaluate` hook in `src/host/tools-rpc.ts`, which turns an ask on one of its own script calls in flight into a deny because no one can answer it, and touches nothing else), `@opencode-ai/plugin`, `@opencode/ai` imports, a `server()` export, and OpenCode host source paths.

## Package

- No runtime or peer dependencies, and no install, `prepare` or `prepack` scripts. `@opencode/plugin` (exactly 2.2.3), OpenTUI and Solid are dev dependencies; `opencode.host` states compatibility.
- `files` is a whitelist. `npm run build` (`scripts/build.ts`) emits exactly two self-contained esbuild bundles, `dist/index.js` and `dist/tui.js`, with shared code inlined and no relative, dynamic or required imports; only `@opencode/plugin`, `@opentui/*`, `solid-js` and `node:*` stay external. The TUI goes through Babel's Solid universal transform first. No `.tsx`, no `.d.ts`, no chunks. `tsc` only typechecks.
- Releases come only from `.github/workflows/release.yml` ("Releasing" in [CONTRIBUTING.md](CONTRIBUTING.md)). A
  release-prep PR sets `version` in `package.json` and the install specs and runs `node scripts/changelog.mjs release`;
  once it is on `master` and CI passed, start the release with
  `gh workflow run release.yml --ref master -f sha=<its full sha>`. The workflow builds `dist/`, makes the release
  commit on a temporary `release/v<version>` branch, checks and stages everything, and waits for the owner to approve
  the `release` environment; only then does it create the tag `v<version>` and the GitHub Release. Never push a tag or a
  `release/*` branch, and never commit, tag or publish a release by hand. Agents never approve a release, never call the
  deployment-approval API, and never bypass a ruleset or the environment.
- No personal email in anything we publish. Every commit is authored and committed as
  `joe-broadhead <91376460+joe-broadhead@users.noreply.github.com>`, except the release commit and tag, which the
  release workflow makes as `github-actions[bot]`. Before committing or tagging, check that
  `git config user.email` is that address: a fresh clone inherits the machine's global identity, which is not that
  address. Never commit, tag or publish with a work or personal address, or with a local hostname.

## Checks

- `npm ci --ignore-scripts`, then `npm run check`. See [CONTRIBUTING.md](CONTRIBUTING.md).
- The stages are `typecheck`, `copies`, `build`, `unit`, `tui`, `host`, `pack`, `icons` and `actionlint` (a notice when `actionlint` is not on PATH). CI runs `actionlint` in its own job.
- Host tests run on every release in `TESTED_HOSTS`, 2.2.3, 2.2.4, 2.2.5 and 2.2.6, and the pack stage runs every stock binary too.
- Host tests run OpenCode with HOME, `OPENCODE_TEST_HOME`, XDG directories and TMPDIR inside a temporary root, which is a git repository under the system's `/tmp` (never under TMPDIR or HOME), each stock host on its own port, and never call Slack.
- `test/host/slack-catalog.ts` holds Slack's live tool schemas; the fake server serves them and `test/unit/docs.test.ts` checks every parameter the skill and the docs name against them. Refresh it when Slack changes a tool; `npm run drift` compares the reads with a live, signed-in OpenCode (manual, not part of `check`).
- Do not skip, weaken or delete a test to get green.

## Writing

- Never commit tokens, client secrets, real client IDs, personal data, Slack content or absolute local paths. Docs use `YOUR_SLACK_CLIENT_ID`.
- Commit messages use `type(scope): summary`.
- Keep the README, `docs/`, `SECURITY.md` and `CHANGELOG.md` in step with the code.
