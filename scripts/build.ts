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

await rm(new URL("../dist", import.meta.url), { recursive: true, force: true })
const result = await build({
  absWorkingDir: ROOT,
  entryPoints: { index: "src/index.ts", tui: "src/tui.tsx" },
  outdir: "dist",
  bundle: true,
  splitting: false,
  format: "esm",
  platform: "node",
  target: "es2022",
  external: HOST,
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
  plugins: [solid],
})

const problems = Object.entries(result.metafile.outputs).flatMap(([file, output]) =>
  output.imports
    .filter((entry) => !entry.external || entry.path.startsWith(".") || !provided(entry.path))
    .map((entry) => `${file}: ${entry.path}`),
)
const outputs = Object.keys(result.metafile.outputs).sort()
if (problems.length > 0 || outputs.join(" ") !== "dist/index.js dist/tui.js") {
  throw new Error(`The build must emit only dist/index.js and dist/tui.js, importing only host modules. Found ${outputs.join(", ")}; ${problems.join(", ") || "no bad imports"}.`)
}
for (const [file, output] of Object.entries(result.metafile.outputs)) console.log(`built ${file} (${(output.bytes / 1024).toFixed(1)} KiB)`)
