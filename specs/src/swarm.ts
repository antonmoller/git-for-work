/**
 * Many agents working the same workspace at once, through the client, against a running Worker. Each agent has its
 * own session and loops: start a trajectory, claim (waiting when busy), read, write on its last read, sometimes write
 * on a stale base or into a URL someone else holds, answer its inbox, release, end. Alongside: a task race, agents
 * joining other agents' sessions and writing there, and people in the browser commenting and asking for reverts.
 *
 * Afterwards it checks the laws against the workspace log and every session's own log, and reports latency.
 */
import { Exit } from "effect"
import { WorkClient, WorkSocket } from "@work/client"

export interface SwarmOptions {
  readonly baseUrl: string
  readonly people: number
  readonly rounds: number
  readonly seed: number
  readonly joiners: number
  readonly tasks: number
  readonly log?: (line: string) => void
}

type Outcome<A> = { ok: true; value: A } | { ok: false; tag: string; error: any }
type Work = ReturnType<typeof WorkClient.connect>

const HANDLES = ["karl", "anna", "lars", "eva", "omar", "sara", "nils", "maja", "ivan", "lea"]
const AGENTS = ["codex", "claude"]

/** Written as people paste them: schemes, www, tracking params, trailing slashes. Normalized by the Worker. */
const URLS = [
  "https://erp.example.com/prices",
  "https://erp.example.com/prices/eu?utm_source=mail",
  "https://www.erp.example.com/prices/us/",
  "https://erp.example.com/suppliers/acme",
  "https://erp.example.com/suppliers/bolt",
  "https://docs.example.com/pricing",
  "https://crm.example.com/accounts/1",
  "https://crm.example.com/accounts/2",
]

