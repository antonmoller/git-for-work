import { useState } from "react"
import type { Views } from "@work/schema/views"
import type { Write } from "@work/schema/write"
import { call, host, keyTitle, label, navigate, onLink, paths, time, useLoad, useNow } from "../lib.ts"
import { Avatar, Section, Shell, Slash, useLive } from "../shell.tsx"
import { Compose } from "./trajectory.tsx"

const W = 728

/** Each field's own line through time, one dot per write that changed it. */
function FieldLines({ versions, blame, selected, onSelect, now }: { versions: ReadonlyArray<Write.Version_>; blame: Views.History["blame"]; selected: number | null; onSelect: (v: number) => void; now: number }) {
  const ordered = [...versions].sort((a, b) => a.version - b.version)
  const fields: string[] = []
  for (const v of ordered) for (const f of v.changed) if (!fields.includes(f)) fields.push(f)
  if (fields.length === 0) return <div className="empty">No fields to show yet.</div>
  const shown = fields.slice(0, 14)
  const t0 = ordered[0]!.at
  const span = Math.max(now - t0, 60e3)
  const x0 = 150
  const x1 = 520
  const x = (t: number) => x0 + ((t - t0) / (span * 1.04)) * (x1 - x0)
  const rowH = 36
  const H = 30 + shown.length * rowH + 8
  const sel = ordered.find((v) => v.version === selected)
  const value = (f: string) => {
    const line = blame.find((b) => b.field === f)
    const text = line?.value ?? "—"
    return text.length > 26 ? `${text.slice(0, 25)}…` : text
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="rhs" role="img" aria-label="Each field of this URL over time, with a dot for every write that changed it">
      <text x={x(t0)} y={20} className="rh-ax">{time(t0)}</text>
      <line x1={x(now)} y1={26} x2={x(now)} y2={H - 4} className="rh-today" />
      <text x={x(now)} y={20} textAnchor="middle" className="rh-ax">now</text>
      {sel && <rect x={x(sel.at) - 7} y={28} width={14} height={H - 32} rx={7} className="rh-sel" />}
      {shown.map((f, i) => {
        const y = 30 + i * rowH + 18
        const touched = ordered.filter((v) => v.changed.includes(f))
        const last = touched.at(-1)!
        return (
          <g key={f}>
            <text x={16} y={y + 4} className="rh-f">{f.length > 20 ? `${f.slice(0, 19)}…` : f}</text>
            <line x1={x(touched[0]!.at)} y1={y} x2={x(last.at)} y2={y} className="rh-past" />
            <line x1={x(last.at)} y1={y} x2={x(now)} y2={y} className="rh-cur" />
            {touched.map((v) => (
              <circle key={v.version} cx={x(v.at)} cy={y} r={4.5} className={`rh-dot${v.version === selected ? " rh-on" : ""}`} onClick={() => onSelect(v.version)}>
                <title>{`v${v.version} · ${label(v.actor)} · ${time(v.at)}`}</title>
              </circle>
            ))}
            <text x={548} y={y + 4} className="rh-v">{value(f)}</text>
            <line x1={16} y1={y + 18} x2={W - 16} y2={y + 18} className="rh-rule" />
          </g>
        )
      })}
    </svg>
  )
}

