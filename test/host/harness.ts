// Starts OpenCode hosts for the host test: the embedded public `@opencode/sdk`, or a stock `opencode serve` binary.
// Each host gets its own temp root under the system's /tmp, never under TMPDIR or HOME, where OpenCode's upward search
// would find a `.opencode` folder of the person running the tests; the root is a git repository, which ends that
// search. It holds HOME, OpenCode's test home, the XDG directories, TMPDIR, its database
// and one project directory per case. The embedded host also moves the process working directory into that root,
// because the SDK opens a location at it. The Slack server is kept offline by the probe plugin. Outbound HTTP goes
// to a dead proxy, and stock binaries also disable model fetch, autoupdate and free models. A stock load asserts
// that every `opencode debug paths` entry stays inside the root.
import { spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { arch, platform } from "node:os"
import { join, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { OpenCode as Remote, type OpenCodeClient } from "@opencode/client"
import { TESTED_HOSTS } from "../../src/defaults.js"
import { defaultRules, type Rule } from "../../src/permissions.js"

export const REPO = realpathSync(fileURLToPath(new URL("../..", import.meta.url)))
const PROBE = join(REPO, "test", "host", "probe")
const FAKE_SERVER = join(REPO, "test", "host", "fake-slack-mcp.ts")
export const CLIENT_ID = "TEST_CLIENT_ID"

/** The stock OpenCode releases the plugin is tested on: the one list in src/defaults.ts. */
export const HOST_VERSIONS: readonly string[] = TESTED_HOSTS

/** The system temp directory, resolved (/private/tmp on macOS). Not TMPDIR, which may sit under HOME. */
export const TEMP = realpathSync("/tmp")

/**
 * A new temp directory under TEMP. With `repository`, it is also a git repository, so OpenCode's search for
 * `.opencode` folders and project config stops there instead of walking up into the system's folders.
 */
export function tempDirectory(prefix: string, repository = false): string {
  const path = realpathSync(mkdtempSync(join(TEMP, prefix)))
  if (repository) {
    const result = spawnSync("git", ["init", "--quiet", path], { encoding: "utf8" })
    if (result.status !== 0) throw new Error(`git init ${path} failed: ${result.stderr}`)
  }
  return path
}

type Client = Pick<OpenCodeClient, "agent" | "command" | "integration" | "mcp" | "permission" | "plugin" | "rpc" | "session" | "skill">

const PROJECTS = ["defaults", "rules", "collision", "invalid", "connect", "hosted", "shadowed"] as const
export type Project = (typeof PROJECTS)[number]

export interface Host {
  readonly version: string
  readonly client: Client
  /** The temp root every host file must stay inside. */
  readonly root: string
  /** Where this host keeps its state, relative to the root; the test checks it was written. */
  readonly state: string
  location(project: Project): { readonly directory: string }
  /** The tools OpenCode called on the fake Slack server, in order. */
  toolCalls(): string[]
  close(): Promise<void>
}

const rule = (effect: Rule["effect"]) => (action: string): Rule => ({ action, resource: "*", effect })
const allow = rule("allow")
const deny = rule("deny")

/** The https redirect and listener port the "hosted" project sets. */
export const HOSTED_OAUTH = { redirect_uri: "https://host.example/oauth/return", callback_port: 49231 } as const

/** The project skill the "shadowed" project holds under the bundled skill's id. */
export const SHADOWING_SKILL = join("projects", "shadowed", ".opencode", "skills", "slack-search", "SKILL.md")

/** A server the user configured under the plugin's default name. */
export const USER_SERVER = { type: "remote", url: "https://mcp.example.invalid/mcp", oauth: false } as const

const slack = (plugin: string, options: object) => ({ package: plugin, options })
const probe = (options: object) => ({ package: PROBE, options })
const configOnly = (description: string, permissions?: Rule[]) => ({ description, mode: "primary", ...(permissions ? { permissions } : {}) })

/** Keeps the built-in local providers from probing their default loopback ports. */
const LOCAL_PROVIDERS_OFF = {
  providers: {
    lmstudio: { settings: { baseURL: "" } },
    ollama: { settings: { baseURL: "" } },
    vllm: { settings: { baseURL: "" } },
  },
}

/**
 * Each project's opencode.jsonc, loading the Slack plugin from `plugin`. The probe comes after slack.workspace:
 * transforms run in config order.
 */
function projectConfig(project: Project, plugin: string, callLog: string): object {
  const configured = slack(plugin, { oauth: { client_id: CLIENT_ID } })
  switch (project) {
    case "defaults":
      return {
        ...LOCAL_PROVIDERS_OFF,
        plugins: [configured, probe({ fake: [process.execPath, FAKE_SERVER, callLog] })],
        agents: {
          custom: configOnly("Defined only in user config"),
          locked: configOnly("Denies everything", [deny("*")]),
          // The fix /slack-status gives for an agent defined only in user config.
          fixed: configOnly("Has the default Slack rules", defaultRules()),
        },
      }
    case "rules":
      return {
        ...LOCAL_PROVIDERS_OFF,
        plugins: [configured, probe({})],
        permissions: [allow("slack_slack_send_message"), deny("slack_slack_search_public")],
        agents: {
          custom: configOnly("Defined only in user config"),
          // The fix, followed by the user's own top-level Slack rules so they keep winning.
          fixed: configOnly("Has the default Slack rules", [...defaultRules(), allow("slack_slack_send_message"), deny("slack_slack_search_public")]),
        },
      }
    case "collision":
      return { ...LOCAL_PROVIDERS_OFF, plugins: [configured, probe({})], mcp: { servers: { slack: USER_SERVER } } }
    case "invalid":
      return { ...LOCAL_PROVIDERS_OFF, plugins: [slack(plugin, { oauth: { client_id: CLIENT_ID, bogus: 1 } }), probe({})] }
    case "connect":
      // No client ID in the options: it comes from the /connect Slack app client ID entry.
      return { ...LOCAL_PROVIDERS_OFF, plugins: [slack(plugin, {}), probe({})] }
    case "shadowed":
      // The project's own skill under the bundled skill's id, which OpenCode loads instead.
      return { ...LOCAL_PROVIDERS_OFF, plugins: [configured, probe({})] }
    case "hosted":
      // A hosted return address, which a proxy forwards to OpenCode's listener on the callback port.
      return { ...LOCAL_PROVIDERS_OFF, plugins: [slack(plugin, { oauth: { client_id: CLIENT_ID, ...HOSTED_OAUTH } }), probe({})] }
  }
}

interface Root {
  readonly path: string
  /** Where the fake Slack server logs the tools it is called with. */
  readonly callLog: string
  readonly env: Readonly<Record<string, string>>
  directory(project: Project): string
  remove(): void
}

/**
 * The environment that keeps OpenCode inside `root`. Under Bun, os.homedir() ignores a HOME changed at runtime,
 * so OpenCode would take the real home unless OPENCODE_TEST_HOME is set; its tmp directory follows TMPDIR.
 */
export function isolatedEnv(root: string): Readonly<Record<string, string>> {
  const home = join(root, "home")
  return {
    HOME: home,
    OPENCODE_TEST_HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    TMPDIR: join(root, "tmp"),
  }
}

function makeRoot(label: string, plugin: string): Root {
  const path = tempDirectory(`slack-host-${label}-`, true)
  const env = isolatedEnv(path)
  for (const dir of Object.values(env)) mkdirSync(dir, { recursive: true })
  // A location the host opens at its working directory still must not probe loopback providers.
  const userConfig = join(path, "home", ".config", "opencode")
  mkdirSync(userConfig, { recursive: true })
  writeFileSync(join(userConfig, "opencode.json"), JSON.stringify(LOCAL_PROVIDERS_OFF))
  const directory = (project: Project) => join(path, "projects", project)
  const callLog = join(path, "fake-slack-calls.log")
  for (const project of PROJECTS) {
    mkdirSync(directory(project), { recursive: true })
    writeFileSync(join(directory(project), "opencode.jsonc"), JSON.stringify(projectConfig(project, plugin, callLog), null, 2))
  }
  const shadow = join(directory("shadowed"), ".opencode", "skills", "slack-search")
  mkdirSync(shadow, { recursive: true })
  writeFileSync(join(shadow, "SKILL.md"), "---\nname: slack-search\ndescription: A project's own skill under the bundled id.\n---\n\nProject skill.\n")
  return { path, callLog, env, directory, remove: () => rmSync(path, { recursive: true, force: true }) }
}

// Anything that tries the network fails fast instead of reaching a real service.
const OFFLINE = {
  HTTP_PROXY: "http://127.0.0.1:9",
  HTTPS_PROXY: "http://127.0.0.1:9",
  http_proxy: "http://127.0.0.1:9",
  https_proxy: "http://127.0.0.1:9",
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_FREE_MODELS: "1",
}

const toolCalls = (root: Root) => () => (existsSync(root.callLog) ? readFileSync(root.callLog, "utf8").split("\n").filter(Boolean) : [])

/** The public `@opencode/sdk` host in this process, at the version installed as a devDependency. */
export async function startEmbedded(): Promise<Host> {
  const root = makeRoot("sdk", REPO)
  const saved = { ...process.env }
  const previous = process.cwd()
  // A parent OpenCode session (an agent running this suite) must not leak in. OpenCode reads the XDG roots and
  // TMPDIR when it is imported, so the environment moves first; its home comes from OPENCODE_TEST_HOME.
  for (const key of Object.keys(process.env)) if (key.startsWith("OPENCODE")) delete process.env[key]
  Object.assign(process.env, root.env, OFFLINE)
  // The SDK also opens a location at the process working directory. Stay inside the temp root for the host's life.
  process.chdir(root.path)
  const restore = () => {
    process.chdir(previous)
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
  }
  try {
    const { OpenCode } = await import("@opencode/sdk")
    const version = (JSON.parse(readFileSync(join(REPO, "node_modules", "@opencode", "sdk", "package.json"), "utf8")) as { version: string }).version
    const configDir = join(root.path, "config")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, "opencode.json"), JSON.stringify(LOCAL_PROVIDERS_OFF))
    const opencode = await OpenCode.create({
      // An embedded host reports "unknown" unless told, which the plugin's host check refuses.
      app: { version },
      config: { directory: configDir, project: true, claude: false },
      database: { path: join(root.path, "opencode.db") },
      models: { fetch: false },
      fs: { filewatcher: false },
      log: { level: "error", emit: () => {} },
    })
    return {
      version,
      client: opencode,
      root: root.path,
      state: "opencode.db",
      location: (project) => ({ directory: root.directory(project) }),
      toolCalls: toolCalls(root),
      close: async () => {
        await opencode.close()
        restore()
        root.remove()
      },
    }
  } catch (error) {
    restore()
    root.remove()
    throw error
  }
}

