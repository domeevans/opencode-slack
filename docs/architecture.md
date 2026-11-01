# Architecture

The plugin is configuration and status code around Slack's hosted MCP server. OpenCode does the rest: the MCP connection, OAuth with PKCE, token storage and refresh, Code Mode and permission prompts.

## Parts

| Part | Entry | Job |
| --- | --- | --- |
| Server | `src/index.ts` (`slack.workspace`) | Reads the options, resolves the Slack app client, registers the MCP server, the default permission rules, the skill, `/slack-status` and the status RPC. |
| TUI | `src/tui.tsx` (`slack.workspace.tui`) | The palette command **Slack: Status** and `/slack`, which open one dialog that renders the status RPC. |
| RPC contract | `src/rpc.ts` (`slack.workspace`) | The JSON Schema contract of the `status` method. Inlined into both bundles: the server registers it and the TUI calls it. `exports` lists only `.` and `./tui`. |

## Build

`scripts/build.ts` bundles `src/index.ts` into `dist/index.js` and `src/tui.tsx` into `dist/tui.js` with esbuild. The TUI source first goes through Babel's Solid universal transform for `@opentui/solid`. Each bundle is self-contained: shared modules are inlined, and only `@opencode/plugin`, `@opentui/*`, `solid-js` and `node:*` stay external. The skills are read at runtime from `skills/` next to `dist/`.

## Modules

- `options.ts`: validates the plugin options. Errors name the field and never echo its value.
- `connect.ts`: the **Slack app** `/connect` entry (a key method whose key is the client ID), client resolution (options, then `/connect`; no client ships), and the **Slack** display name of the server's own integration.
- `server.ts`: the MCP server config, registered only when there is a client and the name is free.
- `permissions.ts` and `tools.ts`: the tool classes and the default rule block inserted after each agent's base allow.
- `status.ts`: the one status model and its rows. `/slack-status`, the RPC and the dialog all render it.
- `skills.ts`: loads `skills/slack-search/SKILL.md`.
- `host-version.ts`: the tested host range check.

## Runtime flow

1. Setup parses the options and checks the host version. On invalid options or an untested host it registers only the status surfaces.
2. Without `oauth.client_id`, it adds **Slack app** to `/connect` and reads the stored client from OpenCode's credential store.
3. The MCP transform registers `https://mcp.slack.com/mcp` with that client, or nothing when there is none.
4. A background listener handles `credential.updated` and `credential.switched` (the client changed: `ctx.mcp.reload()`) and `integration.updated` (OpenCode re-registered the server's integration: rename it **Slack** again). Setup's cleanup stops it.

The plugin defines no tools, makes no network requests and never reads Slack tokens.
