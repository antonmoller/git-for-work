import { Change } from "../diff.tsx"
import { useEffect, useState } from "react"
import { WorkSocket } from "@work/client"
import type { Entry } from "@work/schema/entry"
import type { Session } from "@work/schema/session"
import type { Views } from "@work/schema/views"
import type { Write } from "@work/schema/write"
import { addressLabel, call, clock, duration, keyTitle, label, navigate, onLink, paths, refusal, time, useLoad, useNow } from "../lib.ts"
import { Avatar, Section, Shell, Slash, useLive } from "../shell.tsx"

type Step = (Entry.Event | Entry.Info) & { tools?: number }

/** Joins the session as a person while the page is open; everyone in it shows up here. */
function usePresence(workspace: string, session: string) {
  const [members, setMembers] = useState<ReadonlyArray<Session.Member>>([])
  useEffect(() => {
    const handle = WorkSocket.presence({ baseUrl: location.origin }, workspace, session, { message: (m) => setMembers(m.members) })
    return () => handle.close()
  }, [workspace, session])
  return members
}

export function TrajectoryScreen({ session, trajectory }: { session: string; trajectory?: string }) {
  const live = useLive()
  const now = useNow()
  const [tab, setTab] = useState<"steps" | "writes" | "tools">("steps")
  const members = usePresence(live.workspace, session)
  const view = useLoad(() => call<Views.SessionView>((c) => c.session.view({ params: { workspace: live.workspace, session } })), [live.workspace, session, live.tick])
  const id = trajectory ?? view.data?.trajectories[0]?.id
  const extra = useLoad(
    () =>
      id
        ? Promise.all([
            call<Entry.Info[]>((c) => c.log.log({ params: { workspace: live.workspace }, query: { trajectory: id, limit: 2000 } })),
            call<Entry.Info[]>((c) => c.log.log({ params: { workspace: live.workspace }, query: { to: session, limit: 200 } })),
            call<Views.Today>((c) => c.log.today({ params: { workspace: live.workspace }, query: { since: Date.now() } })),
          ])
        : Promise.resolve(null),
    [live.workspace, id, session, live.tick],
  )
  useEffect(() => {
    if (!trajectory && id) navigate(paths.trajectory(live.workspace, session, id))
  }, [trajectory, id, live.workspace, session])

  const t = view.data?.trajectories.find((x) => x.id === id)
  const names = new Map<string, string>((view.data?.trajectories ?? []).map((x) => [x.owner.handle, x.owner.name]))
  if (view.error) return <Shell section="other"><div className="win"><div className="error">Could not load the session: {view.error.tag}</div></div></Shell>
  if (!view.data) return <Shell section="other"><div className="win"><div className="empty">Loading…</div></div></Shell>
  if (!t) return <Shell section="other"><div className="win"><div className="empty">This session has no trajectories yet.</div></div></Shell>

  // Steps: the session's own events for this trajectory, plus what the workspace decided for it (grants, expiries)
  // and what people said to the session while it ran. Tool calls fold into the step before them.
  const [workspaceEntries, toSession, today] = extra.data ?? [[], [], null]
  // A joined member's events carry its own trajectory (or none); those made while this one ran show here too.
  const ownerAddress = `${t.owner.handle}/${t.owner.agent}`
  const until = t.endedAt ?? Infinity
  const own = view.data.events.filter((e) => e.trajectory === id || (e.member !== ownerAddress && e.trajectory === null && e.at >= t.startedAt && e.at <= until))
  const ids = new Set(own.map((e) => e.id))
  const decided = workspaceEntries.filter((e) => !ids.has(e.id))
  const said = toSession.filter((e) => e.at >= t.startedAt && (t.endedAt === null || e.at <= t.endedAt + 60e3) && !ids.has(e.id))
  const all: Step[] = [...own, ...decided, ...said].sort((a, b) => a.at - b.at || a.aseq - b.aseq)
  const steps: Step[] = []
  const tools: Step[] = []
  for (const e of all) {
    if (e.kind === "tool") {
      tools.push(e)
      const last = steps.at(-1)
      if (last) last.tools = (last.tools ?? 0) + 1
    } else steps.push({ ...e })
  }
  const writes = steps.filter((e) => e.kind === "write")
  const holds = today?.claims.filter((c) => c.trajectory === id) ?? []
  const wrote = new Map<string, number[]>()
  for (const w of writes) wrote.set(w.keys[0]!, [...(wrote.get(w.keys[0]!) ?? []), w.version!])
  const status = t.status === "running" ? <span className="badge b-blue"><i />Running</span> : t.status === "done" ? <span className="badge b-ok"><i />Done</span> : <span className="badge b-bad"><i />Gave up</span>

  return (
    <Shell section="other" crumbs={<Slash>{label(t.owner)}</Slash>}>
      <div className="win">
        <header className="rh">
          <h1 className="trunc">{t.intent}</h1>
          <span className="seg">
            <button className={tab === "steps" ? "on" : ""} onClick={() => setTab("steps")}>Steps</button>
            <button className={tab === "writes" ? "on" : ""} onClick={() => setTab("writes")}>Writes <small>{writes.length}</small></button>
            <button className={tab === "tools" ? "on" : ""} onClick={() => setTab("tools")}>Tool calls <small>{tools.length}</small></button>
          </span>
          <div className="actions">{status}</div>
        </header>
        <div className="body">
          <div className="steps">
            {(tab === "steps" ? steps : tab === "writes" ? writes : tools).map((e, i, list) => (
              <StepRow key={e.id} e={e} names={names} owner={ownerAddress} last={i === list.length - 1 && t.status === "running" && tab === "steps"} />
            ))}
            {tab === "tools" && tools.length === 0 && <div className="empty">No tool calls logged.</div>}
          </div>
        </div>
      </div>
      <aside className="details">
        <div className="dh">
          <h2>Trajectory {t.id}</h2>
          <span className="badge b-dim">{duration((t.endedAt ?? now) - t.startedAt)}</span>
        </div>
        <div className="sect first">
          <div className="rc">
            <div className="kv">
              <span className="dim">Agent</span>
              <span>{t.owner.agent ? `${label(t.owner)}, signed in as ${t.owner.name.split(" ")[0]}` : t.owner.name}</span>
              <span className="dim">Session</span>
              <span className="mono trunc" title={session}>{session}</span>
              <span className="dim">Works for</span>
              <span>{t.forName}</span>
              <span className="dim">Started</span>
              <span>{time(t.startedAt)}{t.status === "running" ? ", still running" : t.endedAt ? `, ended ${time(t.endedAt)}` : ""}</span>
              <span className="dim">Steps</span>
              <span>{steps.length} steps, {tools.length} tool calls</span>
            </div>
          </div>
        </div>
        <Section title="In the session now" count={members.length}>
          {members.length === 0 && <span className="dim">Nobody is connected.</span>}
          {members.map((m) => (
            <div key={m.id} className="row">
              <Avatar name={m.label} agent={m.kind === "agent" ? m.address.split("/")[1] : null} size="lg" />
              <span className="grow trunc med">{m.label}{m.address === live.me.actor.handle ? " (you)" : ""}</span>
              <span className="dim">{m.owner ? "owner" : m.kind === "agent" ? "joined" : "watching"} · {time(m.since)}</span>
            </div>
          ))}
        </Section>
        <Section title="Holds now" count={holds.length}>
          {holds.length === 0 && <span className="dim">Nothing.</span>}
          {holds.map((c) => (
            <a key={c.key} className="row" href={paths.url(live.workspace, c.key)} onClick={onLink(paths.url(live.workspace, c.key))}>
              <span className="med grow trunc">{keyTitle(c.key, c.title)}</span>
              {now - c.lastActive < 2 * 60e3 ? <span className="live"><i />active now</span> : <span className="quiet">quiet</span>}
              <span className="dim">since {time(c.since)}</span>
            </a>
          ))}
        </Section>
        <Section title="Wrote" count={wrote.size}>
          {wrote.size === 0 && <span className="dim">No writes.</span>}
          {[...wrote].map(([key, versions]) => (
            <a key={key} className="row" href={paths.url(live.workspace, key, versions.at(-1))} onClick={onLink(paths.url(live.workspace, key, versions.at(-1)))}>
              <span className="grow trunc">{keyTitle(key, writes.find((w) => w.keys[0] === key)?.title)}</span>
              <span className="ver">{versions.map((v) => `v${v}`).join(", ")}</span>
            </a>
          ))}
        </Section>
        <div className="sect">
          <Compose
            placeholder="Comment…"
            hint={`${label(t.owner)} reads it on its next command`}
            send={(text) => call((c) => c.message.send({ params: { workspace: live.workspace }, payload: { kind: "comment", text, to: session } }))}
          />
        </div>
      </aside>
    </Shell>
  )
}

