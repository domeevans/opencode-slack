// The host test on each stock OpenCode release, through `opencode serve` and the public client.
import { afterAll, setDefaultTimeout } from "bun:test"
import { HOST_VERSIONS, removeInstalls, startBinary } from "./harness.js"
import { hostSuite } from "./suite.js"

setDefaultTimeout(60_000)
afterAll(removeInstalls)

for (const version of HOST_VERSIONS) hostSuite(`stock opencode ${version}`, () => startBinary(version))