export function UrlScreen({ urlKey, version }: { urlKey: string; version: number | null }) {
  const live = useLive()
  const now = useNow(5000)
  const [tab, setTab] = useState<"history" | "content" | "comments">("history")
  const url = `https://${urlKey}`
  const history = useLoad(() => call<Views.History>((c) => c.write.history({ params: { workspace: live.workspace }, query: { url } })), [live.workspace, url, live.tick])
  const data = history.data
  const selected = version ?? data?.versions[0]?.version ?? null
  const select = (v: number) => navigate(paths.url(live.workspace, urlKey, v))
  const current = data?.versions.find((v) => v.version === selected) ?? null
  const content = useLoad(
    () => (tab === "content" && selected ? call<{ content: string | null }>((c) => c.write.version({ params: { workspace: live.workspace }, query: { url, version: selected } })) : Promise.resolve(null)),
    [tab, selected, url],
  )
  const comments = data?.comments ?? []
  const holder = data?.who.holders[0]
  const title = keyTitle(urlKey, data?.who.title)

  return (
    <Shell section="urls" crumbs={<Slash>{title}</Slash>}>
      <div className="win">
        <header className="rh">
          <h1 className="trunc">
            {title} <span className="dim" style={{ fontWeight: 400 }}>{host(urlKey)}</span>
          </h1>
          <span className="seg">
            <button className={tab === "history" ? "on" : ""} onClick={() => setTab("history")}>History</button>
            <button className={tab === "content" ? "on" : ""} onClick={() => setTab("content")}>Content</button>
            <button className={tab === "comments" ? "on" : ""} onClick={() => setTab("comments")}>Comments <small>{comments.length}</small></button>
          </span>
          <div className="actions">
            {holder ? <span className="badge b-warn trunc">Held by {label(holder.holder)}</span> : <span className="badge b-dim">Nobody holds it</span>}
            {data?.who.version && <span className="ver">v{data.who.version}</span>}
          </div>
        </header>
        <div className="body" style={{ padding: "12px 8px 0" }}>
          {history.error && <div className="error">Could not load: {history.error.tag}</div>}
          {data && data.versions.length === 0 && <div className="empty">Nothing written to this URL yet.</div>}
          {data && data.versions.length > 0 && tab === "history" && (
            <>
              <FieldLines versions={data.versions} blame={data.blame} selected={selected} onSelect={select} now={now} />
              <div className="row" style={{ padding: "4px 16px 0", gap: 16 }}>
                <span className="grow" />
                <span className="dim">{data.versions.length} writes since {time(data.versions.at(-1)!.at)}</span>
              </div>
              <div className="well" style={{ marginTop: 14, ["--cols" as string]: "52px 100px minmax(0, 1.4fr) minmax(0, 1.2fr) minmax(0, 1fr)" }}>
                <div className="hd">
                  <span>Version</span>
                  <span>Written</span>
                  <span>Why</span>
                  <span>By</span>
                  <span>Fields</span>
                </div>
                {data.versions.map((v) => (
                  <button key={v.version} className={`tr${v.version === selected ? " sel" : ""}`} onClick={() => select(v.version)}>
                    <span className="mono">v{v.version}</span>
                    <span>{time(v.at)}</span>
                    <span className="med trunc">{v.revertOf ? `Revert of v${v.revertOf}` : (v.why ?? v.intent ?? "")}</span>
                    <span className="trunc">{label(v.actor)}</span>
                    <span className="trunc">{v.changed.join(", ") || "no change"}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          {tab === "content" && <pre className="content-view">{content.data ? (content.data.content ?? "The content is not stored.") : "Loading…"}</pre>}
          {tab === "comments" && <div style={{ padding: "8px 16px" }}><Comments comments={comments} /></div>}
        </div>
      </div>
      <aside className="details">
        {current ? <VersionPanel v={current} urlKey={urlKey} latest={data!.versions[0]!.version} /> : <div className="dh"><h2>No version selected</h2></div>}
        <Section title="Comments" count={comments.length}>
          <Comments comments={comments.slice(0, 8)} />
          <Compose
            placeholder={selected ? `Comment on v${selected}…` : "Comment…"}
            hint={holder ? `${label(holder.holder)} holds it and will see it` : "Agents that wrote it see it in their inbox"}
            send={(text) => call((c) => c.message.send({ params: { workspace: live.workspace }, payload: { kind: "comment", text, url, version: selected ?? undefined } }))}
          />
        </Section>
        {data && (data.who.holders.length > 0 || data.who.waiters.length > 0) && (
          <Section title="Holding and waiting" count={data.who.holders.length + data.who.waiters.length}>
            {data.who.holders.map((h) => (
              <div key={h.key} className="row"><span className="grow med trunc">{label(h.holder)}</span><span className="dim">holds since {time(h.since)}</span></div>
            ))}
            {data.who.waiters.map((w) => (
              <div key={w.id} className="row"><span className="grow trunc">{label(w.actor)}</span><span className="dim">waiting since {time(w.since)}</span></div>
            ))}
          </Section>
        )}
      </aside>
    </Shell>
  )
}

function VersionPanel({ v, urlKey, latest }: { v: Write.Version_; urlKey: string; latest: number }) {
  const live = useLive()
  const [asked, setAsked] = useState<string | null>(null)
  const requestRevert = async () => {
    setAsked("Asking…")
    try {
      await call((c) => c.write.requestRevert({ params: { workspace: live.workspace }, payload: { url: `https://${urlKey}`, version: v.version, to: live.me.actor.handle } }))
      setAsked("Asked. One of your agents picks it up from its inbox.")
    } catch (e) {
      setAsked(`Could not ask: ${(e as { tag?: string }).tag ?? "error"}`)
    }
  }
  const fields = v.changed
  return (
    <>
      <div className="dh">
        <h2 className="trunc">{v.revertOf ? `Revert of v${v.revertOf}` : (v.why ?? v.intent ?? `Version ${v.version}`)}</h2>
        <span className="ver">{v.base ? `v${v.base} → v${v.version}` : `v${v.version}, new`}</span>
      </div>
      <div className="sect first">
        <div className="rc">
          <div className="kv">
            <span className="dim">Written by</span>
            <span>{label(v.actor)}</span>
            <span className="dim">When</span>
            <span>{new Date(v.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span>
            {v.intent && (
              <>
                <span className="dim">Intent</span>
                <span>{v.intent}</span>
              </>
            )}
            {v.why && (
              <>
                <span className="dim">Why</span>
                <span>{v.why}</span>
              </>
            )}
            <span className="dim">Based on</span>
            <span>{v.base ? `v${v.base}` : "nothing, it was new"}</span>
            {v.reads.length > 0 && (
              <>
                <span className="dim">Read first</span>
                <span className="col" style={{ gap: 4, alignItems: "flex-start" }}>
                  {v.reads.map((r) => <span key={r} className="key">{keyTitle(r)}</span>)}
                </span>
              </>
            )}
          </div>
          {fields.length > 0 && (
            <div className="mini">
              <div className="grid" style={{ ["--cols" as string]: "minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)" }}>
                <span className="gh">Field</span>
                <span className="gh">Before</span>
                <span className="gh">After</span>
                {fields.slice(0, 16).map((f) => (
                  <span key={f} style={{ display: "contents" }}>
                    <span className="mono">{f}</span>
                    <span className="dim">{v.before[f] ?? "none"}</span>
                    <span className="med">{v.after[f] ?? "removed"}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
          <div className="row">
            <button className="btn sm" onClick={requestRevert} disabled={asked === "Asking…"}>Revert this write</button>
            {v.session && v.trajectory && (
              <a className="btn sm" href={paths.trajectory(live.workspace, v.session, v.trajectory)} onClick={onLink(paths.trajectory(live.workspace, v.session, v.trajectory))}>
                Open the trajectory
              </a>
            )}
          </div>
          <div className="foot">
            <span>
              {asked ??
                `Revert asks one of your agents to put back ${fields.length === 1 ? "this field" : `these ${fields.length} fields`} and log it as v${latest + 1}.${v.version < latest ? " It is refused if a later write changed them." : ""}`}
            </span>
          </div>
        </div>
      </div>
    </>
  )
}

function Comments({ comments }: { comments: Views.History["comments"] }) {
  if (comments.length === 0) return <span className="dim">No comments yet.</span>
  return (
    <>
      {comments.map((e) => (
        <div key={e.seq} className="cm">
          <Avatar name={e.actor.name} agent={e.actor.agent} />
          <div className="col grow">
            <span>
              <span className="med">{label(e.actor)}</span> <span className="dim">{e.version ? `on v${e.version} · ` : ""}{time(e.at)}</span>
            </span>
            <span>{e.kind === "revert.request" ? `Asked to revert v${e.version}` : e.text}</span>
          </div>
        </div>
      ))}
    </>
  )
}
