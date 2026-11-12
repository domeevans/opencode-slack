// Who is signed in: Slack's auth.test, read once per credential through the Web API client, for status. Every id below
// is invented.
import { describe, expect, test } from "bun:test"
import { identityOf, workspaceIdentity } from "../../src/identity.js"
import type { SlackApi, SlackApiResult } from "../../src/slack-api.js"

const AUTH_TEST = { ok: true, url: "https://acme.slack.com/", team: "Acme", user: "sam", team_id: "T0TEAM0001", user_id: "U0USER0001", is_enterprise_install: false }

/** A Web API client over one credential id that answers auth.test with `answer`, and counts the calls. */
function fakeApi(answers: (() => SlackApiResult)[], credential: () => string | undefined = () => "crd_one") {
  const calls: string[] = []
  const api: SlackApi = {
    credential: async () => credential(),
    call: async (method) => {
      calls.push(method)
      const answer = answers.length > 1 ? answers.shift()! : answers[0]!
      return answer()
    },
  }
  return { api, calls }
}

const ok = (body: Record<string, unknown>, credential = "crd_one"): (() => SlackApiResult) => () => ({ ok: true, credential, body })
const failed = (error: string): (() => SlackApiResult) => () => ({ ok: false, error })

describe("identityOf", () => {
  test("reads the team, the user and, on an Enterprise Grid workspace, the enterprise", () => {
    expect(identityOf(AUTH_TEST)).toEqual({ teamId: "T0TEAM0001", userId: "U0USER0001" })
    expect(identityOf({ ...AUTH_TEST, enterprise_id: "E0GRID0001" })).toEqual({ teamId: "T0TEAM0001", userId: "U0USER0001", enterpriseId: "E0GRID0001" })
  })

  test("leaves out an empty enterprise id, as Slack sends for a workspace outside a grid", () => {
    expect(identityOf({ ...AUTH_TEST, enterprise_id: "" })).toEqual({ teamId: "T0TEAM0001", userId: "U0USER0001" })
  })

  test.each([
    ["no team", { ...AUTH_TEST, team_id: undefined }],
    ["no user", { ...AUTH_TEST, user_id: undefined }],
    ["a team id that is not one", { ...AUTH_TEST, team_id: "acme" }],
    ["a user id that is not one", { ...AUTH_TEST, user_id: "U0 USER" }],
    ["an enterprise id that is not one", { ...AUTH_TEST, enterprise_id: "<grid>" }],
  ])("is undefined for %s", (_label, body) => {
    expect(identityOf(body)).toBeUndefined()
  })
})

describe("workspaceIdentity", () => {
  test("calls auth.test once per credential", async () => {
    const { api, calls } = fakeApi([ok(AUTH_TEST)])
    const identity = workspaceIdentity(api)
    expect(await identity.get()).toEqual({ teamId: "T0TEAM0001", userId: "U0USER0001" })
    expect(await identity.get()).toEqual({ teamId: "T0TEAM0001", userId: "U0USER0001" })
    expect(calls).toEqual(["auth.test"])
  })

  test("concurrent reads share one call", async () => {
    const { api, calls } = fakeApi([ok(AUTH_TEST)])
    const identity = workspaceIdentity(api)
    await Promise.all([identity.get(), identity.get(), identity.get()])
    expect(calls).toEqual(["auth.test"])
  })

  test("a new sign-in, a new credential, is read again", async () => {
    let credential = "crd_one"
    const { api, calls } = fakeApi([ok(AUTH_TEST, "crd_one"), ok({ ...AUTH_TEST, team_id: "T0TEAM0002", user_id: "U0USER0002" }, "crd_two")], () => credential)
    const identity = workspaceIdentity(api)
    expect(await identity.get()).toMatchObject({ teamId: "T0TEAM0001" })
    credential = "crd_two"
    expect(await identity.get()).toEqual({ teamId: "T0TEAM0002", userId: "U0USER0002" })
    expect(calls).toEqual(["auth.test", "auth.test"])
  })

  test("without a sign-in there is no identity and no call", async () => {
    const { api, calls } = fakeApi([ok(AUTH_TEST)], () => undefined)
    expect(await workspaceIdentity(api).get()).toBeUndefined()
    expect(calls).toEqual([])
  })

  test("an answer for another credential than the one asked about is not kept", async () => {
    const { api } = fakeApi([ok(AUTH_TEST, "crd_other")])
    expect(await workspaceIdentity(api).get()).toBeUndefined()
  })

  test("a failure gives no identity, never an error, and is tried again only after a minute", async () => {
    let now = 1_000_000
    const { api, calls } = fakeApi([failed("request_failed"), ok(AUTH_TEST)])
    const identity = workspaceIdentity(api, () => now)
    expect(await identity.get()).toBeUndefined()
    expect(await identity.get()).toBeUndefined()
    expect(calls).toEqual(["auth.test"])
    now += 60_000
    expect(await identity.get()).toEqual({ teamId: "T0TEAM0001", userId: "U0USER0001" })
    expect(calls).toEqual(["auth.test", "auth.test"])
  })

  test("an unreadable answer counts as a failure", async () => {
    const { api } = fakeApi([ok({ ok: true })])
    expect(await workspaceIdentity(api).get()).toBeUndefined()
  })

  test("a client that throws gives no identity", async () => {
    const api: SlackApi = { credential: async () => "crd_one", call: async () => { throw new Error("boom") } }
    expect(await workspaceIdentity(api).get()).toBeUndefined()
  })
})