const binaries = new Map<string, string>()
const installs: string[] = []

/** Removes the stock releases stockBinary installed. Bun's test runner emits no `exit` event, so suites call this in afterAll. */
export function removeInstalls(): void {
  for (const dir of installs.splice(0)) rmSync(dir, { recursive: true, force: true })
  binaries.clear()
}

/**
 * The stock CLI for `version`. Set OPENCODE_BIN_2_2_3 (and so on) to a binary you already have; otherwise the
 * unmodified npm release is installed into a temp directory with scripts disabled, once per version and run, and
 * removed by removeInstalls().
 */
function stockBinary(version: string): string {
  const given = process.env[`OPENCODE_BIN_${version.replaceAll(".", "_")}`]
  if (given !== undefined && given !== "") return given
  const known = binaries.get(version)
  if (known !== undefined) return known
  // Its own package.json, and npm's cwd set to it: npm walks up from a folder that has none.
  const dir = tempDirectory(`slack-host-opencode-${version}-`)
  installs.push(dir)
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "slack-host-opencode", private: true }))
  const result = spawnSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", `@opencode/cli@${version}`], { cwd: dir, encoding: "utf8" })
  const path = join(dir, "node_modules", "@opencode", `cli-${platform()}-${arch()}`, "bin", "opencode")
  if (result.status !== 0 || !existsSync(path)) throw new Error(`Could not install @opencode/cli@${version} for ${platform()}-${arch()}:\n${result.stderr}`)
  binaries.set(version, path)
  return path
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (address === null || typeof address === "string") throw new Error("no free port")
  return address.port
}

