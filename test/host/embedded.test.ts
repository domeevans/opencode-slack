// The host test on the public `@opencode/sdk` host, embedded in this process.
import { setDefaultTimeout } from "bun:test"
import { startEmbedded } from "./harness.js"
import { hostSuite } from "./suite.js"

setDefaultTimeout(60_000)

hostSuite("embedded @opencode/sdk", startEmbedded)
