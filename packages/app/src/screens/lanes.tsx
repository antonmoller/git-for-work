import type { Views } from "@work/schema/views"
import { agentName, colorFor, first, label, navigate, paths } from "../lib.ts"

type Today = Views.Today

const W = 728
const LEFT = 92
const RIGHT = 16
const LANE = 34
const TOP = 16
const BAR = 6
const AXIS = 18
const LEGEND = 18

/** Picks a tick step that gives about six to ten ticks across the range. */
const step = (span: number) => {
  const steps = [10e3, 30e3, 60e3, 5 * 60e3, 10 * 60e3, 15 * 60e3, 30 * 60e3, 3600e3, 2 * 3600e3, 4 * 3600e3]
  return steps.find((s) => span / s <= 10) ?? 6 * 3600e3
}

/** Puts events closer than `gap` pixels in one group, so they draw as one mark. */
function cluster<A>(items: ReadonlyArray<A>, at: (a: A) => number, key: (a: A) => string, gap = 8) {
  const groups: { x: number; items: A[]; key: string }[] = []
  for (const item of [...items].sort((a, b) => at(a) - at(b))) {
    const last = groups.findLast((g) => g.key === key(item))
    if (last && at(item) - last.x < gap) last.items.push(item)
    else groups.push({ x: at(item), items: [item], key: key(item) })
  }
  return groups
}

/**
 * One lane per agent session. A span is a trajectory (bright while it runs), beads on it are writes, the amber line
 * under it a claim still held. Straight arrows between lanes are messages (grey) and claims handed to a waiting agent (amber).
 * Hover any mark for what it was.
 */
