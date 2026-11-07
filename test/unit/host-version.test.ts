import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { SUPPORTED_HOST_RANGE, TESTED_HOSTS } from "../../src/defaults.js"
import { isSupportedHost, isTestedHost } from "../../src/host-version.js"

const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { opencode: { host: string } }

test("the supported range is the 2.2 line from 2.2.3, as package.json states", () => {
  expect(SUPPORTED_HOST_RANGE).toBe(">=2.2.3 <2.3.0")
  expect(manifest.opencode.host).toBe(SUPPORTED_HOST_RANGE)
})

test("the tested releases are 2.2.3, 2.2.4, 2.2.5 and 2.2.6, each inside the supported range", () => {
  expect([...TESTED_HOSTS]).toEqual(["2.2.3", "2.2.4", "2.2.5", "2.2.6"])
  for (const version of TESTED_HOSTS) expect({ version, supported: isSupportedHost(version) }).toEqual({ version, supported: true })
})

test.each([
  ["2.2.3", true, true],
  ["2.2.4", true, true],
  ["2.2.5", true, true],
  ["2.2.99", true, false],
  ["2.2.10", true, false],
  ["2.3.0", false, false],
  ["2.10.0", false, false],
  ["2.2.2", false, false],
  ["2.1.9", false, false],
  ["1.9.9", false, false],
  ["3.0.0", false, false],
  ["2.2.4-beta.1", false, false],
  ["2.2.3-rc.0", false, false],
  ["0.0.0-dev-385", false, false],
  ["unknown", false, false],
  ["", false, false],
  ["v2.2.3", false, false],
  ["2.2", false, false],
  ["2.2.3.1", false, false],
])("host %p is supported: %p, tested: %p", (version, supported, tested) => {
  expect({ supported: isSupportedHost(version), tested: isTestedHost(version) }).toEqual({ supported, tested })
})
