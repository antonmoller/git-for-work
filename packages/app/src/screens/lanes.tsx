import type { Views } from "@work/schema/views"
import { agentName, colorFor, first, label, navigate, paths } from "../lib.ts"

type Today = Views.Today

const W = 728
const LEFT = 132
const RIGHT = 16
const LANE = 48
const TOP = 16

/** Picks a tick step that gives about six to ten ticks across the range. */
const step = (span: number) => {
  const steps = [10e3, 30e3, 60e3, 5 * 60e3, 10 * 60e3, 15 * 60e3, 30 * 60e3, 3600e3, 2 * 3600e3, 4 * 3600e3]
  return steps.find((s) => span / s <= 10) ?? 6 * 3600e3
}

/**
 * One lane per agent session. A bar is a trajectory, each dot a write, the amber line a claim held now. Dashed arrows
 * are questions and hand-offs to another lane; amber arrows a release that handed a URL to a waiting lane.
 */
export function Lanes({ today, workspace, now }: { today: Today; workspace: string; now: number }) {
  const sessions = [...new Set([...today.trajectories].sort((a, b) => a.startedAt - b.startedAt).map((t) => t.session as string))]
  if (sessions.length === 0) return <div className="empty">No agent has started anything today. Agents appear here as soon as they run `work start`.</div>
  const lanes = sessions.map((session, i) => {
    const trajectories = today.trajectories.filter((t) => t.session === session)
    const owner = trajectories[0]!.owner
    const presence = today.presence.find((p) => p.session === session)
    const guests = (presence?.members ?? []).filter((m) => !m.owner)
    return { session, i, owner, forName: trajectories[0]!.forName, trajectories, guests, color: colorFor(i), y: TOP + i * LANE }
  })
  const laneOf = new Map(lanes.map((l) => [l.session, l]))
  const byAddress = new Map(lanes.map((l) => [`${l.owner.handle}/${l.owner.agent}`, l]))

  const start = Math.min(...today.trajectories.map((t) => t.startedAt))
  const span0 = Math.max(now - start, 60e3)
  const tick = step(span0 * 1.08)
  const t0 = Math.floor(start / tick) * tick
  const t1 = Math.max(now + span0 * 0.04, t0 + tick)
  const x = (t: number) => LEFT + ((t - t0) / (t1 - t0)) * (W - LEFT - RIGHT)
  const H = TOP + lanes.length * LANE + 22
  const ticks: number[] = []
  for (let t = t0; t <= t1; t += tick) ticks.push(t)
  const fmt = (t: number) =>
    new Date(t).toLocaleTimeString([], tick < 60e3 ? { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false } : { hour: "2-digit", minute: "2-digit", hour12: false })

  const writes = today.entries.filter((e) => e.kind === "write" && e.session && laneOf.has(e.session))
  const messages = today.entries.filter((e) => (e.kind === "ask" || e.kind === "handoff" || e.kind === "tell") && e.session && laneOf.has(e.session) && e.to)
  const grants = today.entries.filter((e) => e.kind === "claim" && e.text === "after waiting" && e.session && laneOf.has(e.session))
  const releases = new Map(today.entries.filter((e) => e.kind === "release" || e.kind === "expire").map((e) => [e.seq, e]))

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="ln" role="img" aria-label="Agent sessions as lanes through the day">
      <defs>
        <marker id="la" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" className="ln-head" />
        </marker>
      </defs>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={x(t)} y1={TOP - 4} x2={x(t)} y2={H - 22} className="ln-grid" />
          <text x={x(t)} y={H - 8} className="ln-ax" textAnchor="middle">
            {fmt(t)}
          </text>
        </g>
      ))}
      {lanes.map((l) => (
        <g key={l.session}>
          <circle cx={16} cy={l.y + 20} r={3.5} style={{ fill: l.color }} />
          <text x={26} y={l.y + 24} className="ln-who">
            {agentName(l.owner)}
          </text>
          <text x={26} y={l.y + 37} className="ln-sub">
            for {first(l.forName)}
          </text>
          {l.guests.map((g, gi) => (
            <g key={g.id} transform={`translate(${118 - gi * 11} ${l.y + 31})`}>
              <title>{`${g.label} joined`}</title>
              <circle r={6} className="ln-av" />
              <text y={2.6} textAnchor="middle" className="ln-avt">
                {g.kind === "agent" ? g.address.split("/")[1]!.charAt(0).toUpperCase() : g.label.charAt(0)}
              </text>
            </g>
          ))}
          <line x1={8} y1={l.y + LANE} x2={W - 8} y2={l.y + LANE} className="ln-rule" />
        </g>
      ))}
      {today.claims.map((c) => {
        const l = laneOf.get(c.session)
        if (!l) return null
        return <rect key={c.key} x={x(c.since)} y={l.y + 30} width={Math.max(2, x(now) - x(c.since))} height={3} rx={1.5} className="ln-claim"><title>{`${label(c.holder)} holds ${c.title ?? c.key}`}</title></rect>
      })}
      {lanes.flatMap((l) =>
        [...l.trajectories].sort((a, b) => a.startedAt - b.startedAt).map((t, i, list) => {
          const x1 = x(t.startedAt)
          const x2 = Math.max(x1 + 4, x(t.endedAt ?? now))
          // The label sits right of the bar, up to the next bar in the lane; inside the bar when that is wider.
          const next = list[i + 1]
          const room = (next ? x(next.startedAt) : W - RIGHT) - x2 - 12
          const inside = x2 - x1 - 10
          const fit = (width: number) => {
            const chars = Math.floor(width / 5.8)
            return chars >= t.intent.length ? t.intent : chars > 6 ? `${t.intent.slice(0, chars - 1)}…` : null
          }
          const outside = fit(room)
          const within = inside > room ? fit(inside) : null
          return (
            <g key={t.id} onClick={() => navigate(paths.trajectory(workspace, t.session, t.id))}>
              <title>{`${t.intent} · ${t.status}`}</title>
              <rect x={x1} y={l.y + 13} width={x2 - x1} height={14} rx={4} className="ln-bar" style={{ ["--c" as string]: l.color, opacity: t.status === "running" ? 1 : 0.75 }} />
              {t.status === "running" && <circle cx={x(now)} cy={l.y + 20} r={4} style={{ fill: l.color }} />}
              {within ? (
                <text x={x1 + 6} y={l.y + 24} className="ln-lab">
                  {within}
                </text>
              ) : outside ? (
                <text x={x2 + 8} y={l.y + 24} className="ln-lab">
                  {outside}
                </text>
              ) : null}
            </g>
          )
        }),
      )}
      {writes.map((e) => {
        const l = laneOf.get(e.session!)!
        return <circle key={e.seq} cx={x(e.at)} cy={l.y + 20} r={3.2} className="ln-w"><title>{`v${e.version} of ${e.title ?? e.keys[0]}`}</title></circle>
      })}
      {messages.map((e) => {
        const from = laneOf.get(e.session!)!
        const to = byAddress.get(e.to!) ?? lanes.find((l) => today.claims.some((c) => c.session === l.session && c.key === e.to))
        if (!to || to === from) return null
        const down = to.y > from.y
        return (
          <path key={e.seq} d={`M${x(e.at)} ${from.y + (down ? 28 : 12)} L${x(e.at)} ${to.y + (down ? 12 : 28)}`} className="ln-arrow ln-msg" markerEnd="url(#la)">
            <title>{`${label(e.actor)}: ${e.text ?? ""}`}</title>
          </path>
        )
      })}
      {grants.map((e) => {
        const to = laneOf.get(e.session!)!
        const release = releases.get(e.seq - 1)
        const from = release?.session ? laneOf.get(release.session) : undefined
        if (!from || from === to) return null
        const down = to.y > from.y
        return <path key={e.seq} d={`M${x(e.at)} ${from.y + (down ? 33 : 12)} L${x(e.at)} ${to.y + (down ? 12 : 28)}`} className="ln-arrow ln-rel" markerEnd="url(#la)"><title>{`Released to ${label(e.actor)}`}</title></path>
      })}
      <line x1={x(now)} y1={TOP - 6} x2={x(now)} y2={H - 22} className="ln-now" />
      <text x={x(now)} y={TOP - 8} textAnchor="middle" className="ln-nowl">
        {new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
      </text>
    </svg>
  )
}
