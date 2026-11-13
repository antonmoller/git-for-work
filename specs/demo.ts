/**
 * A live demo for local development: a purchasing team's agents working one workspace at a human pace, so the web
 * app has something to show and move. Runs until stopped.
 *
 *   bun run specs/demo.ts            (WORK_URL defaults to http://localhost:8787, workspace "purchasing")
 *
 * Agents answer questions, act on comments addressed to their session, and carry out revert requests people make in
 * the browser, including yours: sign in locally as `anton` and `anton/claude` picks up your reverts.
 */
import { Exit } from "effect"
import { WorkClient, WorkSocket } from "@work/client"

const B = process.env.WORK_URL ?? "http://localhost:8787"
const workspace = process.env.WORK_WORKSPACE ?? "purchasing"
const params = { workspace }
const PACE = Number(process.env.DEMO_PACE ?? 1)

const PEOPLE: Record<string, string> = { anton: "Anton Möller", karl: "Karl Svensson", anna: "Anna Ek", lea: "Lea Nyberg" }
const AGENTS = ["anton/claude", "karl/codex", "karl/claude", "anna/codex", "lea/codex"]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms * PACE))
const between = (a: number, b: number) => a + Math.random() * (b - a)
const pick = <A>(xs: ReadonlyArray<A>) => xs[Math.floor(Math.random() * xs.length)]!

const token = async (handle: string) =>
  ((await (await fetch(`${B}/auth/dev?as=${handle}&name=${encodeURIComponent(PEOPLE[handle]!)}&format=token`)).json()) as { token: string }).token

type Out = { ok: true; value: any } | { ok: false; tag: string; error: any }
const run = async (work: ReturnType<typeof WorkClient.connect>, f: (c: WorkClient.Client) => any): Promise<Out> => {
  const exit = await work.exit(f)
  if (Exit.isSuccess(exit)) return { ok: true, value: exit.value }
  const failure = exit.cause.reasons.find((r) => r._tag === "Fail")
  const error = failure && failure._tag === "Fail" ? (failure.error as any) : exit.cause
  return { ok: false, tag: error?._tag ?? "Defect", error }
}

/** What the team works on: URLs with titles, and how a write changes them. */
const PAGES = {
  bearings: { url: "https://erp.holm.example/prices/bearings-2027", title: "Bearing prices 2027" },
  nordlager: { url: "https://erp.holm.example/suppliers/nordlager", title: "Nordlager AB" },
  lindqvist: { url: "https://erp.holm.example/suppliers/lindqvist", title: "Lindqvist Industri AB" },
  freight: { url: "https://erp.holm.example/prices/freight-2027", title: "Freight rates 2027" },
  policy: { url: "https://docs.holm.example/document/d/1Kp9#heading=preferred-suppliers", title: "Purchasing policy §3" },
  ticket: { url: "https://linear.app/holm/issue/OPS-412", title: "OPS-412 Supplier switch" },
}
type Page = keyof typeof PAGES

const JOBS: Array<{ intent: string; pages: Page[]; read?: Page[]; tools: string[] }> = [
  { intent: "Move 6204 bearings to Nordlager", pages: ["bearings", "nordlager"], read: ["lindqvist"], tools: ["Read nordlager-quote-1107.pdf", "Bash: diff prices.csv", "WebFetch erp.holm.example"] },
  { intent: "Update freight rates for Q1", pages: ["freight"], read: ["bearings"], tools: ["Read freight-q1.xlsx", "Bash: python rates.py"] },
  { intent: "Apply the new Lindqvist framework agreement", pages: ["lindqvist"], tools: ["Read lindqvist-agreement-2026.pdf", "Grep payment terms"] },
  { intent: "Rewrite Preferred suppliers in the policy", pages: ["policy"], read: ["nordlager", "lindqvist"], tools: ["Read policy.docx", "Edit section 3"] },
  { intent: "Fix lead times on 6205 bearings", pages: ["bearings"], tools: ["Read eva-lund-email.eml", "Bash: grep 6205"] },
  { intent: "Close out the supplier switch ticket", pages: ["ticket"], read: ["bearings", "nordlager"], tools: ["Read OPS-412", "Write comment"] },
]

