export * as Presence from "./presence.ts"

import { spawn } from "node:child_process"
import { WorkSocket } from "@work/client"
import type { Session } from "@work/schema/session"
import type { Views } from "@work/schema/views"
import { Config } from "./config.ts"
import { Identity } from "./identity.ts"
import type { Ctx } from "./context.ts"
import type { Command } from "./commands.ts"
import { Exit, EXIT, clock, info, print } from "./output.ts"

/** How to run this same CLI again: the compiled binary, or Bun with the script. */
export const self = (): string[] => (Bun.main.startsWith("/$bunfs") ? [process.execPath] : [process.execPath, Bun.main])

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const members = (list: readonly Session.Member[]) => list.map((m) => `${m.address}${m.owner ? " (owner)" : ""}`).join(", ")

/** Stops the background process that keeps a joined presence open, and forgets the join. */
export function leave(own: string) {
  const state = Config.state(own)
  if (!state.joined) return null
  if (state.joined.pid && alive(state.joined.pid)) process.kill(state.joined.pid, "SIGTERM")
  const { joined, ...rest } = state
  Config.saveState(own, rest)
  return joined
}

/** Keeps the agent present in its own session while its process runs, so people see it connected. Idempotent. */
export function attend(ctx: Ctx, workspace: string) {
  const own = ctx.who.ownSession ?? ctx.who.session
  if (!own || !ctx.who.agent) return
  const present = Config.state(own).present
  if (present?.pid && present.workspace === workspace && alive(present.pid)) return
  // Without the agent's process there is nothing to end the presence with, so none is held.
  const agentPid = ctx.who.pid ?? (process.env.WORK_DETECT === "0" ? null : Identity.detect()?.pid)
  if (!agentPid) return
  const child = spawn(self()[0]!, [...self().slice(1), "__presence", workspace, own, String(agentPid), "own"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, WORK_AGENT: ctx.who.agent, WORK_SESSION: own, WORK_URL: ctx.url },
  })
  child.unref()
  Config.saveState(own, { ...Config.state(own), present: { workspace, pid: child.pid ?? null, at: Date.now() } })
}

/** Ends the agent's presence in its own session. */
export function absent(own: string) {
  const state = Config.state(own)
  if (!state.present) return
  if (state.present.pid && alive(state.present.pid)) process.kill(state.present.pid, "SIGTERM")
  const { present, ...rest } = state
  Config.saveState(own, rest)
}

export const commands: Record<string, Command> = {
  join: {
    group: "Sessions",
    usage: "join <session>",
    summary: "Joins another agent's session: its claims become yours to use, and your steps land in its log.",
    async run(ctx, [session]) {
      const own = ctx.needSession().session
      if (!session) throw new Exit(EXIT.usage, `Usage: work ${this.usage}`)
      const mine = ctx.who.ownSession ?? own
      if (session === mine) throw new Exit(EXIT.usage, "That is this agent's own session.")
      const workspace = await ctx.workspace()
      const view = await ctx.call<Views.SessionView>((c) => c.session.join({ params: { workspace, session } }))
      leave(mine)
      // The presence socket has to outlive this command, so a small background process holds it.
      const child = spawn(self()[0]!, [...self().slice(1), "__presence", workspace, session, String(ctx.who.pid ?? 0)], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, WORK_AGENT: ctx.who.agent!, WORK_SESSION: mine, WORK_URL: ctx.url },
      })
      child.unref()
      Config.saveState(mine, { ...Config.state(mine), joined: { session, workspace, pid: child.pid ?? null, at: Date.now() } })
      const running = view.trajectories.filter((t) => t.status === "running")
      print(
        [
          `Joined ${session}, ${view.owner ? `${view.owner.handle}/${view.owner.agent}` : "an agent"}'s session.`,
          running.length ? `Running: ${running.map((t) => `${t.id} "${t.intent}" since ${clock(t.startedAt)}`).join("; ")}.` : "No trajectory is running.",
          view.members.length ? `Here now: ${members(view.members)}.` : "",
          "Your steps, claims and writes go to this session until `work leave`.",
        ]
          .filter(Boolean)
          .join("\n"),
        { session, workspace, view },
      )
    },
  },
  leave: {
    group: "Sessions",
    usage: "leave",
    summary: "Leaves the joined session and goes back to this agent's own.",
    async run(ctx) {
      ctx.needSession()
      const own = ctx.who.ownSession ?? ctx.who.session!
      const left = leave(own)
      print(left ? `Left ${left.session}.` : "Not in another session.", left ?? {})
    },
  },
  here: {
    group: "Sessions",
    usage: "here [<session>]",
    summary: "Who is in a session right now.",
    async run(ctx, [session]) {
      const workspace = await ctx.workspace()
      const target = session ?? ctx.who.session
      if (!target) throw new Exit(EXIT.usage, `Usage: work ${this.usage}`)
      const view = await ctx.call<Views.SessionView>((c) => c.session.view({ params: { workspace, session: target } }))
      print(view.members.length ? `In ${target}: ${members(view.members)}.` : `Nobody is in ${target} now.`, view)
    },
  },
}

/**
 * The background holder `work join` starts. It keeps the presence socket open until the agent's process ends, `work
 * leave` stops it, or the join is replaced.
 */
export async function hold(ctx: Ctx, workspace: string, session: string, agentPid: number, mode: "joined" | "own" = "joined") {
  const own = ctx.who.ownSession ?? process.env.WORK_SESSION!
  const mine = () => {
    const state = Config.state(own)
    if (mode === "own") return state.present?.pid === process.pid && state.present.workspace === workspace
    return state.joined?.session === session && state.joined.pid === process.pid
  }
  const socket = WorkSocket.presence(ctx.options, workspace, session, { message: () => {} })
  await new Promise<void>((resolve) => {
    const stop = () => resolve()
    process.once("SIGTERM", stop)
    process.once("SIGINT", stop)
    const check = setInterval(() => {
      if ((agentPid > 1 && !alive(agentPid)) || !mine()) {
        clearInterval(check)
        resolve()
      }
    }, 2000)
  })
  socket.close()
  // Give the close frame a moment to reach the server, so the leave is recorded now rather than at timeout.
  await Bun.sleep(300)
  info(`Left ${session}.`)
}
