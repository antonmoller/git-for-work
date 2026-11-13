import type { Views } from "@work/schema/views"
import { agentName, colorFor, first, label, navigate, paths } from "../lib.ts"

type Today = Views.Today

const W = 728
const LEFT = 120
const RIGHT = 20
const LANE = 58
const TOP = 20
const BAR = 18
const AXIS = 22
const LEGEND = 22
const CHAR = 5.6

/** Picks a tick step that gives about six to ten ticks across the range. */
const step = (span: number) => {
  const steps = [10e3, 30e3, 60e3, 5 * 60e3, 10 * 60e3, 15 * 60e3, 30 * 60e3, 3600e3, 2 * 3600e3, 4 * 3600e3]
  return steps.find((s) => span / s <= 10) ?? 6 * 3600e3
}

/** Cuts text to a pixel width, or null when not even a few characters fit. */
const fit = (text: string, width: number) => {
  const chars = Math.floor(width / CHAR)
  return chars >= text.length ? text : chars >= 6 ? `${text.slice(0, chars - 1)}…` : null
}

/** Puts events closer than `gap` pixels in one group, so they draw as one mark with a count. */
function cluster<A>(items: ReadonlyArray<A>, at: (a: A) => number, key: (a: A) => string, gap = 9) {
  const groups: { x: number; items: A[]; key: string }[] = []
  for (const item of [...items].sort((a, b) => at(a) - at(b))) {
    const last = groups.findLast((g) => g.key === key(item))
    if (last && at(item) - last.x < gap) last.items.push(item)
    else groups.push({ x: at(item), items: [item], key: key(item) })
  }
  return groups
}