export function Lanes({ today, workspace, now }: { today: Today; workspace: string; now: number }) {
  const sessions = [...new Set([...today.trajectories].sort((a, b) => a.startedAt - b.startedAt).map((t) => t.session as string))]
  if (sessions.length === 0) return <div className="empty">No agent has started anything today. Agents appear here as soon as they run `work start`.</div>
  const lanes = sessions.map((session, i) => {
    const trajectories = [...today.trajectories.filter((t) => t.session === session)].sort((a, b) => a.startedAt - b.startedAt)
    const owner = trajectories[0]!.owner
    const presence = today.presence.find((p) => p.session === session)
    const guests = (presence?.members ?? []).filter((m) => !m.owner)
    const live = (presence?.members ?? []).some((m) => m.owner) || trajectories.some((t) => t.status === "running")
    const y = TOP + i * LANE
    return { session, i, owner, forName: trajectories[0]!.forName, trajectories, guests, live, color: colorFor(i), y, cy: y + LANE / 2 }
  })
  const laneOf = new Map(lanes.map((l) => [l.session, l]))
  const byAddress = new Map(lanes.map((l) => [`${l.owner.handle}/${l.owner.agent}`, l]))

  const start = Math.min(...today.trajectories.map((t) => t.startedAt))
  const span0 = Math.max(now - start, 60e3)
  const tick = step(span0 * 1.08)
  const t0 = Math.floor(start / tick) * tick
  const t1 = Math.max(now + span0 * 0.03, t0 + tick)
  const x = (t: number) => LEFT + ((t - t0) / (t1 - t0)) * (W - LEFT - RIGHT)
  const bottom = TOP + lanes.length * LANE
  const H = bottom + AXIS + LEGEND
  const ticks: number[] = []
  for (let t = t0; t <= t1; t += tick) ticks.push(t)
  const fmt = (t: number) =>
    new Date(t).toLocaleTimeString([], tick < 60e3 ? { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false } : { hour: "2-digit", minute: "2-digit", hour12: false })

  const writes = today.entries.filter((e) => e.kind === "write" && e.session && laneOf.has(e.session))
  const releases = new Map(today.entries.filter((e) => e.kind === "release" || e.kind === "expire").map((e) => [e.seq, e]))
  type Lane = (typeof lanes)[number]
  type Link = { seq: number; at: number; from: Lane; to: Lane; kind: "msg" | "rel"; text: string }
  const links: Link[] = []
  for (const e of today.entries) {
    if (!e.session || !laneOf.has(e.session)) continue
    if ((e.kind === "ask" || e.kind === "handoff" || e.kind === "tell") && e.to) {
      const from = laneOf.get(e.session)!
      const to = byAddress.get(e.to) ?? lanes.find((l) => today.claims.some((c) => c.session === l.session && c.key === e.to))
      if (to && to !== from) links.push({ seq: e.seq, at: e.at, from, to, kind: "msg", text: `${agentName(e.actor)} ${e.kind === "tell" ? "told" : e.kind === "ask" ? "asked" : "handed off"}: ${e.text ?? ""}` })
    }
    if (e.kind === "claim" && e.text === "after waiting") {
      const release = releases.get(e.seq - 1)
      const from = release?.session ? laneOf.get(release.session) : undefined
      const to = laneOf.get(e.session)!
      if (from && from !== to) links.push({ seq: e.seq, at: e.at, from, to, kind: "rel", text: `${agentName(from.owner)} handed ${e.title ?? e.keys[0] ?? "a claim"} to ${agentName(e.actor)}` })
    }
  }
  const state = (t: Lane["trajectories"][number]) => (t.status === "running" ? "running" : t.status === "failed" ? "gave up" : "done")

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="ln" role="img" aria-label="Agent sessions as lanes through the day">
      <defs>
        <marker id="la" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="5" markerHeight="5" markerUnits="userSpaceOnUse" orient="auto">
          <path d="M0 0 L6 3 L0 6 z" className="ln-head" />
        </marker>
        <marker id="lr" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="5" markerHeight="5" markerUnits="userSpaceOnUse" orient="auto">
          <path d="M0 0 L6 3 L0 6 z" className="ln-head rel" />
        </marker>
      </defs>

      {ticks.map((t) => (
        <g key={t}>
          <line x1={x(t)} y1={TOP} x2={x(t)} y2={bottom} className="ln-grid" />
          <text x={x(t)} y={bottom + 12} className="ln-ax" textAnchor="middle">
            {fmt(t)}
          </text>
        </g>
      ))}
      {lanes.map((l) => (
        <g key={l.session}>
          <line x1={LEFT - 6} y1={l.cy} x2={W - RIGHT} y2={l.cy} className="ln-track" />
          <g className="ln-name" onClick={() => navigate(paths.session(workspace, l.session))}>
            <title>{`${label(l.owner)}${l.guests.length ? `, with ${l.guests.map((g) => g.label).join(", ")}` : ""}: open the session`}</title>
            <circle cx={8} cy={l.cy} r={3} style={{ fill: l.live ? l.color : "transparent", stroke: l.color }} className="ln-dot" />
            <text x={16} y={l.cy - 1} className="ln-who">
              {agentName(l.owner)}
            </text>
            <text x={16} y={l.cy + 8} className="ln-sub">
              for {first(l.forName)}
              {l.guests.length > 0 ? ` · +${l.guests.length}` : ""}
            </text>
          </g>
        </g>
      ))}

      {/* Trajectories: thin spans, no text; hover tells */}
      {lanes.flatMap((l) =>
        l.trajectories.map((t) => {
          const x1 = x(t.startedAt)
          const x2 = Math.max(x1 + BAR, x(t.endedAt ?? now))
          return (
            <rect
              key={t.id}
              x={x1}
              y={l.cy - BAR / 2}
              width={x2 - x1}
              height={BAR}
              rx={BAR / 2}
              className={t.status === "running" ? "ln-bar on" : "ln-bar"}
              style={{ ["--c" as string]: l.color }}
              onClick={() => navigate(paths.trajectory(workspace, t.session, t.id))}
            >
              <title>{`${t.intent}\n${state(t)} · ${t.steps} steps, ${t.tools} tool calls`}</title>
            </rect>
          )
        }),
      )}

      {today.claims.map((c) => {
        const l = laneOf.get(c.session)
        if (!l) return null
        return (
          <rect key={c.key} x={x(c.since)} y={l.cy + BAR / 2 + 2} width={Math.max(3, x(now) - x(c.since))} height={1.5} rx={0.75} className="ln-claim">
            <title>{`${label(c.holder)} holds ${c.title ?? c.key}`}</title>
          </rect>
        )
      })}

      {cluster(writes, (e) => x(e.at), (e) => e.session!, 5).map((g) => {
        const l = laneOf.get(g.key)!
        const names = [...new Set(g.items.map((e) => e.title ?? e.keys[0]))]
        return (
          <circle key={g.items[0]!.seq} cx={g.x} cy={l.cy} r={g.items.length > 1 ? 2 : 1.4} className="ln-w">
            <title>{g.items.length === 1 ? `Wrote v${g.items[0]!.version} of ${names[0]}` : `${g.items.length} writes: ${names.join(", ")}`}</title>
          </circle>
        )
      })}

      {/* Messages: a straight arrow from the sender's span to the receiver's; close ones merge, thicker the more they carry */}
      {cluster(links, (k) => x(k.at), (k) => `${k.kind}:${k.from.session}>${k.to.session}`, 10).map((g) => {
        const k = g.items[0]!
        const rel = k.kind === "rel"
        const dir = k.to.cy > k.from.cy ? 1 : -1
        const ax = g.x + (rel ? 3 : 0)
        const y1 = k.from.cy + dir * (BAR / 2 + 2)
        const y2 = k.to.cy - dir * (BAR / 2 + 2)
        const d = `M${ax} ${y1} L${ax} ${y2}`
        const weight = g.items.length > 1 ? 1.5 : 1
        return (
          <g key={k.seq} className="ln-link">
            <title>{g.items.map((i) => i.text).join("\n")}</title>
            <path d={d} className="ln-hit" />
            <path d={d} className={rel ? "ln-arrow rel" : "ln-arrow"} style={{ strokeWidth: weight }} markerEnd={rel ? "url(#lr)" : "url(#la)"} />
          </g>
        )
      })}

      <line x1={x(now)} y1={TOP - 2} x2={x(now)} y2={bottom} className="ln-now" />
      <text x={x(now)} y={TOP - 5} textAnchor="middle" className="ln-nowl">
        now
      </text>

      <g transform={`translate(${LEFT} ${bottom + AXIS + 9})`} className="ln-legend">
        <rect x={0} y={-5} width={16} height={BAR} rx={BAR / 2} className="ln-bar on" style={{ ["--c" as string]: "var(--mfg)" }} />
        <text x={21} y={0}>running</text>
        <rect x={62} y={-5} width={16} height={BAR} rx={BAR / 2} className="ln-bar" style={{ ["--c" as string]: "var(--mfg)" }} />
        <text x={83} y={0}>done</text>
        <circle cx={114} cy={-2} r={1.8} style={{ fill: "var(--mfg)" }} />
        <text x={120} y={0}>write</text>
        <rect x={150} y={-3} width={14} height={1.5} className="ln-claim" />
        <text x={169} y={0}>claim held</text>
        <path d="M218 -2 L232 -2" className="ln-arrow" markerEnd="url(#la)" />
        <text x={237} y={0}>message</text>
        <path d="M280 -2 L294 -2" className="ln-arrow rel" markerEnd="url(#lr)" />
        <text x={299} y={0}>claim handed over</text>
      </g>
    </svg>
  )
}
