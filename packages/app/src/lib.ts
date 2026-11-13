import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { WorkClient } from "@work/client"
import type { Actor } from "@work/schema/actor"
import type { Entry } from "@work/schema/entry"

// The API: same origin, signed in with the cookie.

export const work = WorkClient.connect({ baseUrl: location.origin })
export type Client = WorkClient.Client

export class Failed extends Error {
  constructor(readonly tag: string, readonly detail: unknown) {
    super(tag)
  }
}

/** Runs a call; rejects with `Failed` carrying the error's tag (Unauthorized, KeyHeld, …). */
export const call = async <A>(f: (c: Client) => any): Promise<A> => {
  try {
    return (await work.run(f)) as A
  } catch (error) {
    const tag = (error as { _tag?: string })?._tag ?? "Error"
    throw new Failed(tag, error)
  }
}

/** Loads data and reloads it when `deps` change or `bump` ticks. Keeps the last value while reloading. */
export function useLoad<A>(load: () => Promise<A>, deps: ReadonlyArray<unknown>) {
  const [state, setState] = useState<{ data: A | null; error: Failed | null; loading: boolean }>({ data: null, error: null, loading: true })
  const seq = useRef(0)
  const reload = useCallback(() => {
    const mine = ++seq.current
    setState((s) => ({ ...s, loading: true }))
    load().then(
      (data) => mine === seq.current && setState({ data, error: null, loading: false }),
      (error) => mine === seq.current && setState((s) => ({ data: s.data, error: error instanceof Failed ? error : new Failed("Error", error), loading: false })),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(reload, [reload])
  return { ...state, reload }
}

// Routing: plain paths, pushState.

const listeners = new Set<() => void>()
addEventListener("popstate", () => listeners.forEach((l) => l()))
export const navigate = (path: string) => {
  if (path === location.pathname + location.search) return
  history.pushState(null, "", path)
  listeners.forEach((l) => l())
}
export const usePath = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => location.pathname + location.search,
  )

export const paths = {
  today: (ws: string) => `/w/${ws}`,
  urls: (ws: string) => `/w/${ws}/urls`,
  session: (ws: string, session: string) => `/w/${ws}/s/${encodeURIComponent(session)}`,
  trajectory: (ws: string, session: string, trajectory: string) => `/w/${ws}/s/${encodeURIComponent(session)}/t/${trajectory}`,
  url: (ws: string, key: string, version?: number) => `/w/${ws}/u/${key.split("/").map(encodeURIComponent).join("/")}${version ? `?v=${version}` : ""}`,
}

/** A link that navigates without reloading the page. */
export const onLink = (path: string) => (e: React.MouseEvent) => {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
  e.preventDefault()
  navigate(path)
}

// Words.

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
export const first = (name: string) => name.split(" ")[0] ?? name
export const label = (a: Pick<Actor.Info, "name" | "agent">) => (a.agent ? `${capital(a.agent)} for ${first(a.name)}` : a.name)
export const agentName = (a: Pick<Actor.Info, "agent" | "name">) => (a.agent ? capital(a.agent) : a.name)
export const initials = (a: Pick<Actor.Info, "name" | "agent">) =>
  a.agent ? capital(a.agent).charAt(0) : a.name.split(" ").map((p) => p.charAt(0)).join("").slice(0, 2).toUpperCase()
export const isAgent = (address: string) => address.includes("/")
export const addressLabel = (address: string, names: Map<string, string> = new Map()) => {
  const [handle, agent] = address.split("/")
  const name = names.get(handle!) ?? capital(handle!)
  return agent ? `${capital(agent)} for ${first(name)}` : name
}

export const host = (key: string) => key.split(/[/?#]/)[0] ?? key
export const keyTitle = (key: string, title?: string | null) => {
  if (title) return title
  const rest = key.slice(host(key).length).replace(/^\//, "")
  return rest ? decodeURIComponent(rest.split("/").filter(Boolean).slice(-2).join("/")) : key
}

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()
export const time = (at: number) => {
  const d = new Date(at)
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
  return sameDay(d, new Date()) ? hm : `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${hm}`
}
export const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
export const ago = (at: number, now = Date.now()) => {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return `${s} s ago`
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  return `${Math.round(s / 3600)} h ago`
}
export const duration = (ms: number) => {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.round(s / 60)} min`
  return `${(s / 3600).toFixed(s < 36000 ? 1 : 0)} h`
}

/** One line for an entry, as the log table reads. */
export const describe = (e: Entry.Info | Entry.Event) => {
  const v = e.version
  switch (e.kind) {
    case "write":
      return e.revertOf ? `Wrote v${v}, reverting v${e.revertOf}` : `Wrote v${v}${e.fields.length ? `, ${e.fields.length} field${e.fields.length === 1 ? "" : "s"}` : ""}`
    case "claim":
      return e.text === "after waiting" ? "Claimed after waiting" : `Claimed${e.keys.length > 1 ? ` ${e.keys.length} URLs` : ""}`
    case "release":
      return `Released${e.keys.length > 1 ? ` ${e.keys.length} URLs` : ""}`
    case "expire":
      return "Claim expired"
    case "comment":
      return `Commented: ${e.text ?? ""}`
    case "ask":
      return `Asked: ${e.text ?? ""}`
    case "tell":
      return `Told: ${e.text ?? ""}`
    case "handoff":
      return `Handed off: ${e.text ?? ""}`
    case "revert.request":
      return `Asked to revert v${v}`
    case "revert.start":
      return `Started reverting v${e.version ?? ""}`
    case "task.add":
      return `Added task: ${e.text ?? ""}`
    case "task.take":
      return `Took task: ${e.text ?? ""}`
    case "task.done":
      return `Finished task: ${e.text ?? ""}`
    case "trajectory.start":
      return `Started: ${e.text ?? ""}`
    case "trajectory.end":
      return e.title === "failed" ? `Gave up${e.text ? `: ${e.text}` : ""}` : "Finished"
    case "refused":
      return `${refusal(e.text)} (${e.title ?? "call"})`
    case "join":
      return "Joined the session"
    case "leave":
      return "Left the session"
    case "read":
      return `Read${v ? ` v${v}` : ""}`
    case "note":
      return e.text ?? "Note"
    case "tool":
      return `Tool: ${e.text ?? ""}`
  }
  return e.kind
}

export const refusal = (tag: string | null) =>
  ({ KeyHeld: "Refused: someone holds it", StaleBase: "Refused: it moved on", RevertConflict: "Refused: a later write changed it", TaskTaken: "Refused: already taken" })[tag ?? ""] ??
  `Refused${tag ? `: ${tag}` : ""}`

/** A colour per lane, stable for a session. */
const COLORS = ["var(--primary)", "var(--teal)", "var(--violet)", "var(--orange)", "var(--success)", "var(--pink)"]
export const colorFor = (index: number) => COLORS[index % COLORS.length]!

/** Ticks once a second, for "now" lines and "active" labels. */
export function useNow(every = 1000) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), every)
    return () => clearInterval(id)
  }, [every])
  return now
}