/**
 * One lane per agent session. A bar is a trajectory (filled while it runs), the dots under it are writes, and an
 * amber line a claim still held. Arrows between lanes are messages (grey) and claims handed to a waiting agent (amber);
 * marks close together merge and show a count.
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
    return { session, i, owner, forName: trajectories[0]!.forName, trajectories, guests, live, color: colorFor(i), y: TOP + i * LANE }
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
  type Link = { seq: number; at: number; from: (typeof lanes)[number]; to: (typeof lanes)[number]; kind: "msg" | "rel"; text: string }
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
      if (from && from !== to) links.push({ seq: e.seq, at: e.at, from, to, kind: "rel", text: `Handed ${e.title ?? e.keys[0] ?? "a claim"} to ${agentName(e.actor)}` })
    }
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="ln" role="img" aria-label="Agent sessions as lanes through the day">
      <defs>
        <marker id="la" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" className="ln-head" />
        </marker>
        <marker id="lr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" className="ln-head-rel" />
        </marker>
      </defs>

      {/* Lanes and the time grid */}
      {lanes.map((l) => (
        <rect key={l.session} x={0} y={l.y} width={W} height={LANE} className={l.i % 2 ? "ln-band alt" : "ln-band"} />
      ))}
      {ticks.map((t) => (
        <g key={t}>
          <line x1={x(t)} y1={TOP} x2={x(t)} y2={bottom} className="ln-grid" />
          <text x={x(t)} y={bottom + 15} className="ln-ax" textAnchor="middle">
            {fmt(t)}
          </text>
        </g>
      ))}

      {/* Who */}
      {lanes.map((l) => (
        <g key={l.session} className="ln-name" onClick={() => navigate(paths.session(workspace, l.session))}>
          <title>{`${label(l.owner)}: open the session`}</title>
          <circle cx={14} cy={l.y + 22} r={4} style={{ fill: l.live ? l.color : "transparent", stroke: l.color }} className="ln-dot" />
          <text x={26} y={l.y + 26} className="ln-who">
            {agentName(l.owner)}
          </text>
          <text x={26} y={l.y + 40} className="ln-sub">
            for {first(l.forName)}
            {l.guests.length > 0 ? ` · +${l.guests.length} joined` : ""}
          </text>
        </g>
      ))}

      {/* Trajectories: ones that nearly touch draw as one bar; the label sits inside when it fits, else under it */}
      {lanes.flatMap((l) => {
        const groups: (typeof l.trajectories)[number][][] = []
        for (const t of l.trajectories) {
          const last = groups.at(-1)
          const end = last ? Math.max(...last.map((g) => x(g.endedAt ?? now))) : -Infinity
          if (last && x(t.startedAt) - end < 10) last.push(t)
          else groups.push([t])
        }
        let free = 0
        return groups.map((g, i) => {
          const latest = g.at(-1)!
          const x1 = x(g[0]!.startedAt)
          const x2 = Math.max(x1 + 8, ...g.map((t) => x(t.endedAt ?? now)))
          const next = groups[i + 1]
          const text = g.length > 1 ? `${latest.intent} (+${g.length - 1})` : latest.intent
          const capStart = Math.max(x1, free)
          const room = (next ? x(next[0]!.startedAt) : W - RIGHT) - capStart - 6
          // Inside the bar whenever a few characters fit; under it only for bars too short to hold any.
          const inside = fit(text, x2 - x1 - 14)
          const under = inside ? null : fit(text, room)
          if (under) free = capStart + under.length * CHAR + 10
          const running = g.some((t) => t.status === "running")
          const state = (t: (typeof g)[number]) => (t.status === "running" ? "running" : t.status === "failed" ? "gave up" : "done")
          return (
            <g key={latest.id} className="ln-t" onClick={() => navigate(paths.trajectory(workspace, latest.session, latest.id))}>
              <title>{g.map((t) => `${t.intent} · ${state(t)} · ${t.steps} steps, ${t.tools} tool calls`).join("\n")}</title>
              <rect x={x1} y={l.y + 10} width={x2 - x1} height={BAR} rx={5} className={running ? "ln-bar on" : "ln-bar"} style={{ ["--c" as string]: l.color }} />
              {inside && (
                <text x={x1 + 7} y={l.y + 23} className="ln-lab">
                  {inside}
                </text>
              )}
              {under && (
                <text x={capStart} y={l.y + 50} className="ln-cap">
                  {under}
                </text>
              )}
            </g>
          )
        })
      })}

      {/* Claims held now */}
      {today.claims.map((c) => {
        const l = laneOf.get(c.session)
        if (!l) return null
        return (
          <rect key={c.key} x={x(c.since)} y={l.y + 31} width={Math.max(3, x(now) - x(c.since))} height={2.5} rx={1.25} className="ln-claim">
            <title>{`${label(c.holder)} holds ${c.title ?? c.key}`}</title>
          </rect>
        )
      })}

      {/* Writes, grouped when close */}
      {cluster(writes, (e) => x(e.at), (e) => e.session!).map((g) => {
        const l = laneOf.get(g.key)!
        const names = [...new Set(g.items.map((e) => e.title ?? e.keys[0]))]
        return (
          <g key={g.items[0]!.seq}>
            <title>{g.items.length === 1 ? `Wrote v${g.items[0]!.version} of ${names[0]}` : `${g.items.length} writes: ${names.join(", ")}`}</title>
            <circle cx={g.x} cy={l.y + 38} r={g.items.length > 1 ? 3.2 : 2.4} className="ln-w" style={{ fill: l.color }} />
            {g.items.length > 1 && (
              <text x={g.x + 5} y={l.y + 41} className="ln-n">
                {g.items.length}
              </text>
            )}
          </g>
        )
      })}

      {/* Messages and hand-overs between two lanes: close ones merge into one arrow, headed both ways when they went both ways */}
      {cluster(links, (k) => x(k.at), (k) => `${k.kind}:${[k.from.session, k.to.session].sort().join("|")}`, 16).map((g) => {
        const k = g.items[0]!
        const [upper, lower] = k.from.y < k.to.y ? [k.from, k.to] : [k.to, k.from]
        const downs = g.items.some((i) => i.to === lower)
        const ups = g.items.some((i) => i.to === upper)
        const y1 = upper.y + 30
        const y2 = lower.y + 8
        const rel = k.kind === "rel"
        const head = rel ? "url(#lr)" : "url(#la)"
        // A hand-over usually follows a message at the same moment; set it beside the message, not on it.
        const ax = rel ? g.x + 5 : g.x
        return (
          <g key={k.seq}>
            <title>{g.items.map((i) => i.text).join("\n")}</title>
            <path d={`M${ax} ${y1} L${ax} ${y2}`} className={rel ? "ln-arrow ln-rel" : "ln-arrow"} markerEnd={downs ? head : undefined} markerStart={ups ? head : undefined} />
            {g.items.length > 1 && (
              <text x={ax + 4} y={(y1 + y2) / 2 + (rel ? 12 : 3)} className="ln-n ln-halo">
                {g.items.length}
              </text>
            )}
          </g>
        )
      })}

      {/* Now */}
      <line x1={x(now)} y1={TOP - 4} x2={x(now)} y2={bottom} className="ln-now" />
      <text x={x(now)} y={TOP - 7} textAnchor="middle" className="ln-nowl">
        now
      </text>

      {/* Legend */}
      <g transform={`translate(${LEFT} ${bottom + AXIS + 12})`} className="ln-legend">
        <rect x={0} y={-7} width={18} height={9} rx={3} className="ln-bar on" style={{ ["--c" as string]: "var(--mfg)" }} />
        <text x={24} y={1}>running</text>
        <rect x={74} y={-7} width={18} height={9} rx={3} className="ln-bar" style={{ ["--c" as string]: "var(--mfg)" }} />
        <text x={98} y={1}>done</text>
        <circle cx={140} cy={-2.5} r={2.6} style={{ fill: "var(--mfg)" }} />
        <text x={148} y={1}>write</text>
        <rect x={186} y={-4} width={16} height={2.5} rx={1.25} className="ln-claim" />
        <text x={208} y={1}>claim held</text>
        <path d="M268 -2.5 L284 -2.5" className="ln-arrow" markerEnd="url(#la)" />
        <text x={290} y={1}>message</text>
        <path d="M344 -2.5 L360 -2.5" className="ln-arrow ln-rel" markerEnd="url(#lr)" />
        <text x={366} y={1}>claim handed over</text>
      </g>
    </svg>
  )
}
