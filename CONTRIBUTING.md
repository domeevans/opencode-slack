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

Each release is the GitHub tag `v<version>`, where `<version>` is the `version` in `package.json`, and users install from
that tag. The release is one commit on top of a `master` head that CI passed, and the tag points at it. The release
workflow makes both, in GitHub Actions: nobody builds, commits or tags a release on their own machine, and no personal
key signs it.

While changes land, their notes go under `## [Unreleased]` at the top of `CHANGELOG.md`. Each earlier GitHub release is
a `## [x.y.z] - YYYY-MM-DD` heading below it, newest first, and the npm history stays last, under
`## Earlier releases on npm`.

1. On `master`, set `version` in `package.json` to the new version, and change every install spec in the README,
   `CONTRIBUTING.md` and `docs/` to `#v<version>` (`test/docs.test.ts` fails until they match). Then run
   `node scripts/changelog.mjs release`: it turns `## [Unreleased]` into `## [<version>] - <today>`, above the earlier
   releases, and refuses a CHANGELOG it cannot shape. Run `npm run check`.
2. Push that commit to `master`, and wait for CI to pass on it.
3. Start the release with that commit's full sha:
   `gh workflow run release.yml --ref master -f sha=<full sha>`, or from Actions → release →
   Run workflow, on `master`.
4. Read the run's summary, then approve the `release` environment. The summary is on the run page, under the `stage`
   job: the tag, the parent and its CI run, the release commit and its tree, the sha256 of `SHA256SUMS` and the staged
   artifact's id, `SHA256SUMS` itself, and the notes. Open the release commit on `release/v<version>` and read them
   before approving: the approval releases exactly those bytes. Only the owner approves a release. Agents never approve
   one, never call the deployment-approval API, and never bypass a ruleset or the environment; the kit's scripts make
   only their own GitHub calls and refuse every other.
5. Check the published Release: not a draft, its notes, and every asset against `SHA256SUMS`.

Before the approval, the workflow:
- **plans:** refuses a run that is not on `master`, a sha that is not `master`'s head, a sha without a successful `ci.yml`
  push run, a version that is not `x.y.z`, a CHANGELOG whose newest release is not this version, a release that does not
  move forward from the last published Release, a leftover `release/v<version>` branch, a native run that did not build
  this sha on `master`, by hand, with success, and a missing `native_run` (or one given to a plugin that is not native);
- **builds** `dist/` with `npm ci --ignore-scripts` and `npm run build`, with a read-only token, and writes the release
  files: `dist/`, `package.json` without its lifecycle scripts, and the vetted native manifest;
- **commits** them on a temporary branch `release/v<version>` at the parent, through GitHub's API with the workflow's token,
  so GitHub signs the commit (author `github-actions[bot]`, committer GitHub). This job runs no npm. It refuses a commit
  that GitHub does not verify, or whose parent or tree is not the one the files give;
- **verifies** on a fresh runner: the commit's identity, one parent on `master`, `package.json` exactly the parent's
  without the lifecycle scripts, only regular files in the allowed paths, no `package.json` under `dist/`, and a second,
  independent build of the parent (its own job) equal to the committed `dist/` byte for byte;
- **installs** the release commit with `plugin add` on each stock OpenCode host (2.2.3 to 2.2.6);
- **packs** the commit before installing anything and keeps that tarball, then runs the pack stage against a copy;
- **stages** the Release: verifies the attested native files, writes `SHA256SUMS` and the notes (the version's CHANGELOG
  section), and shows them all in the run summary with the sha256 of `SHA256SUMS`.

A job either runs repository or dependency code (`npm ci`, the build, the pack stage, a host install) and has no write
token, or uses the API and runs only the kit's scripts on a fresh checkout, after checking that the release commit's
`scripts/` and `.github/` are the parent's. The first kind is not token-free: `actions/checkout` fetches with the job's
read-only (`contents: read`) token, and its post step and the artifact uploads run after repository code on the same
runner, so that code could reach a read-only token for this public repository and the runner's artifact token. Jobs
pass files as artifacts downloaded by the id the uploading job gave, and each is checked again on arrival.

After the approval, it downloads the staged artifact by the id the summary names, and refuses unless `SHA256SUMS` has
the sha256 the summary shows and every staged file matches it, and every native file is the one the release commit's
`manifest/native.json` pins, size and sha256, with each gzip holding the pinned executable. Then it checks everything again, creates the annotated tag
`v<version>` on the release commit (tagger `github-actions[bot]`, unsigned), checks the tag, creates the Release with the
notes, the tarball, the native files and `SHA256SUMS`, and deletes `release/v<version>`. The tag keeps the commit.

GitHub's signature and the bot identity show only that GitHub made the commit through its API for the workflow; anyone
with write access can make such a commit. What ties the release to `master` is its content: one parent CI passed, the
exact `package.json`, the allowed paths and the byte-for-byte rebuild. Never relax those because the commit is signed.

**A rejected, expired or failed run** leaves nothing behind: the `cleanup` job deletes `release/v<version>` when it points
at the parent or at that run's commit, and never touches another branch. No tag exists before the approval, so the
version is not burned: fix `master` and start again. If `cleanup` itself failed, the next run refuses until the branch
is deleted: `gh api -X DELETE repos/joe-broadhead/opencode-slack/git/refs/heads/release/v<version>`.

**Resume.** If the run fails after creating the tag and before the Release is complete, start it again with the same `sha`. The plan finds the kit's tag on a release commit on that sha with no published Release, and resumes:
it makes no new commit, checks and installs the tagged commit, stages the files, and after a new approval reuses the tag
and adds what the Release lacks. Delete a draft Release a failed upload left first: the publish step refuses a draft.
Any other existing tag is refused: release the next version.

The repository's tag ruleset keeps a `v*` tag from being moved or deleted. A stray `v*` tag, one that never became a
Release, does not block later releases: only published Releases count, and drafts do not. Its version cannot be
released, so release the next one. To remove the tag anyway, an admin disables the `release tags` ruleset, deletes the
tag, and restores the ruleset exactly as it was.

**Known limit: a `v*` tag pushed by hand.** No ruleset limits who creates a `v*` tag, so anyone with write access can
push one by hand, pointing at any commit. Such a tag has no published Release, the forward-only check ignores it, and
Jelly installs only a published Release whose `SHA256SUMS` it verifies. But a user who installs
`github:joe-broadhead/opencode-slack#v<x>` directly gets whatever that tag points at. Only the release workflow makes
release tags; never push one by hand.

The release kit is these files, the same in every plugin: `scripts/release-rules.mjs`, `scripts/release-commit.mjs`,
`scripts/release-github.mjs`, `scripts/check-release-shape.mjs`, `scripts/changelog.mjs`, `scripts/release-version.mjs`,
`scripts/release-pack.mjs`, `scripts/publish-release.mjs`, `scripts/attach-native.mjs`, `scripts/native-manifest.mjs`,
`scripts/tested-hosts.mjs`, `scripts/check-release-plugin-add.sh`, `scripts/release-kit.test.mjs` and
`.github/workflows/release.yml`. Do not re-run the older `apply-release-kit.mjs`: it writes back the kit that could
release only `v0.0.0`.

Each release has its own tag, and a Git install does not update by itself. To move to a newer release, remove the old entry with `opencode plugin remove github:joe-broadhead/opencode-slack#v<old version>`, then add the new tag with `opencode plugin add github:joe-broadhead/opencode-slack#v<version>`.

Or add the plugin to `opencode.json` instead, with the same spec:

```json
{ "plugins": [{ "package": "github:joe-broadhead/opencode-slack#v0.0.0" }] }
```