const content = (page: Page) => {
  switch (page) {
    case "bearings":
    case "freight":
      return [
        "item,supplier,unit_price_sek,lead_days",
        `6204-2RS,${pick(["Nordlager AB", "Lindqvist Industri"])},${between(15, 20).toFixed(2)},${Math.round(between(7, 14))}`,
        `6205-2RS,${pick(["Nordlager AB", "Lindqvist Industri"])},${between(18, 23).toFixed(2)},${Math.round(between(7, 14))}`,
        `6206-2RS,Lindqvist Industri,${between(22, 27).toFixed(2)},${Math.round(between(10, 16))}`,
      ].join("\n")
    case "nordlager":
    case "lindqvist":
      return JSON.stringify(
        {
          name: page === "nordlager" ? "Nordlager AB" : "Lindqvist Industri AB",
          status: pick(["Active", "Active", "Under review"]),
          payment_terms: pick(["30 days", "45 days", "60 days"]),
          discount: pick(["3%", "5%", "7%"]),
          contact: pick(["Eva Lund", "Sofia Dahl", "Per Holm"]),
        },
        null,
        2,
      )
    case "policy":
      return `Preferred suppliers: ${pick(["Nordlager AB, then Lindqvist Industri", "Lindqvist Industri, then Nordlager AB"])}. Review every ${pick(["6", "12"])} months.`
    case "ticket":
      return JSON.stringify({ status: pick(["In progress", "In review", "Done"]), assignee: pick(["Karl", "Anna"]) })
  }
}

