export * as Identity from "./identity.ts"

import { Config } from "./config.ts"

const AGENTS = ["claude", "codex", "cursor", "gemini", "opencode", "amp"]

/** One process's parent and command, from `ps`. */
const processInfo = (pid: number) => {
  const out = Bun.spawnSync(["ps", "-o", "ppid=,lstart=,comm=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim()
  const match = out.match(/^(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.+)$/)
  if (!match) return null
  return { ppid: Number(match[1]), started: Date.parse(match[2]!) || 0, comm: match[3]!.split("/").at(-1)!.toLowerCase() }
}

/**
 * The agent this command runs under, found by walking up the process tree to a known agent's process. Its pid and
 * start time name the session, so every command from one agent window lands in the same session without any setup.
 */
export const detect = () => {
  let pid = process.ppid
  for (let depth = 0; depth < 12 && pid > 1; depth++) {
    const info = processInfo(pid)
    if (!info) return null
    const agent = AGENTS.find((a) => info.comm === a || info.comm.startsWith(`${a}-`) || info.comm === `${a}.exe`)
    if (agent) return { agent, pid, session: `${agent}-${pid}-${(info.started / 1000).toString(36)}` }
    pid = info.ppid
  }
  return null
}

export interface Who {
  /** The agent's name, `codex` or `claude`; null for a person at a terminal. */
  readonly agent: string | null
  /** The agent session the command writes to: its own, or the one it joined. */
  readonly session: string | null
  /** Its own session, when it writes to a joined one. */
  readonly ownSession: string | null
  /** The agent's process, when found, so a joined presence can end with it. */
  readonly pid: number | null
}

/** Flags first, then what `work init` set in the environment, then the process tree. */
export function resolve(flags: { agent?: string; session?: string }): Who {
  const detected = flags.agent && flags.session ? null : process.env.WORK_AGENT && process.env.WORK_SESSION ? null : detect()
  const agent = (flags.agent ?? process.env.WORK_AGENT ?? detected?.agent ?? null)?.toLowerCase() ?? null
  const own = flags.session ?? process.env.WORK_SESSION ?? detected?.session ?? null
  const joined = own ? Config.state(own).joined : undefined
  return { agent, session: joined?.session ?? own, ownSession: joined ? own : null, pid: detected?.pid ?? null }
}
