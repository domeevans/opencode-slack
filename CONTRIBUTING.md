# Contributing

## Setup

You need Node.js 24 or later with npm, and [Bun](https://bun.sh) 1.4.

```sh
git clone https://github.com/joe-broadhead/opencode-slack.git
cd opencode-slack
npm ci --ignore-scripts
npm run check
```

To try a checkout in OpenCode, build it with `npm run build` and point a `plugins` entry at the checkout directory:

```jsonc
{ "plugins": [{ "package": "/path/to/opencode-slack", "options": {} }] }
```

## Checks

`npm run check` runs, in order: the type check of `src`, `scripts` and `test` (`tsc` emits nothing); the build, which bundles `dist/index.js` and `dist/tui.js` with esbuild (`scripts/build.ts`); the unit tests (including the forbidden-API scan); the TUI tests against the built dialog; the host tests on the embedded `@opencode/sdk` and on stock `opencode` 2.2.3, 2.2.4, 2.2.5 and 2.2.6 (`TESTED_HOSTS` in `src/defaults.ts`, the one list of tested releases); and the package test, which packs, installs and loads the tarball and checks that `dist/` holds only the two self-contained bundles. CI runs `npm ci --ignore-scripts` and `npm run check` on Linux and macOS, x64 and arm64.

By default, the host and package tests install `@opencode/cli` from npm into a temporary directory, once per version and run. To use binaries you already have:

```sh
OPENCODE_BIN_2_2_3=/path/to/2.2.3/opencode OPENCODE_BIN_2_2_4=/path/to/2.2.4/opencode OPENCODE_BIN_2_2_5=/path/to/2.2.5/opencode OPENCODE_BIN_2_2_6=/path/to/2.2.6/opencode npm run check
```

`npm install --prefix <dir> --ignore-scripts @opencode/cli@2.2.3` gets one; the binary is `node_modules/@opencode/cli-<os>-<arch>/bin/opencode` in that directory. The tests check each binary's version and that OpenCode's paths stay inside the test's temporary root. Each root is a git repository under the system's `/tmp`, never under `TMPDIR` or your home, so OpenCode cannot pick up your own `.opencode` agents or skills; each stock host listens on its own free port. They never call Slack.

## Checking Slack's tools for drift

`test/host/slack-catalog.ts` holds Slack's tool schemas as OpenCode lists them; the fake server serves them, and the docs test checks every parameter the skill and docs name against them. To compare it with the live server, run OpenCode with Slack signed in, then `npm run drift`. It reads the tools RPC's `describe` (`opencode api post /api/rpc/slack.workspace.tools/describe`) and reports each read tool whose types, allowed values, parameters or required names differ. It covers the reads only, because writes are never methods: check the write signatures with Code Mode's `search({ namespace: "slack" })`. It is not part of `npm run check`.

## Changing Slack's tool table

`src/tools.ts` classifies Slack's tools. When status names an unknown tool, check it in Slack's MCP documentation and choose its class: `read` for tools that change nothing; `private` for searches across private conversations; `file` for file contents; `write` for anything that creates, changes, sends or uploads. Update `src/tools.ts`, the tests, the tables in `docs/configuration.md` and the README, and `CHANGELOG.md`.

## Releasing

Every plugin releases as `v0.0.0`, and it installs from that GitHub tag. The release is one commit on top of a `master`
head that CI passed, and the tag points at it.

1. Set `version` to `0.0.0` in `package.json`, date the `## [0.0.0]` entry in `CHANGELOG.md`, then run `npm run check`.
2. Push that commit to `master`, and wait for CI to pass on it.
3. In a clean checkout of `master` at that commit, run `node scripts/release-commit.mjs --ci-sha <its full sha>`. It builds
   `dist/`, removes the lifecycle scripts, and creates the signed commit and the signed annotated tag `v0.0.0`. It never
   pushes; `--dry-run` shows the change first.
4. Push the tag only: `git push origin v0.0.0`.
5. Approve the run in the `release` environment. The release workflow checks the tag and its commit, installs the tag on
   each stock OpenCode host (2.2.3 to 2.2.6), packs it, and creates the GitHub Release with the notes, the tarball and
   `SHA256SUMS`.

A tag that already exists stops step 3. Delete the old tag and its Release first, then start again.