const mulberry32 = (seed: number) => () => {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** The same boundary rule as the Worker: one key is the other, or sits under it at `/`, `?`, `#` or `&`. */
const covers = (a: string, b: string) => b === a || (b.startsWith(a) && "/?#&".includes(b[a.length]!))
const overlaps = (a: string, b: string) => covers(a, b) || covers(b, a)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function swarm(options: SwarmOptions) {
  const say = options.log ?? (() => {})
  const random = mulberry32(options.seed)
  const pick = <A>(xs: ReadonlyArray<A>) => xs[Math.floor(random() * xs.length)]!
  const chance = (p: number) => random() < p
  const run = `${Date.now().toString(36)}${Math.floor(random() * 1e4)}`
  const workspace = `swarm-${run}`
  const B = options.baseUrl

  // Latency per endpoint, and what each agent saw.
  const timings = new Map<string, number[]>()
  const observed = { refusals: new Map<string, number>(), granted: 0, waitedOut: 0, held: 0, stale: 0, keyHeld: 0, written: 0, reverts: 0, revertRefused: 0, asks: 0, answers: 0, comments: 0, revertRequests: 0, taken: 0, taskTaken: 0, joinedWrites: 0 }
  const violations: string[] = []
  const lastWritten = new Map<string, string>()

  const token = async (handle: string) =>
    ((await (await fetch(`${B}/auth/dev?as=${handle}&format=token`)).json()) as { token: string }).token

  const call = async <A, E>(work: Work, label: string, f: (c: WorkClient.Client) => any): Promise<Outcome<A>> => {
    const started = performance.now()
    const exit = (await work.exit(f)) as Exit.Exit<A, E>
    const list = timings.get(label) ?? []
    list.push(performance.now() - started)
    timings.set(label, list)
    if (Exit.isSuccess(exit)) return { ok: true, value: exit.value }
    const failure = exit.cause.reasons.find((r) => r._tag === "Fail")
    const error = failure && failure._tag === "Fail" ? (failure.error as any) : exit.cause
    return { ok: false, tag: error?._tag ?? "Defect", error }
  }

  const refused = (session: string) => observed.refusals.set(session, (observed.refusals.get(session) ?? 0) + 1)

  // Set up: one admin creates the workspace.
  const people = HANDLES.slice(0, options.people)
  const tokens = new Map(await Promise.all(people.map(async (h) => [h, await token(h)] as const)))
  const admin = WorkClient.connect({ baseUrl: B, token: () => tokens.get(people[0]!)! })
  const created = await call(admin, "createWorkspace", (c) => c.account.createWorkspace({ payload: { slug: workspace, name: `Swarm ${run}` } }))
  if (!created.ok) throw new Error(`Could not create the workspace: ${created.tag}`)
  const params = { workspace }

  interface Agent {
    readonly handle: string
    readonly name: string
    readonly address: string
    readonly session: string
    readonly work: Work
  }
  const agents: Agent[] = people.flatMap((handle) =>
    AGENTS.map((name) => {
      const session = `${workspace}-${handle}-${name}`
      return { handle, name, address: `${handle}/${name}`, session, work: WorkClient.connect({ baseUrl: B, token: () => tokens.get(handle)!, agent: name, session }) }
    }),
  )
  say(`workspace ${workspace}: ${agents.length} agents, ${options.rounds} rounds, seed ${options.seed}`)

  const asksTo = new Map<string, number>()
  const asksSeen = new Map<string, number>()

  const drainInbox = async (agent: Agent) => {
    const inbox = await call<{ items: any[] }, unknown>(agent.work, "inbox", (c) => c.log.inbox({ params, query: {} }))
    if (!inbox.ok) return violations.push(`${agent.address} inbox failed: ${inbox.tag}`)
    for (const item of inbox.value.items) {
      if (item.kind === "ask") {
        asksSeen.set(`${item.id}`, (asksSeen.get(`${item.id}`) ?? 0) + 1)
        const answer = await call(agent.work, "send", (c) => c.message.send({ params, payload: { kind: "tell", to: item.member ?? item.actor.handle, text: `Re: ${item.text} — done in a minute`, ref: item.seq } }))
        if (answer.ok) observed.answers++
      }
      if (item.kind === "revert.request" && item.version) {
        // The browser asked this agent's person to undo a version: claim, check, apply, write.
        const url = `https://${item.keys[0]}`
        const claimed = await call<any, unknown>(agent.work, "claim", (c) => c.claim.claim({ params, payload: { urls: [{ url }], wait: 3000 } }))
        if (!claimed.ok) continue
        if (claimed.value._tag === "Waiting" && (await waitFor(agent, claimed.value.waiter, claimed.value.deadline)) !== "granted") continue
        if (claimed.value._tag === "Held") continue
        const plan = await call<any, unknown>(agent.work, "revert", (c) => c.write.revert({ params, payload: { url, version: item.version } }))
        if (!plan.ok) {
          observed.revertRefused++
          refused(agent.session)
        } else {
          const put = await call<any, unknown>(agent.work, "put", (c) =>
            c.write.put({ params, payload: { url, base: plan.value.current, content: plan.value.content ?? "{}", revertOf: plan.value.revertOf, why: "revert requested in the browser" } }),
          )
          if (put.ok) {
            observed.reverts++
            lastWritten.set(item.keys[0], plan.value.content ?? "{}")
          } else {
            refused(agent.session)
            violations.push(`${agent.address} revert write of ${item.keys[0]} refused with ${put.tag} while it held the claim`)
          }
        }
        await call(agent.work, "release", (c) => c.claim.release({ params, payload: { urls: [url] } }))
      }
    }
  }

  /** Waits for a waiter: polls its status, as the CLI falls back to when it has no watch socket. */
  const waitFor = async (agent: Agent, waiter: number, deadline: number) => {
    for (;;) {
      const status = await call<any, unknown>(agent.work, "waiter", (c) => c.claim.waiter({ params: { ...params, waiter } }))
      if (status.ok && status.value.status !== "waiting") return status.value.status as string
      if (Date.now() > deadline + 2000) {
        // A grant can land between the last poll and the cancel; the answer says which.
        const cancelled = await call<any, unknown>(agent.work, "cancelWait", (c) => c.claim.cancelWait({ params: { ...params, waiter } }))
        return cancelled.ok ? (cancelled.value.status as string) : "cancelled"
      }
      await sleep(100 + random() * 100)
    }
  }

  const round = async (agent: Agent, r: number) => {
    const urls = [...new Set([pick(URLS), ...(chance(0.3) ? [pick(URLS)] : [])])]
    const start = await call<any, unknown>(agent.work, "start", (c) => c.session.start({ params, payload: { intent: `Round ${r}: update ${urls.join(", ")}` } }))
    if (!start.ok) return violations.push(`${agent.address} start failed: ${start.tag}`)
    await call(agent.work, "step", (c) => c.session.step({ params, payload: { kind: "note", text: `Looking at ${urls.length} page(s)` } }))
    await call(agent.work, "step", (c) => c.session.step({ params, payload: { kind: "tool", text: "Bash", data: { command: "git status" } } }))

    const claimed = await call<any, unknown>(agent.work, "claim", (c) => c.claim.claim({ params, payload: { urls: urls.map((url) => ({ url, title: url.split("/").at(-1) })), wait: 6000 } }))
    if (!claimed.ok) return violations.push(`${agent.address} claim failed: ${claimed.tag}`)
    let got = claimed.value._tag === "Claimed"
    if (claimed.value._tag === "Waiting") {
      const status = await waitFor(agent, claimed.value.waiter, claimed.value.deadline)
      got = status === "granted"
      if (got) observed.granted++
      else observed.waitedOut++
    }
    if (claimed.value._tag === "Held") observed.held++
    if (!got) {
      const conflicts = claimed.value.conflicts as any[]
      if (conflicts[0]) {
        observed.asks++
        asksTo.set(conflicts[0].member, (asksTo.get(conflicts[0].member) ?? 0) + 1)
        await call(agent.work, "send", (c) => c.message.send({ params, payload: { kind: "ask", to: conflicts[0].member, text: `When are you done with ${conflicts[0].key}?` } }))
      }
      await call(agent.work, "end", (c) => c.session.end({ params, payload: { status: "failed", why: "the pages stayed busy" } }))
      return
    }

    for (const url of urls) {
      const read = await call<any, unknown>(agent.work, "step", (c) => c.session.step({ params, payload: { kind: "read", url } }))
      if (!read.ok) return violations.push(`${agent.address} read failed: ${read.tag}`)
      const version: number | null = read.value.version
      const key: string = read.value.keys[0]
      if (version !== null && version > 1 && chance(0.25)) {
        const stale = await call<any, unknown>(agent.work, "put", (c) => c.write.put({ params, payload: { url, base: version - 1, content: "{}" } }))
        if (stale.ok) violations.push(`${agent.address} wrote ${key} on stale base v${version - 1} (current v${version})`)
        else if (stale.tag === "StaleBase") observed.stale++
        else violations.push(`${agent.address} stale write got ${stale.tag}`)
        if (!stale.ok) refused(agent.session)
      }
      const content = JSON.stringify({ price: Math.round(random() * 1000), currency: pick(["SEK", "EUR", "USD"]), by: agent.address, round: r })
      const put = await call<any, unknown>(agent.work, "put", (c) => c.write.put({ params, payload: { url, content, why: `round ${r}` } }))
      if (!put.ok) {
        refused(agent.session)
        violations.push(`${agent.address} write of ${key} on its last read refused with ${put.tag}`)
      } else {
        observed.written++
        lastWritten.set(key, content)
        if (put.value.version !== (version ?? 0) + 1) violations.push(`${agent.address} wrote ${key} as v${put.value.version} after reading v${version}`)
      }
    }

    // Sometimes write into a page it did not claim: refused if someone holds it, accepted if it is free.
    if (chance(0.15)) {
      const url = pick(URLS.filter((u) => !urls.includes(u)))
      const who = await call<any, unknown>(agent.work, "who", (c) => c.claim.who({ params, query: { url } }))
      if (who.ok) {
        const put = await call<any, unknown>(agent.work, "put", (c) => c.write.put({ params, payload: { url, base: who.value.version, content: JSON.stringify({ note: `drive-by from ${agent.address}` }) } }))
        if (!put.ok) {
          refused(agent.session)
          if (put.tag === "KeyHeld") observed.keyHeld++
          else if (put.tag !== "StaleBase") violations.push(`${agent.address} drive-by write got ${put.tag}`)
        } else {
          observed.written++
          lastWritten.set(put.value.entry.keys[0], JSON.stringify({ note: `drive-by from ${agent.address}` }))
        }
      }
    }

    await drainInbox(agent)
    await call(agent.work, "release", (c) => c.claim.release({ params, payload: { urls } }))
    await call(agent.work, "end", (c) => c.session.end({ params, payload: { status: "done" } }))
  }

  // People in the browser: comments and revert requests, on the URLs' current state.
  const browser = async (handle: string) => {
    const person = WorkClient.connect({ baseUrl: B, token: () => tokens.get(handle)! })
    for (let i = 0; i < options.rounds; i++) {
      await sleep(200 + random() * 400)
      const url = pick(URLS)
      const who = await call<any, unknown>(person, "who", (c) => c.claim.who({ params, query: { url } }))
      if (!who.ok || who.value.version === null) continue
      if (chance(0.5)) {
        const sent = await call(person, "send", (c) => c.message.send({ params, payload: { kind: "comment", url, text: `Is v${who.value.version} right?`, version: who.value.version } }))
        if (sent.ok) observed.comments++
        else violations.push(`${handle} comment refused: ${sent.tag}`)
      } else {
        const writer = who.value.writtenBy as { handle: string }
        const sent = await call(person, "requestRevert", (c) => c.write.requestRevert({ params, payload: { url, version: who.value.version, to: writer.handle } }))
        if (sent.ok) observed.revertRequests++
        else violations.push(`${handle} revert request refused: ${sent.tag}`)
      }
    }
    await person.dispose()
  }

  // Agents join other agents' sessions and write there under the host session's claims.
  const joinAndWrite = async (guest: Agent, host: Agent, r: number) => {
    const members: string[][] = []
    const socket = WorkSocket.presence({ baseUrl: B, token: () => tokens.get(guest.handle)!, agent: guest.name }, workspace, host.session, {
      message: (m) => members.push(m.members.map((x) => x.address)),
    })
    await sleep(300)
    const asGuest = WorkClient.connect({ baseUrl: B, token: () => tokens.get(guest.handle)!, agent: guest.name, session: host.session, ownSession: guest.session })
    const view = await call<any, unknown>(asGuest, "view", (c) => c.session.view({ params: { ...params, session: host.session } }))
    if (view.ok && !view.value.members.some((m: any) => m.address === guest.address)) violations.push(`${guest.address} joined ${host.session} but is not among its members`)
    await call(asGuest, "step", (c) => c.session.step({ params, payload: { kind: "note", text: `${guest.address} helping in round ${r}` } }))
    const url = `https://notes.example.com/${host.session}/${guest.address}`
    const claimed = await call<any, unknown>(asGuest, "claim", (c) => c.claim.claim({ params, payload: { urls: [{ url }] } }))
    if (claimed.ok && claimed.value._tag === "Claimed") {
      const put = await call<any, unknown>(asGuest, "put", (c) => c.write.put({ params, payload: { url, base: null, content: JSON.stringify({ helper: guest.address, round: r }) } }))
      if (put.ok) {
        observed.joinedWrites++
        lastWritten.set(put.value.entry.keys[0], JSON.stringify({ helper: guest.address, round: r }))
        if (put.value.entry.member !== guest.address || put.value.entry.session !== host.session)
          violations.push(`a joined write was recorded as ${put.value.entry.member} in ${put.value.entry.session}, not ${guest.address} in ${host.session}`)
      } else violations.push(`${guest.address} could not write in joined session: ${put.tag}`)
      await call(asGuest, "release", (c) => c.claim.release({ params, payload: { urls: [url] } }))
    } else violations.push(`${guest.address} could not claim its own note page in the joined session`)
    socket.close()
    await asGuest.dispose()
    if (!members.some((list) => list.includes(guest.address))) violations.push(`${host.session} presence never showed ${guest.address}`)
  }

  // The task race: one agent adds tasks, everyone tries to take each one at once.
  const taskRace = async () => {
    const lead = agents[0]!
    const titles = Array.from({ length: options.tasks }, (_, i) => `Check supplier ${i + 1} (${run})`)
    for (const title of titles) await call(lead.work, "addTask", (c) => c.message.addTask({ params, payload: { title } }))
    await call(lead.work, "flush", (c) => c.session.flush({ params }))
    const winners = new Map<string, string[]>()
    await Promise.all(
      titles.flatMap((title) =>
        agents.map(async (agent) => {
          const taken = await call<any, unknown>(agent.work, "takeTask", (c) => c.message.takeTask({ params, payload: { task: title } }))
          if (taken.ok) {
            observed.taken++
            winners.set(title, [...(winners.get(title) ?? []), agent.address])
          } else if (taken.tag === "TaskTaken") {
            observed.taskTaken++
            refused(agent.session)
          } else violations.push(`${agent.address} take ${title}: ${taken.tag}`)
        }),
      ),
    )
    for (const title of titles) if ((winners.get(title) ?? []).length !== 1) violations.push(`task "${title}" had ${(winners.get(title) ?? []).length} takers: ${winners.get(title)?.join(", ")}`)
  }

  // Watch the whole run, as the web app would.
  let watched = 0
  let watchSynced = false
  const watcher = WorkSocket.watch({ baseUrl: B, token: () => tokens.get(people[0]!)! }, workspace, 0, {
    entries: (e) => (watched += e.length),
    synced: () => (watchSynced = true),
  })

  const started = performance.now()
  await taskRace()
  say(`task race done`)
  await Promise.all([
    ...agents.map(async (agent) => {
      for (let r = 1; r <= options.rounds; r++) {
        await round(agent, r)
        if (r === 2 && agents.indexOf(agent) < options.joiners) {
          const host = agents[(agents.indexOf(agent) + 3) % agents.length]!
          await joinAndWrite(agent, host, r)
        }
      }
    }),
    ...people.slice(0, 2).map(browser),
  ])
  const swarmMs = performance.now() - started
  say(`agents done in ${Math.round(swarmMs)} ms`)

  // Settle: flush every session, then drain inboxes once more.
  for (const agent of agents) await call(agent.work, "flush", (c) => c.session.flush({ params }))
  for (const agent of agents) await drainInbox(agent)
  for (const agent of agents) await call(agent.work, "flush", (c) => c.session.flush({ params }))

  // The laws, from the workspace log.
  const log = await call<any[], unknown>(admin, "log", (c) => c.log.log({ params, query: { limit: 1_000_000 } }))
  if (!log.ok) throw new Error(`Could not read the log: ${log.tag}`)
  const entries = [...log.value].sort((a, b) => a.seq - b.seq)

  entries.forEach((e, i) => e.seq !== i + 1 && violations.push(`workspace seq ${e.seq} at position ${i + 1}`))
  const byAggregate = new Map<string, any[]>()
  for (const e of entries) byAggregate.set(e.aggregate, [...(byAggregate.get(e.aggregate) ?? []), e])
  for (const [aggregate, list] of byAggregate) list.forEach((e, i) => e.aseq !== i + 1 && violations.push(`${aggregate} aseq ${e.aseq} at position ${i + 1}`))

  // Claims never overlap across sessions; accepted writes happen only where no other session holds the URL.
  const held = new Map<string, string>()
  for (const e of entries) {
    if (e.kind === "claim") {
      for (const k of e.keys) {
        for (const [hk, hs] of held) if (hs !== e.session && overlaps(hk, k)) violations.push(`seq ${e.seq}: ${e.session} claimed ${k} while ${hs} held ${hk}`)
        held.set(k, e.session)
      }
    }
    if (e.kind === "release" || e.kind === "expire") for (const k of e.keys) if (held.get(k) === e.session) held.delete(k)
    if (e.kind === "write") for (const [hk, hs] of held) if (hs !== e.session && overlaps(hk, e.keys[0])) violations.push(`seq ${e.seq}: ${e.session} wrote ${e.keys[0]} while ${hs} held ${hk}`)
  }

  // Versions run 1..n per URL and every write was based on the version before it.
  const versions = new Map<string, any[]>()
  for (const e of entries.filter((e) => e.kind === "write")) versions.set(e.keys[0], [...(versions.get(e.keys[0]) ?? []), e])
  for (const [key, list] of versions)
    list.forEach((e, i) => {
      if (e.version !== i + 1) violations.push(`${key}: write at seq ${e.seq} is v${e.version}, expected v${i + 1}`)
      if (e.base !== (i === 0 ? null : i)) violations.push(`${key}: v${e.version} based on ${e.base}`)
    })

  // Each session's own log equals the workspace's events for it, and refusals match what agents were told.
  const hosts = new Set(agents.map((a) => a.session))
  for (const agent of agents) {
    const view = await call<any, unknown>(agent.work, "view", (c) => c.session.view({ params: { ...params, session: agent.session } }))
    if (!view.ok) {
      violations.push(`${agent.session} view failed: ${view.tag}`)
      continue
    }
    const local = view.value.events.map((e: any) => `${e.aseq}:${e.id}`)
    const remote = (byAggregate.get(agent.session) ?? []).map((e) => `${e.aseq}:${e.id}`)
    if (JSON.stringify(local) !== JSON.stringify(remote)) violations.push(`${agent.session}: session log (${local.length}) differs from the workspace's (${remote.length})`)
    const refusals = (byAggregate.get(agent.session) ?? []).filter((e) => e.kind === "refused").length
    if (refusals !== (observed.refusals.get(agent.session) ?? 0)) violations.push(`${agent.session}: ${refusals} refused events, agents were refused ${observed.refusals.get(agent.session) ?? 0} times`)
    if (view.value.members.length !== 0) violations.push(`${agent.session} still shows members after everyone left: ${view.value.members.map((m: any) => m.address)}`)
  }
  void hosts

  // Every question reached the agent it was asked of, once.
  const askEntries = entries.filter((e) => e.kind === "ask")
  for (const ask of askEntries) if ((asksSeen.get(ask.id) ?? 0) !== 1) violations.push(`ask ${ask.id} to ${ask.to} was seen ${asksSeen.get(ask.id) ?? 0} times`)
  if (askEntries.length !== observed.asks) violations.push(`${observed.asks} asks sent, ${askEntries.length} in the log`)

  // The last content written to each URL is what the Worker returns.
  for (const [key, content] of lastWritten) {
    const v = versions.get(key)?.at(-1)?.version
    if (!v) continue
    const got = await call<any, unknown>(admin, "version", (c) => c.write.version({ params, query: { url: `https://${key}`, version: v } }))
    if (!got.ok) violations.push(`${key}@v${v}: ${got.tag}`)
    else if (got.value.content !== content) violations.push(`${key}@v${v}: stored content differs from the last write`)
  }

  // Claims all released, trajectories all ended.
  const today = await call<any, unknown>(admin, "today", (c) => c.log.today({ params, query: { since: 0 } }))
  if (today.ok) {
    if (today.value.claims.length !== 0) violations.push(`claims left after the run: ${today.value.claims.map((c: any) => `${c.key} by ${c.session}`).join(", ")}`)
    const running = today.value.trajectories.filter((t: any) => t.status === "running")
    if (running.length !== 0) violations.push(`${running.length} trajectories still running`)
  }

  await sleep(300)
  if (!watchSynced) violations.push("the watch socket never synced")
  if (watched !== entries.length) violations.push(`the watch socket saw ${watched} entries, the log has ${entries.length}`)
  watcher.close()

  const latency = Object.fromEntries(
    [...timings].map(([label, list]) => {
      const sorted = [...list].sort((a, b) => a - b)
      const q = (p: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!)
      return [label, { n: sorted.length, p50: q(0.5), p95: q(0.95), max: q(1) }]
    }),
  )
  for (const agent of agents) await agent.work.dispose()
  await admin.dispose()

  return {
    workspace,
    agents: agents.length,
    entries: entries.length,
    kinds: Object.fromEntries([...new Set(entries.map((e) => e.kind))].map((k) => [k, entries.filter((e) => e.kind === k).length])),
    swarmMs: Math.round(swarmMs),
    observed: { ...observed, refusals: [...observed.refusals.values()].reduce((a, b) => a + b, 0) },
    latency,
    violations,
  }
}
