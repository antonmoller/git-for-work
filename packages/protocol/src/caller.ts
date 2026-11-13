export * as Caller from "./caller.ts"

import { Context } from "effect"
import type { Actor } from "@work/schema/actor"

/**
 * Who is calling, as the Worker established it from the token, and from which agent session. The objects never see
 * a token. An agent acts as its person: `actor.agent` is its name, `session` the agent session it writes to (a joined
 * session when it joined one), `ownSession` its own.
 */
export interface Info {
  readonly actor: Actor.Info
  readonly email: string
  readonly org: string
  readonly role: string
  readonly session: string | null
  readonly ownSession: string | null
}

export class Current extends Context.Service<Current, Info>()("@work/protocol/Caller") {}

/** Headers the CLI sends with every call. */
export const headers = {
  agent: "x-work-agent",
  session: "x-work-session",
  ownSession: "x-work-own-session",
} as const
