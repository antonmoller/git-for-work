import { StrictMode, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import type { Entry } from "@work/schema/entry"
import type { Views } from "@work/schema/views"
import { call, host, keyTitle, label, navigate, onLink, paths, time, useLoad, usePath } from "./lib.ts"
import { LiveProvider, Shell, useLive } from "./shell.tsx"
import { Today } from "./screens/today.tsx"
import { TrajectoryScreen } from "./screens/trajectory.tsx"
import { UrlScreen } from "./screens/url.tsx"
import "./styles.css"

function SignIn() {
  const [config, setConfig] = useState<{ devAuth: boolean } | null>(null)
  const [handle, setHandle] = useState("anton")
  useEffect(() => {
    fetch("/api/config").then((r) => r.json()).then(setConfig, () => setConfig({ devAuth: false }))
  }, [])
  const next = encodeURIComponent(location.pathname + location.search)
  return (
    <div className="center">
      <div className="card">
        <h1>Sign in to Work</h1>
        <span className="dim">See what every agent did, who holds what, and comment or revert.</span>
        <a className="btn pri" style={{ justifyContent: "center" }} href={`/auth/login?next=${next}`}>
          Sign in with WorkOS
        </a>
        {config?.devAuth && (
          <>
            <span className="or">or, on this computer only</span>
            <input value={handle} onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} placeholder="handle" />
            <a className="btn" style={{ justifyContent: "center" }} href={`/auth/dev?as=${handle}&next=${next}`}>
              Sign in locally as {handle || "…"}
            </a>
          </>
        )}
      </div>
    </div>
  )
}

function Workspaces({ me }: { me: Views.Me }) {
  const [slug, setSlug] = useState("")
  const [error, setError] = useState<string | null>(null)
  const create = async () => {
    try {
      await call((c) => c.account.createWorkspace({ payload: { slug, name: slug.charAt(0).toUpperCase() + slug.slice(1) } }))
      location.assign(paths.today(slug))
    } catch (e) {
      setError((e as { tag?: string }).tag ?? "Could not create it")
    }
  }
  return (
    <div className="center">
      <div className="card">
        <h1>Workspaces</h1>
        {me.workspaces.map((w) => (
          <a key={w.slug} className="btn" href={paths.today(w.slug)} onClick={onLink(paths.today(w.slug))}>
            {w.name} <span className="dim">{w.slug}</span>
          </a>
        ))}
        <span className="or">or create one</span>
        <input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} placeholder="slug, e.g. purchasing" />
        <button className="btn pri" onClick={create} disabled={!slug} style={{ justifyContent: "center" }}>
          Create
        </button>
        {error && <span style={{ color: "var(--danger)" }}>{error}</span>}
      </div>
    </div>
  )
}

/** Every URL written in the workspace, newest first. */
function Urls() {
  const live = useLive()
  const log = useLoad(() => call<Entry.Info[]>((c) => c.log.log({ params: { workspace: live.workspace }, query: { limit: 5000 } })), [live.workspace, live.tick])
  const latest = new Map<string, Entry.Info>()
  for (const e of log.data ?? []) if (e.kind === "write" && e.keys[0] && !latest.has(e.keys[0])) latest.set(e.keys[0], e)
  return (
    <Shell section="urls">
      <div className="win">
        <header className="rh">
          <h1>URLs</h1>
          <span />
          <div className="actions">
            <span className="dim">{latest.size} written</span>
          </div>
        </header>
        <div className="body" style={{ paddingTop: 8 }}>
          <div className="well" style={{ ["--cols" as string]: "minmax(0, 1.4fr) minmax(0, 1fr) 60px minmax(0, 1fr) 90px" }}>
            <div className="hd">
              <span>URL</span>
              <span>Host</span>
              <span>Version</span>
              <span>Last written by</span>
              <span>When</span>
            </div>
            {[...latest.values()].map((e) => (
              <a key={e.keys[0]} className="tr" href={paths.url(live.workspace, e.keys[0]!)} onClick={onLink(paths.url(live.workspace, e.keys[0]!))}>
                <span className="med trunc" title={e.keys[0]}>{keyTitle(e.keys[0]!, e.title)}</span>
                <span className="dim trunc">{host(e.keys[0]!)}</span>
                <span className="mono">v{e.version}</span>
                <span className="trunc">{label(e.actor)}</span>
                <span>{time(e.at)}</span>
              </a>
            ))}
            {log.data && latest.size === 0 && <div className="empty">Nothing written yet.</div>}
          </div>
        </div>
      </div>
    </Shell>
  )
}

function App() {
  const path = usePath()
  const me = useLoad(() => call<Views.Me>((c) => c.account.me()), [])
  if (me.error?.tag === "Unauthorized" || me.error?.tag === "Forbidden") return <SignIn />
  if (me.error) return <div className="center"><div className="card"><h1>Work is not reachable</h1><span className="dim">{me.error.tag}</span></div></div>
  if (!me.data) return null
  const [pathname, search] = path.split("?")
  const parts = pathname!.split("/").filter(Boolean)
  if (parts[0] !== "w" || !parts[1]) {
    if (me.data.workspaces.length === 1) {
      navigate(paths.today(me.data.workspaces[0]!.slug))
      return null
    }
    return <Workspaces me={me.data} />
  }
  const workspace = parts[1]
  let screen
  if (parts[2] === "s" && parts[3]) screen = <TrajectoryScreen key={parts[3]} session={decodeURIComponent(parts[3])} trajectory={parts[4] === "t" ? parts[5] : undefined} />
  else if (parts[2] === "u" && parts[3]) {
    const key = parts.slice(3).map(decodeURIComponent).join("/")
    const v = new URLSearchParams(search ?? "").get("v")
    screen = <UrlScreen key={key} urlKey={key} version={v ? Number(v) : null} />
  } else if (parts[2] === "urls") screen = <Urls />
  else screen = <Today />
  return (
    <LiveProvider key={workspace} workspace={workspace} me={me.data}>
      {screen}
    </LiveProvider>
  )
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
