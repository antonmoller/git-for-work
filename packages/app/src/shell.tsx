import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { WorkSocket } from "@work/client"
import type { Entry } from "@work/schema/entry"
import type { Views } from "@work/schema/views"
import { call, onLink, paths } from "./lib.ts"

/** The workspace's live log: a counter that moves whenever entries arrive, and the newest seq. */
interface Live {
  readonly workspace: string
  readonly me: Views.Me
  readonly tick: number
  readonly head: number
  readonly connected: boolean
  readonly fresh: ReadonlySet<number>
}

const LiveContext = createContext<Live | null>(null)
export const useLive = () => useContext(LiveContext)!

/** Follows the workspace from its current head, so screens reload when something happens. */
export function LiveProvider({ workspace, me, children }: { workspace: string; me: Views.Me; children: ReactNode }) {
  const [state, setState] = useState({ tick: 0, head: 0, connected: false, fresh: new Set<number>() as ReadonlySet<number> })
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<Entry.Info[]>([])
  useEffect(() => {
    let socket: WorkSocket.Handle | null = null
    let cancelled = false
    call<Entry.Info[]>((c) => c.log.log({ params: { workspace }, query: { limit: 1 } })).then((head) => {
      if (cancelled) return
      const after = head[0]?.seq ?? 0
      setState((s) => ({ ...s, head: after }))
      socket = WorkSocket.watch({ baseUrl: location.origin }, workspace, after, {
        synced: () => setState((s) => ({ ...s, connected: true })),
        error: () => setState((s) => ({ ...s, connected: false })),
        entries: (entries) => {
          pending.current.push(...entries)
          // Many entries arrive in bursts; reload once per burst.
          if (timer.current) return
          timer.current = setTimeout(() => {
            timer.current = null
            const batch = pending.current
            pending.current = []
            setState((s) => ({ tick: s.tick + 1, head: batch.at(-1)?.seq ?? s.head, connected: true, fresh: new Set(batch.map((e) => e.seq)) }))
          }, 250)
        },
      })
    })
    return () => {
      cancelled = true
      socket?.close()
    }
  }, [workspace])
  return <LiveContext.Provider value={{ workspace, me, ...state }}>{children}</LiveContext.Provider>
}

const icons = {
  today: <path d="M2 4h7M2 8h11M2 12h5M11 2.7a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6ZM9 10.7a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Z" />,
  urls: <path d="M6.5 9.5a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.8.8M9.5 6.5a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l.8-.8" />,
  out: <path d="M6 3H3.5v10H6M10 5l3 3-3 3M13 8H6" />,
}

export function Shell({ section, crumbs, working, children }: { section: "today" | "urls" | "other"; crumbs?: ReactNode; working?: number; children: ReactNode }) {
  const live = useLive()
  const ws = live.me.workspaces.find((w) => w.slug === live.workspace)
  return (
    <div className="app">
      <header className="topbar">
        <span className="mark">
          <i />
        </span>
        <a className="crumb" href={paths.today(live.workspace)} onClick={onLink(paths.today(live.workspace))}>
          {ws?.name ?? live.workspace}
        </a>
        {crumbs}
        <span className="now" title={live.connected ? "Following the log live" : "Reconnecting"}>
          <span className={live.connected ? "pulse" : "pulse off"} />
          <span>{working === undefined ? (live.connected ? "Live" : "Reconnecting…") : `${working} agent${working === 1 ? "" : "s"} working`}</span>
        </span>
        <span className="crumb dim" style={{ marginLeft: 8 }}>
          {live.me.actor.name}
        </span>
      </header>
      <nav className="rail">
        <a className={section === "today" ? "on" : ""} href={paths.today(live.workspace)} onClick={onLink(paths.today(live.workspace))} title="Today">
          <svg viewBox="0 0 16 16">{icons.today}</svg>
        </a>
        <a className={section === "urls" ? "on" : ""} href={paths.urls(live.workspace)} onClick={onLink(paths.urls(live.workspace))} title="URLs">
          <svg viewBox="0 0 16 16">{icons.urls}</svg>
        </a>
        <a className="end" href="/auth/logout" title="Sign out">
          <svg viewBox="0 0 16 16">{icons.out}</svg>
        </a>
      </nav>
      <main className="area">{children}</main>
    </div>
  )
}

export const Slash = ({ children }: { children: ReactNode }) => (
  <>
    <span className="slash">/</span>
    <span className="crumb trunc">{children}</span>
  </>
)

export const Avatar = ({ name, agent, title, size }: { name: string; agent?: string | null; title?: string; size?: "lg" }) => {
  const text = agent ? agent.charAt(0).toUpperCase() : name.split(" ").map((p) => p.charAt(0)).join("").slice(0, 2).toUpperCase()
  return (
    <span className={`av${agent ? " ai" : ""}${size ? ` ${size}` : ""}`} title={title}>
      {text}
    </span>
  )
}

export const Section = ({ title, count, children }: { title: string; count?: ReactNode; children: ReactNode }) => (
  <div className="sect">
    <div className="trigger">
      <span>{title}</span>
      {count !== undefined && <span className="act">{count}</span>}
    </div>
    <div className="content">{children}</div>
  </div>
)
