// Pack, install and import the published shape; with PACK_TARBALL (or SLACK_PACK_TARBALL) set, the release's own tarball instead. The
// tarball holds exactly the files whitelist and installs with scripts disabled and no dependencies. Installed alone,
// it loads in each stock OpenCode release, which provides @opencode/plugin itself. Next to the host packages
// OpenCode 2.2.3 ships, both entry points import under Bun.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, join, relative, sep } from "node:path"
import { gunzipSync } from "node:zlib"
import { METHODS, TOOLS_RPC_ID } from "../../src/host/tools-rpc.js"
import { defaultRules } from "../../src/permissions.js"
import type { Status } from "../../src/status.js"
import { CLIENT_ID, HOST_VERSIONS, isolatedEnv, removeInstalls, REPO, startBinary, tempDirectory } from "../host/harness.js"

setDefaultTimeout(300_000)

interface Manifest {
  readonly name: string
  readonly version: string
  readonly files: readonly string[]
  readonly exports: Readonly<Record<string, string>>
  readonly devDependencies: Readonly<Record<string, string>>
}

const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as Manifest
// Outside the repository, so module resolution cannot fall back to the repository's own node_modules.
const work = tempDirectory("slack-pack-", true)
afterAll(() => {
  rmSync(work, { recursive: true, force: true })
  removeInstalls()
}, { timeout: 120_000 })

const MAX_ENTRIES = 50
// Raised from 150 KiB for the JSON reads mentions_list and dms_list (about 10 KB of minified code and 3 KB of docs).
const MAX_UNPACKED_BYTES = 170 * 1024
// The host packages OpenCode 2.2.3 provides to plugins, at the versions pinned for development.
const HOST_PACKAGES = ["@opencode/plugin", "@opentui/core", "@opentui/solid", "solid-js"]
const SERVER_MODULES = [/^node:/, /^@opencode\/plugin(?:\/|$)/]
const TUI_MODULES = [...SERVER_MODULES, /^@opentui\/(?:core|solid)(?:\/|$)/, /^solid-js(?:\/|$)/]
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall", "prepare", "prepack", "postpack", "prepublish"]

function run(command: string, args: readonly string[], cwd: string, env: Readonly<Record<string, string>> = {}): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, npm_config_update_notifier: "false", ...env } })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status}):\n${result.stderr}\n${result.stdout}`)
  return result.stdout
}

interface Packed {
  readonly filename: string
  readonly unpackedSize: number
  readonly entryCount: number
  readonly files: readonly { readonly path: string }[]
}

/** The files of a tarball npm packed, read from its ustar headers: every entry is a regular file under `package/`. */
function readTarball(path: string): Packed {
  const tar = gunzipSync(readFileSync(path))
  const files: { path: string }[] = []
  let unpackedSize = 0
  for (let at = 0; at + 512 <= tar.length && tar[at] !== 0; ) {
    const field = (start: number, length: number) => tar.subarray(at + start, at + start + length).toString("utf8").replace(/\0.*$/s, "")
    const size = Number.parseInt(field(124, 12).trim() || "0", 8)
    const name = [field(345, 155), field(0, 100)].filter(Boolean).join("/")
    if (field(156, 1) === "0" || field(156, 1) === "") {
      files.push({ path: name.replace(/^package\//, "") })
      unpackedSize += size
    }
    at += 512 + Math.ceil(size / 512) * 512
  }
  return { filename: basename(path), unpackedSize, entryCount: files.length, files }
}

let packed: Packed | undefined
/** The tarball under test: the release's own (PACK_TARBALL, which the release workflow sets, or SLACK_PACK_TARBALL), or a fresh pack of the built checkout. */
function pack(): Packed {
  if (packed !== undefined) return packed
  const given = process.env.PACK_TARBALL || process.env.SLACK_PACK_TARBALL
  if (given !== undefined && given !== "") {
    writeFileSync(join(work, basename(given)), readFileSync(given))
    packed = readTarball(given)
    return packed
  }
  // Build explicitly: the package has no prepare script, and npm would run one even with --ignore-scripts.
  run("npm", ["run", "build"], REPO)
  packed = (JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", work], REPO)) as Packed[])[0]!
  // The ustar reader must agree with npm on its own output.
  const read = readTarball(join(work, packed.filename))
  if (JSON.stringify(read.files.map((file) => file.path).sort()) !== JSON.stringify(packed.files.map((file) => file.path).sort())) {
    throw new Error(`the tarball reader lists ${JSON.stringify(read.files)}, npm lists ${JSON.stringify(packed.files)}`)
  }
  return packed
}

const consumer = join(work, "consumer")
const installed = join(consumer, "node_modules", ...pkg.name.split("/"))
let alone = false
function installAlone(): void {
  if (alone) return
  mkdirSync(consumer, { recursive: true })
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "slack-pack-consumer", private: true, type: "module" }))
  run("npm", ["install", join(work, pack().filename), "--ignore-scripts", "--no-audit", "--no-fund"], consumer)
  alone = true
}

/** The files each `files` entry should contribute: dist holds exactly the build output of src/. */
function expectedFiles(): string[] {
  const tree = (dir: string) => readdirSync(join(REPO, dir), { recursive: true, withFileTypes: true })
    .filter((item) => item.isFile() && item.name !== ".DS_Store")
    .map((item) => relative(REPO, join(item.parentPath, item.name)).split(sep).join("/"))
  return ["package.json", ...pkg.files.flatMap((entry) => {
    // Two self-contained bundles, and nothing else: no sibling module a host could keep cached across an update.
    if (entry === "dist") return ["dist/index.js", "dist/tui.js"]
    return statSync(join(REPO, entry)).isDirectory() ? tree(entry) : [entry]
  })].sort()
}

/** Every module specifier in `file`: static imports and re-exports, dynamic imports and require calls. */
function specifiers(file: string): string[] {
  const source = readFileSync(file, "utf8")
  const pattern = /(?:^|[\s;}])(?:import|export)\s*(?:[^'"`;]*?\sfrom\s*)?["'`]([^"'`]+)["'`]|\bimport\s*\(\s*([^)]*?)\s*\)|\brequire\s*\(\s*([^)]*?)\s*\)/g
  return [...source.matchAll(pattern)].map((match) => (match[1] ?? match[2] ?? match[3])!)
}

/** Specifiers in `file` that are relative, computed, or not provided by OpenCode. */
function foreignImports(file: string, allowed: readonly RegExp[]): string[] {
  return specifiers(file)
    .map((specifier) => specifier.replace(/^["'`](.*)["'`]$/, "$1"))
    .filter((specifier) => !allowed.some((pattern) => pattern.test(specifier)))
    .sort()
}

