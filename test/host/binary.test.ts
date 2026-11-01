// The host test on each stock OpenCode release, through `opencode serve` and the public client.
import { setDefaultTimeout } from "bun:test"
import { HOST_VERSIONS, startBinary } from "./harness.js"
import { hostSuite } from "./suite.js"

setDefaultTimeout(60_000)

for (const version of HOST_VERSIONS) hostSuite(`stock opencode ${version}`, () => startBinary(version))
