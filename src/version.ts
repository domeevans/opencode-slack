import manifest from "../package.json" with { type: "json" }

/** The plugin's version, from package.json. The build replaces this module with the version string alone. */
export const VERSION: string = manifest.version
