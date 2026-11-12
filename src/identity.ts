import type { SlackApi } from "./slack-api.js"

/** The signed-in Slack account, as Slack's `auth.test` names it: ids only, never a name or a token. */
export interface Identity {
  /** The workspace, `T…` (an organisation-wide install answers with its `E…` id). */
  readonly teamId: string
  /** The signed-in user, `U…` or `W…`. */
  readonly userId: string
  /** The Enterprise Grid organisation, `E…`; absent for a workspace outside a grid. */
  readonly enterpriseId?: string
}

const TEAM_ID = /^[TE][A-Z0-9]{2,20}$/
const USER_ID = /^[UW][A-Z0-9]{2,20}$/
const ENTERPRISE_ID = /^E[A-Z0-9]{2,20}$/
/** How long a failed `auth.test` is not tried again for the same credential. */
const RETRY_MS = 60_000

/** The identity in an `auth.test` answer, or undefined when it does not have one in Slack's shape. */
export function identityOf(body: Readonly<Record<string, unknown>>): Identity | undefined {
  const { team_id: teamId, user_id: userId, enterprise_id: enterpriseId } = body
  if (typeof teamId !== "string" || !TEAM_ID.test(teamId) || typeof userId !== "string" || !USER_ID.test(userId)) return undefined
  if (enterpriseId === undefined || enterpriseId === null || enterpriseId === "") return { teamId, userId }
  if (typeof enterpriseId !== "string" || !ENTERPRISE_ID.test(enterpriseId)) return undefined
  return { teamId, userId, enterpriseId }
}

/**
 * The signed-in account for status: one `auth.test` per credential (a new sign-in is a new credential), shared by
 * concurrent reads. A failure gives no identity, never an error, and is tried again after a minute.
 */
export function workspaceIdentity(api: SlackApi, now: () => number = Date.now) {
  let known: { readonly credential: string; readonly identity: Promise<Identity | undefined> } | undefined
  let failed: { readonly credential: string; readonly at: number } | undefined

  const read = async (credential: string): Promise<Identity | undefined> => {
    const result = await api.call("auth.test", {}).catch(() => undefined)
    const identity = result?.ok === true && result.credential === credential ? identityOf(result.body) : undefined
    if (identity === undefined) {
      failed = { credential, at: now() }
      if (known?.credential === credential) known = undefined
    }
    return identity
  }

  return {
    async get(): Promise<Identity | undefined> {
      const credential = await api.credential().catch(() => undefined)
      if (credential === undefined) return undefined
      if (known?.credential === credential) return known.identity
      if (failed?.credential === credential && now() - failed.at < RETRY_MS) return undefined
      known = { credential, identity: read(credential) }
      return known.identity
    },
  }
}
