export * as Output from "./output.ts"

import type { Actor } from "@work/schema/actor"
import type { Entry } from "@work/schema/entry"

/** Exit codes: refused is a normal outcome agents act on, distinct from mistakes and sign-in trouble. */
export const EXIT = { ok: 0, refused: 1, usage: 2, auth: 3, failed: 4 } as const

export class Exit extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message)
  }
}

let json = false
export const setJson = (on: boolean) => {
  json = on
}
export const isJson = () => json

/** Prints a line for people, or the value as JSON with --json. */
export const print = (text: string, value?: unknown) => {
  if (json) {
    if (value !== undefined) process.stdout.write(JSON.stringify(value, null, 2) + "\n")
  } else if (text) process.stdout.write(text + "\n")
}

export const info = (text: string) => {
  if (!json) process.stderr.write(text + "\n")
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
export const address = (a: Pick<Actor.Info, "handle" | "agent">) => (a.agent ? `${a.handle}/${a.agent}` : a.handle)
export const label = (a: Pick<Actor.Info, "name" | "agent">) => (a.agent ? `${capital(a.agent)} for ${a.name.split(" ")[0]}` : a.name)

export const clock = (at: number) => {
  const d = new Date(at)
  const hm = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
  return d.toDateString() === new Date().toDateString() ? hm : `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${hm}`
}

export const ago = (at: number) => {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 60) return "just now"
  const m = Math.round(s / 60)
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`
  const h = Math.round(m / 60)
  return `${h} hour${h === 1 ? "" : "s"} ago`
}

/** `20m`, `90s`, `2h`, or plain milliseconds. */
export const parseDuration = (text: string) => {
  const m = text.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/)
  if (!m) throw new Exit(EXIT.usage, `Not a duration: ${text}. Use 30s, 20m or 2h.`)
  const n = Number(m[1])
  return Math.round(n * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? "s") as "ms" | "s" | "m" | "h"]))
}

/** `v43`, `43`, or `new` (no versions yet). */
export const parseVersion = (text: string | undefined): number | null | undefined => {
  if (text === undefined) return undefined
  if (text === "new" || text === "none") return null
  const m = text.match(/^v?(\d+)$/)
  if (!m) throw new Exit(EXIT.usage, `Not a version: ${text}. Use v43, or new for a URL with no versions yet.`)
  return Number(m[1])
}

/** One log line, as `work log` and `work watch` print them. */
export const line = (e: Entry.Info) => {
  const key = e.keys[0] ? ` ${e.keys[0]}` : ""
  const by = address(e.actor)
  const what = (() => {
    switch (e.kind) {
      case "write":
        return e.revertOf ? `wrote v${e.version}, reverting v${e.revertOf}${key}` : `wrote v${e.version}${key}${e.fields.length ? ` (${e.fields.length} changed)` : ""}${e.text ? ` · ${e.text}` : ""}`
      case "claim":
        return `${e.text === "after waiting" ? "claimed after waiting" : "claimed"} ${e.keys.join(" ")}`
      case "release":
        return `released ${e.keys.join(" ")}`
      case "expire":
        return `claim expired on ${e.keys.join(" ")}`
      case "read":
        return `read${key}${e.version ? ` v${e.version}` : ""}`
      case "trajectory.start":
        return `started ${e.trajectory}: ${e.text}`
      case "trajectory.end":
        return `${e.title === "failed" ? "gave up" : "finished"} ${e.trajectory}${e.text ? `: ${e.text}` : ""}`
      case "refused":
        return `refused ${e.title}: ${e.text}${key}`
      case "revert.request":
        return `asked ${e.to} to revert v${e.version}${key}`
      case "revert.start":
        return `started reverting v${e.revertOf}${key}`
      case "comment":
        return `commented${key}${e.version ? ` v${e.version}` : ""}${e.to ? ` to ${e.to}` : ""}: ${e.text}`
      case "ask":
      case "tell":
      case "handoff":
        return `${e.kind === "handoff" ? "handed off to" : `${e.kind}s`} ${e.to}: ${e.text}`
      case "tool":
        return `tool ${e.text}`
      default:
        return `${e.kind}${key}${e.text ? `: ${e.text}` : ""}`
    }
  })()
  const member = e.member && e.member !== by ? ` (in ${e.member}'s session)` : ""
  return `${String(e.seq).padStart(5)}  ${clock(e.at)}  ${by.padEnd(14)} ${what}${member}`
}
