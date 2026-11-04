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

`npm run check` runs, in order: the type check of `src`, `scripts` and `test` (`tsc` emits nothing); the build, which bundles `dist/index.js` and `dist/tui.js` with esbuild (`scripts/build.ts`); the unit tests (including the forbidden-API scan); the TUI tests against the built dialog; the host tests on the embedded `@opencode/sdk` and on stock `opencode` 2.2.3, 2.2.4 and 2.2.5 (`TESTED_HOSTS` in `src/defaults.ts`, the one list of tested releases); and the package test, which packs, installs and loads the tarball and checks that `dist/` holds only the two self-contained bundles. CI runs `npm ci --ignore-scripts` and `npm run check` on Linux and macOS, x64 and arm64.

By default, the host and package tests install `@opencode/cli` from npm into a temporary directory, once per version and run. To use binaries you already have:

```sh
OPENCODE_BIN_2_2_3=/path/to/2.2.3/opencode OPENCODE_BIN_2_2_4=/path/to/2.2.4/opencode OPENCODE_BIN_2_2_5=/path/to/2.2.5/opencode npm run check
```

`npm install --prefix <dir> --ignore-scripts @opencode/cli@2.2.3` gets one; the binary is `node_modules/@opencode/cli-<os>-<arch>/bin/opencode` in that directory. The tests check each binary's version and that OpenCode's paths stay inside the test's temporary root. Each root is a git repository under the system's `/tmp`, never under `TMPDIR` or your home, so OpenCode cannot pick up your own `.opencode` agents or skills; each stock host listens on its own free port. They never call Slack.

## Changing Slack's tool table

`src/tools.ts` classifies Slack's tools. When status names an unknown tool, check it in Slack's MCP documentation and choose its class: `read` only for tools that change nothing and read what public scopes reach; `private` for searches that include private conversations; `file` for file contents; `write` for anything that creates, changes, sends or uploads. Update `src/tools.ts`, the tests, the tables in `docs/configuration.md` and the README, and `CHANGELOG.md`.

## Releasing

1. Set the version in `package.json` and `package-lock.json`, and date its `CHANGELOG.md` section.
2. Push a `vX.Y.Z` tag on `master`.
3. Approve the run in the `release` environment.
4. `release.yml` refuses a private package or a tag that differs from the version, runs `npm run check`, packs once, runs the package test against that tarball, and publishes it with npm trusted publishing and provenance. A version already on npm is skipped.
