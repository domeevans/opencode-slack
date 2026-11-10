// Builds the two files OpenCode loads, each self-contained: dist/index.js (the server part) and dist/tui.js (the
// TUI part). Shared code such as the status model and the RPC contract is inlined into both, so no shipped file
// imports a sibling: a host that reloads the plugin in place cannot pair a new entry with a stale cached module.
//
// The TUI is first compiled by Solid's universal transform for @opentui/solid, because OpenTUI's runtime JSX compiler
// skips node_modules, then bundled. The host provides @opencode/plugin, OpenTUI and Solid, so they stay bare imports;
// the build fails if either output imports anything else, or anything relative.
import { transformAsync } from "@babel/core"
import { build, type Plugin } from "esbuild"
import { readFile, rm } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const HOST = ["@opencode/plugin", "@opencode/plugin/*", "@opentui/*", "solid-js", "solid-js/*"]
const provided = (path: string) =>
  path.startsWith("node:") || HOST.some((name) => (name.endsWith("/*") ? path.startsWith(name.slice(0, -1)) : path === name))

/** Compiles .tsx through Babel's Solid universal transform before esbuild bundles it. */
const solid: Plugin = {
  name: "solid-universal",
  setup(editor) {
    editor.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
      const result = await transformAsync(await readFile(path, "utf8"), {
        cwd: ROOT,
        filename: path,
        configFile: false,
        babelrc: false,
        sourceMaps: false,
        presets: [
          ["babel-preset-solid", { moduleName: "@opentui/solid", generate: "universal" }],
          ["@babel/preset-typescript", { onlyRemoveTypeImports: false }],
        ],
      })
      if (!result?.code) throw new Error(`The TUI compile produced no code for ${path}.`)
      return { contents: result.code, loader: "js" }
    })
  },
}

/** The plugin's version, from package.json, as one string: the bundles do not carry the rest of package.json. */
const version: Plugin = {
  name: "version",
  setup(editor) {
    editor.onLoad({ filter: /[\\/]src[\\/]version\.ts$/ }, async () => {
      const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
      return { contents: `export const VERSION = ${JSON.stringify(manifest.version)}`, loader: "ts" }
    })
  },
}

await rm(new URL("../dist", import.meta.url), { recursive: true, force: true })
// The server part is minified to keep the package within its size budget. The TUI part stays readable, as GitHub's does.
const common = {
  absWorkingDir: ROOT,
  outdir: "dist",
  bundle: true,
  splitting: false,
  format: "esm" as const,
  platform: "node" as const,
  target: "es2022",
  external: HOST,
  legalComments: "none" as const,
  metafile: true as const,
  logLevel: "warning" as const,
  plugins: [version, solid],
}
const server = await build({ ...common, entryPoints: { index: "src/index.ts" }, minify: true })
const tui = await build({ ...common, entryPoints: { tui: "src/tui.tsx" } })
const outputsOf = { ...server.metafile.outputs, ...tui.metafile.outputs }

const problems = Object.entries(outputsOf).flatMap(([file, output]) =>
  output.imports
    .filter((entry) => !entry.external || entry.path.startsWith(".") || !provided(entry.path))
    .map((entry) => `${file}: ${entry.path}`),
)
const outputs = Object.keys(outputsOf).sort()
if (problems.length > 0 || outputs.join(" ") !== "dist/index.js dist/tui.js") {
  throw new Error(`The build must emit only dist/index.js and dist/tui.js, importing only host modules. Found ${outputs.join(", ")}; ${problems.join(", ") || "no bad imports"}.`)
}
for (const [file, output] of Object.entries(outputsOf)) console.log(`built ${file} (${(output.bytes / 1024).toFixed(1)} KiB)`)