/**
 * A stock `opencode serve` on its own port, in an environment that holds only the temp root. It loads the Slack
 * plugin from `plugin`: the built checkout, or an installed package.
 */
export async function startBinary(version: string, plugin = REPO): Promise<Host> {
  const binary = stockBinary(version)
  const root = makeRoot(`cli-${version}`, plugin)
  const password = randomUUID()
  const port = await freePort()
  const env = { ...root.env, ...OFFLINE, PATH: "/usr/bin:/bin", OPENCODE_PASSWORD: password }
  const stop = () => root.remove()

  // Prints "opencode v2.2.3".
  const reported = spawnSync(binary, ["--version"], { cwd: root.path, env, encoding: "utf8" })
  if (reported.stdout.trim() !== `opencode v${version}`) {
    stop()
    throw new Error(`${binary} reports ${JSON.stringify(reported.stdout.trim())}, expected ${version}`)
  }
  const paths = spawnSync(binary, ["debug", "paths"], { cwd: root.path, env, encoding: "utf8" })
  const entries = paths.stdout.trim().split("\n").flatMap((line) => {
    const match = /^(\S+)\s+(\S.*)$/.exec(line.trim())
    const name = match?.[1]
    const entry = match?.[2]
    return name === undefined || entry === undefined ? [] : [[name, entry] as const]
  })
  const escaped = entries.filter(([, entry]) => !entry.startsWith(root.path + sep))
  if (paths.status !== 0 || entries.length < 6 || escaped.length > 0) {
    stop()
    throw new Error(`opencode ${version} debug paths left ${root.path} (status ${paths.status}):\n${paths.stdout}\n${paths.stderr}`)
  }

  let output = ""
  const server = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: root.path, env, stdio: ["ignore", "pipe", "pipe"] })
  server.stdout.on("data", (chunk: Buffer) => void (output += chunk.toString()))
  server.stderr.on("data", (chunk: Buffer) => void (output += chunk.toString()))
  const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()))
  const close = async () => {
    if (server.exitCode === null && server.signalCode === null) {
      server.kill("SIGTERM")
      const timer = setTimeout(() => server.kill("SIGKILL"), 10_000)
      await exited
      clearTimeout(timer)
    }
    stop()
  }

  const client = Remote.make({ baseUrl: `http://127.0.0.1:${port}`, headers: { authorization: `Basic ${btoa(`opencode:${password}`)}` } })
  for (const deadline = Date.now() + 90_000; ;) {
    try {
      await client.agent.list({ location: { directory: root.directory("defaults") } })
      break
    } catch (error) {
      if (server.exitCode !== null || Date.now() > deadline) {
        await close()
        throw new Error(`opencode ${version} serve did not become ready: ${String(error)}\n${output.slice(-2000)}`)
      }
      await Bun.sleep(500)
    }
  }
  return {
    version,
    client,
    root: root.path,
    state: join("home", ".local", "share", "opencode"),
    location: (project) => ({ directory: root.directory(project) }),
    toolCalls: toolCalls(root),
    close,
  }
}

/** Tracked and untracked changes in the repository, to show a host run wrote nothing there. */
export function repositoryChanges(): string {
  const result = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: REPO, encoding: "utf8" })
  if (result.status !== 0) throw new Error(`git status failed: ${result.stderr}`)
  return result.stdout
}