describe("the tarball", () => {
  test("holds exactly the files whitelist, with no source JSX, within the size budget", () => {
    const { files, entryCount, unpackedSize } = pack()
    const paths = files.map((file) => file.path).sort()
    expect(paths).toEqual(expectedFiles())
    // The assets are Jelly's icon and the two PNG sizes the icon contract declares.
    expect(paths.filter((path) => path.startsWith("assets/"))).toEqual(["assets/icon-128.png", "assets/icon-256.png", "assets/icon.svg"])
    expect(paths.filter((path) => /\.(?:tsx|jsx)$/.test(path) || path.includes("node_modules/"))).toEqual([])
    for (const target of Object.values(pkg.exports)) expect(paths).toContain(target.replace(/^\.\//, ""))
    expect(paths.filter((path) => path.endsWith(".d.ts"))).toEqual([])
    expect(entryCount).toBeLessThan(MAX_ENTRIES)
    expect(unpackedSize).toBeLessThan(MAX_UNPACKED_BYTES)
  })

  // Do not assert "private". This test runs against the release tarball, and release.yml checks private itself.
  test("has no dependencies, peers or install scripts, and states the tested host range", () => {
    installAlone()
    const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8")) as Record<string, unknown>
    expect(manifest.opencode).toMatchObject({ host: ">=2.2.3 <2.3.0", vendor: { id: "slack", name: "Slack", domain: "slack.com" } })
    expect((manifest.opencode as { icons: { src: string }[] }).icons.map((icon) => icon.src))
      .toEqual(["assets/icon.svg", "assets/icon-128.png", "assets/icon-256.png"])
    for (const field of ["dependencies", "peerDependencies", "peerDependenciesMeta", "optionalDependencies", "bundleDependencies", "bundledDependencies"]) {
      expect({ field, value: manifest[field] }).toEqual({ field, value: undefined })
    }
    expect(Object.keys((manifest.scripts ?? {}) as object).filter((name) => INSTALL_SCRIPTS.includes(name))).toEqual([])
  })

  test("installs alone, bringing nothing else: no typescript, Babel, tree-sitter, effect or UI runtime", () => {
    installAlone()
    const names = readdirSync(join(consumer, "node_modules"), { withFileTypes: true })
      .filter((item) => item.isDirectory())
      .flatMap((item) => (item.name.startsWith("@") ? readdirSync(join(consumer, "node_modules", item.name)).map((name) => `${item.name}/${name}`) : [item.name]))
    expect(names).toEqual([pkg.name])
  })

  test("dist imports only modules OpenCode provides to plugins", () => {
    installAlone()
    expect(foreignImports(join(installed, "dist", "index.js"), SERVER_MODULES)).toEqual([])
    expect(foreignImports(join(installed, "dist", "tui.js"), TUI_MODULES)).toEqual([])
  })

  // A host that reloads a plugin in place keeps module records for unchanged paths. With no sibling modules and no
  // relative, dynamic or required imports, a new entry can never be paired with a stale cached module.
  test("each shipped JavaScript file is self-contained, so an in-place update cannot load a stale sibling", () => {
    installAlone()
    const shipped = readdirSync(join(installed, "dist"), { recursive: true }).map(String).sort()
    expect(shipped).toEqual(["index.js", "tui.js"])
    for (const file of shipped) {
      const relative = specifiers(join(installed, "dist", file)).filter((specifier) => !/^["'`]?(?:node:|@opencode\/plugin|@opentui\/|solid-js)/.test(specifier))
      expect({ file, relative }).toEqual({ file, relative: [] })
    }
  })
})

describe.each(HOST_VERSIONS)("the installed package on stock opencode %s", (version) => {
  test("is active, registers the server and default rules, and answers status and the tools RPC", async () => {
    installAlone()
    const host = await startBinary(version, installed)
    try {
      const location = host.location("defaults")
      const status = (await host.client.rpc.call({ rpcID: "slack.workspace", method: "status", location, input: {} })).output as Status
      expect(status).toMatchObject({ version: pkg.version, host: { version, range: ">=2.2.3 <2.3.0", tested: true }, client: { id: CLIENT_ID } })
      const plugin = (await host.client.plugin.list({ location })).data.find((item) => item.id === "slack.workspace")
      // exports has no ./rpc, so OpenCode lists no RPC part; the server part registers the status RPC above.
      expect(plugin).toMatchObject({ state: { status: "active" }, features: { server: true, tui: true }, source: { path: installed } })
      const state = (await host.client.rpc.call({ rpcID: "slack.test.probe", method: "state", location, input: {} })).output as {
        registered: { type: string; url: string; oauth: { client_id: string; redirect_uri: string; scope: string } }
        agents: { id: string; permissions: { action: string; resource: string; effect: string }[] }[]
      }
      expect(state.registered).toEqual({
        type: "remote",
        url: "https://mcp.slack.com/mcp",
        oauth: { client_id: CLIENT_ID, redirect_uri: "http://localhost:8765/callback", scope: "channels:history channels:read search:read.public users:read" },
      })
      const rules = defaultRules()
      const build = state.agents.find((agent) => agent.id === "build")
      const at = build?.permissions.findIndex((rule) => rule.action === "*" && rule.resource === "*" && rule.effect === "allow") ?? -1
      expect(build?.permissions.slice(at + 1, at + 1 + rules.length)).toEqual(rules)
      expect((await host.client.skill.list({ location })).data.map((skill) => skill.id)).toContain("slack-search")
      const tools = (await host.client.rpc.call({ rpcID: TOOLS_RPC_ID, method: "describe", location, input: {} })).output as { methods: { name: string }[] }
      expect(tools.methods.map((method) => method.name)).toEqual([...METHODS.map((method) => method.name), "events_list", "mark_read", "status", "mentions_list", "dms_list"])
      const paths = (await host.client.rpc.call({ rpcID: "slack.test.probe", method: "paths", location, input: {} })).output as Record<string, string>
      expect(Object.keys(paths).length).toBeGreaterThan(0)
      expect(Object.entries(paths).filter(([, path]) => !path.startsWith(host.root + sep))).toEqual([])
    } finally {
      await host.close()
    }
  })
})

describe("the installed package next to OpenCode's host packages", () => {
  test("imports '.' and './tui' under Bun", () => {
    installAlone()
    run("npm", ["install", ...HOST_PACKAGES.map((name) => `${name}@${pkg.devDependencies[name]}`), "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"], consumer)
    writeFileSync(join(consumer, "probe.mjs"), [
      `const server = (await import(${JSON.stringify(pkg.name)})).default`,
      `const tui = (await import(${JSON.stringify(`${pkg.name}/tui`)})).default`,
      "console.log(JSON.stringify({",
      "  server: { id: server.id, setup: typeof server.setup },",
      "  tui: { id: tui.id, setup: typeof tui.setup },",
      "}))",
    ].join("\n"))
    // The host packages are OpenCode's own code, so they run with OpenCode's home, XDG roots and tmp inside `work`.
    const isolated = isolatedEnv(work)
    for (const dir of Object.values(isolated)) mkdirSync(dir, { recursive: true })
    const env = {
      ...isolated,
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_FREE_MODELS: "1",
    }
    const output = run(process.execPath, [join(consumer, "probe.mjs")], consumer, env)
    expect(JSON.parse(output.trim().split("\n").at(-1)!)).toEqual({
      server: { id: "slack.workspace", setup: "function" },
      tui: { id: "slack.workspace.tui", setup: "function" },
    })
  })
})
