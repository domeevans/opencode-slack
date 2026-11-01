import { expect, test } from "bun:test"
import { TESTED_HOST_RANGE } from "../../src/defaults.js"
import { isTestedHost } from "../../src/host-version.js"

test("the tested range is the 2.2 line from 2.2.3", () => {
  expect(TESTED_HOST_RANGE).toBe(">=2.2.3 <2.3.0")
})

test.each([
  ["2.2.3", true],
  ["2.2.4", true],
  ["2.2.10", true],
  ["2.2.99", true],
  ["2.3.0", false],
  ["2.10.0", false],
  ["2.2.2", false],
  ["2.1.9", false],
  ["1.9.9", false],
  ["3.0.0", false],
  ["2.2.4-beta.1", false],
  ["2.2.3-rc.0", false],
  ["0.0.0-dev-385", false],
  ["unknown", false],
  ["", false],
  ["v2.2.3", false],
  ["2.2", false],
  ["2.2.3.1", false],
])("host %p is tested: %p", (version, tested) => {
  expect(isTestedHost(version)).toBe(tested)
})
