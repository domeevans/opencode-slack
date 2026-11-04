# Architecture

The plugin is configuration and status code around Slack's hosted MCP server. OpenCode does the rest: the MCP connection, OAuth with PKCE, token storage and refresh, Code Mode and permission prompts.

## Parts

| Part | Entry | Job |
| --- | --- | --- |
| Server | `src/index.ts` (`slack.workspace`) | Reads the options, resolves the Slack app client, registers the MCP server, the default permission rules, the skill, `/slack-status`, the status RPC and the tools RPC. |
| TUI | `src/tui.tsx` (`slack.workspace.tui`) | The palette command **Slack: Status** and `/slack`, which open one dialog that renders the status RPC. |
| RPC contract | `src/rpc.ts` (`slack.workspace`) | The JSON Schema contract of the `status` method. Inlined into both bundles: the server registers it and the TUI calls it. `exports` lists only `.` and `./tui`. |
| Tools RPC | `src/host/tools-rpc.ts` (`slack.workspace.tools`) | `describe` and one method per known read, so a script can call them with no model ([Scripting](scripting.md)). A copy of a module shared by several plugins, with Slack's part in one marked block. Inlined into `dist/index.js`. |

## Build

`scripts/build.ts` bundles `src/index.ts` into `dist/index.js` and `src/tui.tsx` into `dist/tui.js` with esbuild. The TUI source first goes through Babel's Solid universal transform for `@opentui/solid`. Each bundle is self-contained: shared modules are inlined, and only `@opencode/plugin`, `@opentui/*`, `solid-js` and `node:*` stay external. The skills are read at runtime from `skills/` next to `dist/`.

## Modules

- `options.ts`: validates the plugin options. Errors name the field and never echo its value.
- `connect.ts`: the **Slack app** `/connect` entry (a key method whose key is the client ID), client resolution (options, then `/connect`; no client ships), and the **Slack** display name of the server's own integration.
- `server.ts`: the MCP server config, registered only when there is a client and the name is free.
- `permissions.ts` and `tools.ts`: the tool classes, the default rule block inserted after each agent's base allow, and the reads a script may call.
- `host/tools-rpc.ts`: the tools RPC. See [Tools RPC](#tools-rpc).
- `status.ts`: the one status model and its rows. `/slack-status`, the RPC and the dialog all render it.
- `skills.ts`: loads `skills/slack-search/SKILL.md`.
- `host-version.ts`: the supported range check, and the tested releases.

## Runtime flow

1. Setup parses the options and checks the host version. On invalid options, or a host outside the supported range, it registers only the status surfaces.
2. Without `oauth.client_id`, it adds **Slack app** to `/connect` and reads the stored client from OpenCode's credential store.
3. The MCP transform registers `https://mcp.slack.com/mcp` with that client, or nothing when there is none. A tool transform gives the server's Code Mode namespace its description (`NAMESPACE_DESCRIPTION` in `tools.ts`).
4. When the plugin is set up, the tools RPC registers after the status RPC, with the server name from the options. It is a conflict while `nameInUse` is set.
5. A background listener handles `credential.updated` and `credential.switched` (the client changed: `ctx.mcp.reload()`) and `integration.updated` (OpenCode re-registered the server's integration: rename it **Slack** again). Setup's cleanup stops it.

The plugin defines no tools, makes no network requests and never reads Slack tokens.

## Tools RPC

`slack.workspace.tools` lets a script call the known reads with no model; [Scripting](scripting.md) is the user's view. Its methods are `describe` and one per tool in `SCRIPTABLE_TOOLS` (`src/tools.ts`): the classes `read`, `private` and `file`, named after the upstream tool. It is an allowlist: a write or a tool that Slack adds later is never a method.

A call is `{ sessionID, input }`. The module:

1. looks up the session with `ctx.session.get`, and its agent's rules with `ctx.agent.get` in the session's location (`SESSION_UNKNOWN`, `SESSION_AGENT_REQUIRED`);
2. refuses the tool when the last rule that matches `<server>_<tool>` on `*`, in the agent's rules followed by the session's, is a deny: OpenCode hides such a tool from the model (`PERMISSION_DENIED`);
3. refuses with `SERVER_CONFLICT` while the user's own server holds the name;
4. finds the tool's executor in `ctx.tool.list()`, or names the server's connection state (`AUTH_REQUIRED` and so on) or `TOOL_UNAVAILABLE`;
5. calls `execute(input, { sessionID, agent, messageID, id, signal, progress })` with a new call id. OpenCode's executor checks `<server>_<tool>` on `*` itself, with the agent's rules, the session's rules and saved approvals, and sends OpenCode's own credential;
6. returns `{ output?, text }`: the tool's structured content and its text parts.

While a call runs, its id is live. A `permission.hook("evaluate")` turns an `ask` whose source id is live into a deny, so the script gets `PERMISSION_DENIED` at once and no prompt waits; this is how the private search and the file read are refused without an allow rule. It changes nothing else; it is the plugin's only permission hook, and the forbidden-API scan allows exactly this one.

A `Tool.Error` with a cause is a permission refusal; one without a cause is Slack's own error (`isError`), which becomes `UPSTREAM_ERROR` with its first line, at most 300 characters, with tokens and URL queries removed. Any other failure is OpenCode's own and passes through.

OpenCode decodes a plain JSON Schema input with Effect, which drops unknown keys of an object that has properties instead of refusing them. So the envelope's schema carries a strict Standard Schema validator as a non-enumerable `~standard` property, which OpenCode prefers. The contract still reads and serialises as plain JSON Schema, and OpenCode answers a bad envelope with `rpc.invalid_input`.

The executor does not run `execute.before` and `execute.after` hooks. Slack has none, so results are unchanged. `ctx.tool.list()` returning callable executors is not documented as an entry point: the host test checks the whole path on the embedded SDK and on stock 2.2.3, 2.2.4 and 2.2.5, against the offline fake server, which serves Slack's own tool schemas (`test/host/slack-catalog.ts`).
