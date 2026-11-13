import { useState } from "react"
import type { Views } from "@work/schema/views"
import { addressLabel, ago, call, describe, keyTitle, host, label, onLink, paths, time, useLoad, useNow } from "../lib.ts"
import { Avatar, Section, Shell, useLive } from "../shell.tsx"
import { Lanes } from "./lanes.tsx"

const RANGES = { today: "Today", week: "This week", all: "Everything" } as const
type Range = keyof typeof RANGES

const sinceFor = (range: Range) => {
  if (range === "all") return 0
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  if (range === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d.getTime()
}

const MESSAGE_KINDS = new Set(["comment", "ask", "tell", "handoff", "revert.request"])

export function Today() {
  const live = useLive()
  const now = useNow()
  const [range, setRange] = useState<Range>("today")
  const today = useLoad(() => call<Views.Today>((c) => c.log.today({ params: { workspace: live.workspace }, query: { since: sinceFor(range) } })), [live.workspace, live.tick, range])
  const data = today.data
  const running = data?.trajectories.filter((t) => t.status === "running") ?? []
  const names = new Map((data?.trajectories ?? []).map((t) => [t.owner.handle, t.owner.name]))

  return (
    <Shell section="today" working={new Set(running.map((t) => t.session)).size}>
      <div className="win">
        <header className="rh">
          <h1>{RANGES[range]}</h1>
          <span className="seg">
            {(Object.keys(RANGES) as Range[]).map((r) => (
              <button key={r} className={r === range ? "on" : ""} onClick={() => setRange(r)}>
                {RANGES[r]}
              </button>
            ))}
          </span>
          <div className="actions">
            {data && (
              <span className="dim trunc">
                {data.trajectories.length} trajectories · {running.length} running · {data.entries.filter((e) => e.kind === "write").length} writes
              </span>
            )}
          </div>
        </header>
        <div className="body" style={{ paddingTop: 8 }}>
          {today.error && <div className="error">Could not load: {today.error.tag}</div>}
          {data && (
            <>
              <div className="well" style={{ paddingTop: 6 }}>
                <Lanes today={data} workspace={live.workspace} now={now} />
              </div>
              <div className="well" style={{ ["--cols" as string]: "64px minmax(0, 1.6fr) minmax(0, 1fr) minmax(0, 1fr)" }}>
                <div className="hd">
                  <span>At</span>
                  <span>Entry</span>
                  <span>By</span>
                  <span>URL</span>
                </div>
                {data.entries.slice(0, 120).map((e) => {
                  const key = e.keys[0]
                  const target = key ? paths.url(live.workspace, key, e.version ?? undefined) : e.session && e.trajectory ? paths.trajectory(live.workspace, e.session, e.trajectory) : null
                  return (
                    <a key={e.seq} className={`tr${live.fresh.has(e.seq) ? " fresh" : ""}`} href={target ?? undefined} onClick={target ? onLink(target) : undefined}>
                      <span className="mono">{time(e.at)}</span>
                      <span className={`trunc${e.kind === "write" ? " med" : ""}`}>{describe(e)}</span>
                      <span className="trunc">{label(e.actor)}{e.member && e.member !== `${e.actor.handle}/${e.actor.agent}` ? ` in ${addressLabel(e.member, names)}'s session` : ""}</span>
                      <span className="trunc">{key ? keyTitle(key, e.title) : e.to ? addressLabel(e.to, names) : ""}</span>
                    </a>
                  )
                })}
                {data.entries.length === 0 && <div className="empty">Nothing logged yet.</div>}
              </div>
            </>
          )}
        </div>
      </div>
      <aside className="details">
        <div className="dh">
          <h2>Now</h2>
        </div>
        {data && <Now data={data} now={now} names={names} />}
      </aside>
    </Shell>
  )
}

function Now({ data, now, names }: { data: Views.Today; now: number; names: Map<string, string> }) {
  const live = useLive()
  const done = data.tasks.filter((t) => t.status === "done").length
  const messages = data.entries.filter((e) => MESSAGE_KINDS.has(e.kind)).slice(0, 12)
  const joined = data.presence.filter((p) => p.members.some((m) => !m.owner))
  return (
    <>
      <div className="sect first">
        <div className="trigger">
          <span>Claimed</span>
          <span className="act">{data.claims.length}</span>
        </div>
        <div className="content">
          {data.claims.length === 0 && <span className="dim">Nobody holds anything.</span>}
          {data.claims.map((c) => (
            <a key={c.key} className="rc" href={paths.url(live.workspace, c.key)} onClick={onLink(paths.url(live.workspace, c.key))}>
              <div className="row">
                <span className="med grow trunc">{keyTitle(c.key, c.title)}</span>
                <span className="dim">{host(c.key)}</span>
              </div>
              <div className="row">
                <span className="grow trunc">{addressLabel(c.member, names)}</span>
                {now - c.lastActive < 2 * 60e3 ? (
                  <span className="live">
                    <i />
                    active now
                  </span>
                ) : (
                  <span className="quiet">quiet {ago(c.lastActive, now)}</span>
                )}
                <span className="dim">since {time(c.since)}</span>
              </div>
            </a>
          ))}
        </div>
      </div>
      {joined.length > 0 && (
        <Section title="Joined sessions" count={joined.length}>
          {joined.map((p) => (
            <a key={p.session} className="row" href={paths.session(live.workspace, p.session)} onClick={onLink(paths.session(live.workspace, p.session))}>
              <span className="avs">
                {p.members.map((m) => (
                  <Avatar key={m.id} name={m.label} agent={m.kind === "agent" ? m.address.split("/")[1] : null} title={m.label} />
                ))}
              </span>
              <span className="grow trunc">
                {p.members.filter((m) => !m.owner).map((m) => m.label).join(", ")} <span className="dim">in {label(p.owner)}'s session</span>
              </span>
            </a>
          ))}
        </Section>
      )}
      <Section title="Tasks" count={`${done} of ${data.tasks.length} done`}>
        {data.tasks.length > 0 && (
          <div className="seg-bar" style={{ gridTemplateColumns: `${done || 0.0001}fr ${data.tasks.length - done || 0.0001}fr` }}>
            <span className="fill" />
            <span className="rest" />
          </div>
        )}
        {data.tasks.length === 0 && <span className="dim">No tasks.</span>}
        {[...data.tasks].reverse().slice(0, 8).map((t) => (
          <div key={t.id} className="row">
            <svg className={t.status === "done" ? "tick" : "tick open"} viewBox="0 0 16 16">
              {t.status === "done" ? <path d="m3.5 8.5 3 3 6-7" /> : <circle cx="8" cy="8" r="5" />}
            </svg>
            <span className="grow trunc">{t.title}</span>
            {t.taker ? <span className="dim trunc">{label(t.taker)}</span> : <span className="badge b-dim">{t.to ? `For ${addressLabel(t.to, names)}` : "Nobody yet"}</span>}
          </div>
        ))}
      </Section>
      <Section title="Comments and messages" count={messages.length}>
        {messages.length === 0 && <span className="dim">Nothing said yet.</span>}
        {messages.map((e) => (
          <div key={e.seq} className="cm">
            <Avatar name={e.actor.name} agent={e.actor.agent} />
            <div className="col grow">
              <span>
                <span className="med">{label(e.actor)}</span>{" "}
                <span className="dim">
                  {e.kind === "comment" && e.keys[0] ? `on ${keyTitle(e.keys[0], e.title)}${e.version ? ` v${e.version}` : ""}` : e.to ? `to ${e.to.includes(".") ? keyTitle(e.to) : addressLabel(e.to, names)}` : ""} · {time(e.at)}
                </span>
              </span>
              <span>{e.kind === "revert.request" ? `Revert v${e.version} of ${keyTitle(e.keys[0] ?? "")}` : e.text}</span>
            </div>
          </div>
        ))}
      </Section>
    </>
  )
}