function StepRow({ e, names, owner, last }: { e: Step; names: Map<string, string>; owner: string; last: boolean }) {
  const live = useLive()
  const key = e.keys[0]
  const chip = (k: string, title?: string | null, v?: number | null) => (
    <a className="key" href={paths.url(live.workspace, k, v ?? undefined)} onClick={onLink(paths.url(live.workspace, k, v ?? undefined))} title={k}>
      {keyTitle(k, title)}
    </a>
  )
  // Entries by a member who joined the session say who wrote them.
  const byMember = e.member && e.member !== owner ? label(e.actor) : null
  const tools = e.tools ? <span className="dim">· {e.tools} tool call{e.tools === 1 ? "" : "s"}</span> : null
  const who = byMember ? <span className="dim">· {byMember}</span> : null
  let mark = ""
  let body: React.ReactNode = null
  switch (e.kind) {
    case "trajectory.start": {
      const data = (e.data ?? {}) as { forName?: string }
      mark = "h"
      body = (
        <>
          <div className="ti"><span className="med">Started</span><span className="dim">for {data.forName ?? e.actor.name}</span>{tools}</div>
          <div className="quote">{e.text}</div>
        </>
      )
      break
    }
    case "trajectory.end":
      mark = e.title === "failed" ? "x" : "h"
      body = <div className="ti"><span className="med">{e.title === "failed" ? "Gave up" : "Finished"}</span>{e.text && <span className="dim">· {e.text}</span>}</div>
      break
    case "read":
      body = <div className="ti"><span className="med">Read</span>{key && chip(key, e.title, e.version)}{e.version ? <span className="ver">v{e.version}</span> : <span className="ver">new</span>}{who}{tools}</div>
      break
    case "note":
      body = <div className="ti"><span>{e.text}</span>{who}{tools}</div>
      break
    case "tool":
      body = <div className="ti"><span className="mono">{e.text}</span><span className="dim">{clock(e.at)}</span>{e.data ? <span className="dim mono trunc">{JSON.stringify(e.data).slice(0, 120)}</span> : null}</div>
      break
    case "claim":
      mark = "c"
      body = <div className="ti"><span className="med">{e.text === "after waiting" ? "Claimed after waiting" : "Claimed"}</span>{e.keys.map((k) => <span key={k}>{chip(k, e.keys.length === 1 ? e.title : null)}</span>)}{who}{tools}</div>
      break
    case "release":
    case "expire":
      mark = "c"
      body = <div className="ti"><span className="med">{e.kind === "expire" ? "Claim expired" : "Released"}</span>{e.keys.map((k) => <span key={k}>{chip(k)}</span>)}{tools}</div>
      break
    case "write":
      mark = "w"
      body = (
        <>
          <div className="ti">
            <span className="med">{e.revertOf ? `Reverted v${e.revertOf}` : "Wrote"}</span>
            {key && chip(key, e.title, e.version)}
            <span className="ver">{e.base ? `v${e.base} → v${e.version}` : `v${e.version}, new`}</span>
            {e.text && <span className="dim">· {e.text}</span>}
            {who}
            {tools}
          </div>
          {key && e.version && e.fields.length > 0 && <Diff k={key} version={e.version} />}
        </>
      )
      break
    case "refused":
      mark = "x"
      body = <div className="ti"><span className="med">{refusal(e.text)}</span><span className="dim">({e.title})</span>{e.keys.map((k) => <span key={k}>{chip(k)}</span>)}{who}{tools}</div>
      break
    case "comment":
      mark = "q"
      body = (
        <>
          <div className="ti"><span className="med">{label(e.actor)} commented</span><span className="dim">· {e.actor.agent ? "" : "in the browser"}</span></div>
          <div className="quote">{e.text}</div>
        </>
      )
      break
    case "ask":
    case "tell":
    case "handoff":
      mark = "q"
      body = (
        <>
          <div className="ti">
            <span className="med">{e.kind === "ask" ? "Asked" : e.kind === "tell" ? "Told" : "Handed off to"}</span>
            {e.to && (e.to.includes(".") ? chip(e.to) : <span>{addressLabel(e.to, names)}</span>)}
            {who}
            {tools}
          </div>
          <div className="quote">{e.text}</div>
        </>
      )
      break
    case "revert.start":
      mark = "c"
      body = <div className="ti"><span className="med">Started reverting</span>{key && chip(key)}<span className="ver">v{e.version ?? e.revertOf}</span>{tools}</div>
      break
    case "task.add":
    case "task.take":
    case "task.done":
      mark = e.kind === "task.done" ? "h" : ""
      body = <div className="ti"><span className="med">{e.kind === "task.add" ? "Added a task" : e.kind === "task.take" ? "Took a task" : "Finished a task"}</span><span>"{e.text}"</span>{who}{tools}</div>
      break
    case "join":
    case "leave":
      mark = "h"
      body = <div className="ti"><span className="med">{e.text ?? label(e.actor)} {e.kind === "join" ? "joined the session" : "left the session"}</span></div>
      break
    default:
      body = <div className="ti"><span className="med">{e.kind}</span><span>{e.text}</span></div>
  }
  return (
    <div className="step">
      <span className="t" title={new Date(e.at).toLocaleString()}>{clock(e.at).slice(0, 5)}</span>
      <span className="m"><i className={last ? "run" : mark} /></span>
      <div className="b">{body}</div>
    </div>
  )
}

/** What a write changed, as a diff. */
function Diff({ k, version }: { k: string; version: number }) {
  const live = useLive()
  const v = useLoad(() => call<{ version: Write.Version_ }>((c) => c.write.version({ params: { workspace: live.workspace }, query: { url: `https://${k}`, version } })), [k, version])
  if (!v.data) return null
  const { changed, before, after } = v.data.version
  return <Change k={k} changed={changed} before={before} after={after} />
}

export function Compose({ placeholder, hint, send }: { placeholder: string; hint?: string; send: (text: string) => Promise<unknown> }) {
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    if (!text.trim()) return
    setBusy(true)
    setError(null)
    try {
      await send(text.trim())
      setText("")
    } catch (e) {
      setError((e as { tag?: string }).tag ?? "Could not send")
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="compose">
      <textarea
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && submit()}
      />
      <div className="row">
        {error ? <span className="grow" style={{ color: "var(--danger)" }}>{error}</span> : hint ? <span className="grow dim">{hint}</span> : <span className="grow" />}
        <button className="btn sm pri" disabled={busy || !text.trim()} onClick={submit}>
          Send
        </button>
      </div>
    </div>
  )
}