async function main() {
  const handles = [...new Set(AGENTS.map((a) => a.split("/")[0]!))]
  const tokens = new Map(await Promise.all(handles.map(async (h) => [h, await token(h)] as const)))
  const admin = WorkClient.connect({ baseUrl: B, token: () => tokens.get("anna")! })
  const me = await run(admin, (c) => c.account.me())
  if (!me.ok) throw new Error(`Cannot reach ${B}: ${me.tag}`)
  if (!me.value.workspaces.some((w: any) => w.slug === workspace)) await run(admin, (c) => c.account.createWorkspace({ payload: { slug: workspace, name: "Purchasing" } }))
  const stamp = Date.now().toString(36)
  console.log(`Demo running on ${B}, workspace ${workspace}. Stop with Ctrl-C.`)

  const agents = AGENTS.map((address) => {
    const [handle, name] = address.split("/") as [string, string]
    const session = `${address.replace("/", "-")}-${stamp}`
    return { address, handle, name, session, work: WorkClient.connect({ baseUrl: B, token: () => tokens.get(handle)!, agent: name, session }) }
  })
  type Agent = (typeof agents)[number]
  const say = (a: Agent, line: string) => console.log(`${new Date().toLocaleTimeString()} ${a.address.padEnd(13)} ${line}`)

  const inbox = async (a: Agent) => {
    const got = await run(a.work, (c) => c.log.inbox({ params, query: {} }))
    if (!got.ok) return
    for (const item of got.value.items) {
      if (item.kind === "ask") {
        await sleep(between(800, 2000))
        await run(a.work, (c) => c.message.send({ params, payload: { kind: "tell", to: item.member ?? item.actor.handle, text: pick(["About 5 minutes.", "Almost done, releasing soon.", "Go ahead after my next write."]), ref: item.seq } }))
        say(a, `answered ${item.member}`)
      }
      if (item.kind === "comment") {
        say(a, `read a comment from ${item.actor.name}: ${item.text}`)
        await run(a.work, (c) => c.session.step({ params, payload: { kind: "note", text: `Read ${item.actor.name}'s comment: "${item.text}"` } }))
        if (!item.actor.agent) await run(a.work, (c) => c.message.send({ params, payload: { kind: "tell", to: item.actor.handle, text: `Noted, I'll take that into account.`, ref: item.seq } }))
      }
      if (item.kind === "revert.request" && item.version && item.keys[0]) {
        const url = `https://${item.keys[0]}`
        say(a, `reverting v${item.version} of ${item.keys[0]} for ${item.actor.name}`)
        await run(a.work, (c) => c.session.start({ params, payload: { intent: `Revert v${item.version} of ${item.title ?? item.keys[0]}, as ${item.actor.name} asked` } }))
        const claimed = await claim(a, [url], 60_000)
        if (claimed) {
          const plan = await run(a.work, (c) => c.write.revert({ params, payload: { url, version: item.version } }))
          if (plan.ok) {
            await run(a.work, (c) => c.session.step({ params, payload: { kind: "tool", text: "Apply the old values in the app" } }))
            await sleep(between(1500, 3000))
            const put = await run(a.work, (c) => c.write.put({ params, payload: { url, base: plan.value.current, content: plan.value.content ?? "{}", revertOf: plan.value.revertOf, why: `revert requested by ${item.actor.name}` } }))
            say(a, put.ok ? `wrote v${put.value.version}, reverting v${item.version}` : `revert write refused: ${put.tag}`)
          } else {
            say(a, `revert refused: ${plan.tag}`)
            await run(a.work, (c) => c.message.send({ params, payload: { kind: "tell", to: item.actor.handle, text: `Could not revert v${item.version}: ${plan.tag === "RevertConflict" ? "a later write changed the same fields" : plan.tag}.` } }))
          }
          await run(a.work, (c) => c.claim.release({ params, payload: { urls: [url] } }))
        }
        await run(a.work, (c) => c.session.end({ params, payload: { status: claimed ? "done" : "failed" } }))
      }
    }
  }

  /** Claims, waiting when another agent holds it; asks the holder how long. */
  const claim = async (a: Agent, urls: string[], wait: number): Promise<boolean> => {
    const got = await run(a.work, (c) => c.claim.claim({ params, payload: { urls: urls.map((url) => ({ url, title: Object.values(PAGES).find((p) => p.url === url)?.title })), wait } }))
    if (!got.ok) return false
    if (got.value._tag === "Claimed") return true
    if (got.value._tag === "Held") return false
    const holder = got.value.conflicts[0]
    if (holder) {
      say(a, `waiting for ${holder.member} on ${holder.key}`)
      await run(a.work, (c) => c.message.send({ params, payload: { kind: "ask", to: holder.member, text: `I need ${holder.title ?? holder.key}. How long?` } }))
    }
    for (;;) {
      await sleep(1000)
      await inbox(a)
      const status = await run(a.work, (c) => c.claim.waiter({ params: { ...params, waiter: got.value.waiter } }))
      if (status.ok && status.value.status === "granted") return true
      if (status.ok && status.value.status !== "waiting") return false
    }
  }

  const job = async (a: Agent) => {
    const j = pick(JOBS)
    await run(a.work, (c) => c.session.start({ params, payload: { intent: j.intent } }))
    say(a, `started "${j.intent}"`)
    await sleep(between(1500, 3000))
    for (const tool of j.tools) {
      await run(a.work, (c) => c.session.step({ params, payload: { kind: "tool", text: tool } }))
      await sleep(between(400, 1200))
    }
    for (const page of [...(j.read ?? []), ...j.pages]) {
      await run(a.work, (c) => c.session.step({ params, payload: { kind: "read", url: PAGES[page].url, title: PAGES[page].title } }))
      await sleep(between(800, 2000))
    }
    const urls = j.pages.map((p) => PAGES[p].url)
    if (!(await claim(a, urls, 90_000))) {
      await run(a.work, (c) => c.session.end({ params, payload: { status: "failed", why: "the pages stayed busy" } }))
      say(a, `gave up on "${j.intent}"`)
      return
    }
    say(a, `claimed ${j.pages.join(", ")}`)
    await run(a.work, (c) => c.session.step({ params, payload: { kind: "note", text: pick(["Comparing the quotes", "Checking the current values first", "Two rows need changing"]) } }))
    for (const page of j.pages) {
      await sleep(between(2000, 5000))
      // Re-read after waiting, so the write is based on what is there now. Sometimes an agent forgets.
      if (Math.random() < 0.8) await run(a.work, (c) => c.session.step({ params, payload: { kind: "read", url: PAGES[page].url } }))
      let put = await run(a.work, (c) => c.write.put({ params, payload: { url: PAGES[page].url, title: PAGES[page].title, content: content(page), why: j.intent } }))
      if (!put.ok && put.tag === "StaleBase") {
        say(a, `stale write on ${page}, reading again`)
        await sleep(1000)
        await run(a.work, (c) => c.session.step({ params, payload: { kind: "read", url: PAGES[page].url } }))
        put = await run(a.work, (c) => c.write.put({ params, payload: { url: PAGES[page].url, title: PAGES[page].title, content: content(page), why: j.intent } }))
      }
      if (!put.ok && put.tag === "Invalid") put = await run(a.work, (c) => c.write.put({ params, payload: { url: PAGES[page].url, title: PAGES[page].title, base: null, content: content(page), why: j.intent } }))
      say(a, put.ok ? `wrote ${page} v${put.value.version} (${put.value.summary})` : `write on ${page} refused: ${put.tag}`)
      await inbox(a)
    }
    if (Math.random() < 0.25) {
      const title = pick(["Check freight on 6205-2RS", "Tell Lindqvist about the move", "Update the reorder points"])
      await run(a.work, (c) => c.message.addTask({ params, payload: { title } }))
      say(a, `added task "${title}"`)
    }
    await sleep(between(1000, 3000))
    await run(a.work, (c) => c.claim.release({ params, payload: { urls } }))
    await run(a.work, (c) => c.session.end({ params, payload: { status: "done" } }))
    say(a, `finished "${j.intent}"`)
  }

  /** Lea's Codex joins Karl's Codex for a while and helps from inside its session. */
  const helper = async () => {
    const guest = agents.find((a) => a.address === "lea/codex")!
    const host = agents.find((a) => a.address === "karl/codex")!
    for (;;) {
      await sleep(between(25_000, 45_000))
      const socket = WorkSocket.presence({ baseUrl: B, token: () => tokens.get("lea")!, agent: "codex" }, workspace, host.session, { message: () => {} })
      say(guest, `joined ${host.address}'s session`)
      const inside = WorkClient.connect({ baseUrl: B, token: () => tokens.get("lea")!, agent: "codex", session: host.session, ownSession: guest.session })
      await sleep(3000)
      await run(inside, (c) => c.session.step({ params, payload: { kind: "note", text: "Lea's Codex: checking the VAT codes on the new supplier" } }))
      await sleep(between(8000, 15_000))
      await run(inside, (c) => c.session.step({ params, payload: { kind: "note", text: "Lea's Codex: VAT codes are right" } }))
      await sleep(3000)
      socket.close()
      await inside.dispose()
      say(guest, `left ${host.address}'s session`)
    }
  }

  /** Tasks get taken. */
  const tasks = async () => {
    for (;;) {
      await sleep(between(10_000, 20_000))
      const list = await run(admin, (c) => c.message.tasks({ params }))
      const open = list.ok ? list.value.filter((t: any) => t.status === "open") : []
      if (open.length === 0) continue
      const a = pick(agents)
      const taken = await run(a.work, (c) => c.message.takeTask({ params, payload: { task: String(open[0].id) } }))
      if (taken.ok) {
        say(a, `took task "${open[0].title}"`)
        await sleep(between(5000, 10_000))
        await run(a.work, (c) => c.message.doneTask({ params, payload: { task: open[0].title } }))
      }
    }
  }

  void helper()
  void tasks()
  await Promise.all(
    agents.map(async (a, i) => {
      await sleep(i * 1500)
      for (;;) {
        await job(a).catch((e) => say(a, `error: ${e}`))
        await inbox(a)
        await sleep(between(3000, 8000))
      }
    }),
  )
}

await main()
