export * as Context from "./context.ts"

import { Exit as EffectExit } from "effect"
import { WorkClient } from "@work/client"
import type { Claim } from "@work/schema/claim"
import type { Views } from "@work/schema/views"
import { Auth } from "./auth.ts"
import { Config } from "./config.ts"
import { Identity } from "./identity.ts"
import { Exit, EXIT, address, ago, clock, label } from "./output.ts"

export interface Flags {
  readonly url?: string
  readonly workspace?: string
  readonly agent?: string
  readonly session?: string
}

export type Ctx = Awaited<ReturnType<typeof make>>

/** Everything a command needs: where, who, and a client that signs its calls and names the agent and session. */
export async function make(flags: Flags) {
  const url = Config.url(flags.url)
  const who = Identity.resolve(flags)
  const token = () => Auth.token(url)
  if (!(await token())) throw new Exit(EXIT.auth, `Not signed in to ${url}. Run \`work login\`.`)
  const options = { baseUrl: url, token, agent: who.agent, session: who.session, ownSession: who.ownSession }
  const work = WorkClient.connect(options)

  /** Runs a call. Typed refusals come back as `Exit` with a message for the agent; anything else is a failure. */
  const call = async <A>(f: (c: WorkClient.Client) => any): Promise<A> => {
    const exit = (await work.exit(f)) as EffectExit.Exit<A, unknown>
    if (EffectExit.isSuccess(exit)) return exit.value
    const failure = exit.cause.reasons.find((r) => r._tag === "Fail")
    const error = (failure && failure._tag === "Fail" ? failure.error : null) as { _tag?: string; [k: string]: any } | null
    throw refusal(error, String(exit.cause))
  }

  let cachedMe: Views.Me | null = null
  const me = async () => (cachedMe ??= await call<Views.Me>((c) => c.account.me()))

  /** The workspace: --workspace, WORK_WORKSPACE, `work use`, or the only one there is. */
  const workspace = async () => {
    const chosen = flags.workspace ?? Config.workspaceFor()
    if (chosen) return chosen.split("/").at(-1)!
    const list = (await me()).workspaces
    if (list.length === 1) return list[0]!.slug
    throw new Exit(
      EXIT.usage,
      list.length === 0 ? "There is no workspace yet. Create one in the app, or run `work use <slug> --create`." : `Pick a workspace for this directory: ${list.map((w) => `work use ${w.slug}`).join(", or ")}`,
    )
  }

  const needSession = () => {
    if (!who.agent || !who.session)
      throw new Exit(EXIT.usage, "This needs an agent session. Run it from an agent set up with `work init claude` or `work init codex`, or pass --agent and --session.")
    return { agent: who.agent, session: who.session }
  }

  return { url, who, token, options, work, call, me, workspace, needSession, dispose: () => work.dispose() }
}

const holderLine = (c: Claim.Info) =>
  `${address(c.holder)} (${label(c.holder)}) since ${clock(c.since)}${c.intent ? ` for "${c.intent}"` : ""}. Active ${ago(c.lastActive)}.`

/** Turns the server's refusals into what an agent should read. */
export function refusal(error: { _tag?: string; [k: string]: any } | null, fallback: string) {
  switch (error?._tag) {
    case "KeyHeld":
      return new Exit(EXIT.refused, `Held by ${error.conflicts.map(holderLine).join("\nAnd by ")}`, error)
    case "StaleBase":
      return new Exit(
        EXIT.refused,
        error.base
          ? `Not written: ${error.key} is at v${error.current} since ${clock(error.at)} (${address(error.by)}), not v${error.base}.\nSee what changed: work log ${error.key} --since v${error.base}, then read it again: work read ${error.key}`
          : `Not written: ${error.key} is at v${error.current} (${address(error.by)}, ${clock(error.at)}) and this session has not read it.\nRead it first: work read ${error.key}`,
        error,
      )
    case "StaleContent":
      return new Exit(
        EXIT.refused,
        `Not written: this is v${error.matches}'s content, and ${error.key} is at v${error.current}; writing it would undo v${error.matches + 1}–v${error.current}.\nIt is probably a stale copy: read the latest with work read ${error.key} --out <file>, redo the change there, then put. To undo a version on purpose: work revert ${error.key}@v<n> --put`,
        error,
      )
    case "RevertConflict":
      return new Exit(EXIT.refused, `Not reverted: v${error.later} at ${clock(error.at)} by ${address(error.by)} changed ${error.fields.join(", ")} after v${error.version}.`, error)
    case "TaskTaken":
      return new Exit(EXIT.refused, `Taken by ${error.task.taker ? address(error.task.taker) : "someone"}${error.task.takenAt ? ` at ${clock(error.task.takenAt)}` : ""}${error.task.status === "done" ? ", and done" : ""}.`, error)
    case "NotFound":
      return new Exit(EXIT.failed, `No ${error.what} ${error.id}.`, error)
    case "Invalid":
      return new Exit(EXIT.usage, error.message, error)
    case "Unauthorized":
      return new Exit(EXIT.auth, `${error.message}`, error)
    case "Forbidden":
      return new Exit(EXIT.auth, `Not allowed: ${error.message}`, error)
  }
  return new Exit(EXIT.failed, `The call failed: ${fallback.slice(0, 400)}`)
}
