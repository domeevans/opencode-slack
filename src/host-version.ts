import { TESTED_HOST_RANGE } from "./defaults.js"

const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/
const RANGE = /^>=(\d+)\.(\d+)\.(\d+) <(\d+)\.(\d+)\.(\d+)$/

const compare = (a: readonly number[], b: readonly number[]) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!

/**
 * True when `version` is a release inside the tested range: at or above its floor and below its ceiling.
 * Prereleases and non-semver dev builds are outside it.
 */
export function isTestedHost(version: string): boolean {
  const found = RELEASE.exec(version)
  if (!found) return false
  const bounds = RANGE.exec(TESTED_HOST_RANGE)!.slice(1).map(Number)
  const host = found.slice(1).map(Number)
  return compare(host, bounds.slice(0, 3)) >= 0 && compare(host, bounds.slice(3)) < 0
}
