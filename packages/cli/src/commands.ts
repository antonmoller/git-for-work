import { readFileSync, writeFileSync } from "node:fs"
import { basename } from "node:path"
import { WorkSocket } from "@work/client"
import type { Claim } from "@work/schema/claim"
import type { Entry } from "@work/schema/entry"
import { Fields } from "@work/schema/fields"
import type { Task } from "@work/schema/task"
import type { Views } from "@work/schema/views"
import type { Write } from "@work/schema/write"
import { Config } from "./config.ts"
import type { Ctx } from "./context.ts"
import { Exit, EXIT, address, clock, info, isJson, label, line, parseDuration, parseVersion, print } from "./output.ts"
import { attend } from "./presence.ts"
import { Target } from "./target.ts"

export type Opts = Record<string, string | boolean | undefined>
export interface Command {
  readonly usage: string
  readonly summary: string
  readonly group: string
  readonly run: (ctx: Ctx, args: string[], opts: Opts) => Promise<void>
}

const str = (v: string | boolean | undefined) => (typeof v === "string" ? v : undefined)
const need = (value: string | undefined, usage: string) => {
  if (!value) throw new Exit(EXIT.usage, `Usage: work ${usage}`)
  return value
}
const isAddress = (text: string) => /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)?$/.test(text) && !Target.looksLikeUrl(text)
const unquote = (v: string | null) => {
  if (v === null) return "(none)"
  try {
    const parsed = JSON.parse(v)
    return typeof parsed === "string" ? parsed : v
  } catch {
    return v
  }
}
const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`)
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

async function contentFrom(opts: Opts, target: { path: string | null }) {
  const from = str(opts.from)
  if (from === "-") return await Bun.stdin.text()
  if (from) return readFileSync(from, "utf8")
  if (target.path) return readFileSync(target.path, "utf8")
  throw new Exit(EXIT.usage, "Say what to write: --from <file>, or --from - to read standard input.")
}

/** Waits for a queued claim: the watch socket wakes it the moment anything happens; a poll covers a lost socket. */
async function waitForClaim(ctx: Ctx, workspace: string, waiter: number, deadline: number) {
  const params = { workspace }
  const head = (await ctx.call<Entry.Info[]>((c) => c.log.log({ params, query: { limit: 1 } })))[0]?.seq ?? 0
  let wake: () => void = () => {}
  const socket = WorkSocket.watch(ctx.options, workspace, head, { entries: () => wake() })
  let interrupted = false
  const onSignal = () => {
    interrupted = true
    wake()
  }
  process.once("SIGINT", onSignal)
  try {
    for (;;) {
      const status = await ctx.call<{ status: string }>((c) => c.claim.waiter({ params: { ...params, waiter } }))
      if (status.status !== "waiting") return status.status
      if (interrupted || Date.now() > deadline + 3000) {
        // A grant can land just before the cancel; the answer says which.
        const cancelled = await ctx.call<{ status: string }>((c) => c.claim.cancelWait({ params: { ...params, waiter } }))
        return cancelled.status === "granted" ? "granted" : interrupted ? "interrupted" : "expired"
      }
      await Promise.race([Bun.sleep(2000), new Promise<void>((r) => (wake = r))])
    }
  } finally {
    process.off("SIGINT", onSignal)
    socket.close()
  }
}

const describeEntry = (e: Entry.Info, names: (handle: string) => string) => {
  const from = e.actor.agent ? address(e.actor) : `${e.actor.name} (${e.actor.handle})`
  const key = e.keys[0]
  switch (e.kind) {
    case "comment":
      return `${from}${key ? ` on ${key}${e.version ? ` v${e.version}` : ""}` : ""}: ${e.text}`
    case "ask":
      return `${from} asks${e.to && e.to.includes(".") ? ` about ${e.to}` : ""}: ${e.text}`
    case "tell":
      return `${from}: ${e.text}`
    case "handoff":
      return `${from} hands off: "${e.text}". Take it with: work task take "${e.text}"`
    case "revert.request":
      return `${from}: revert v${e.version} of ${key}. Do it with: work revert ${key}@v${e.version}`
  }
  void names
  return line(e)
}

export const commands: Record<string, Command> = {
  // Log a trajectory

  start: {
    group: "Log a trajectory",
    usage: 'start "<intent>" [--for <handle>]',
    summary: "Starts a trajectory in this agent session.",
    async run(ctx, [intent], opts) {
      ctx.needSession()
      const workspace = await ctx.workspace()
      const e = await ctx.call<Entry.Event>((c) => c.session.start({ params: { workspace }, payload: { intent: need(intent, this.usage), for: str(opts.for) } }))
      attend(ctx, workspace)
      const data = (e.data ?? {}) as { forName?: string }
      print(`Started ${e.trajectory} for ${data.forName ?? e.actor.name}.`, e)
    },
  },
  note: {
    group: "Log a trajectory",
    usage: 'note "<text>"',
    summary: "Adds a step in the agent's own words.",
    async run(ctx, args) {
      ctx.needSession()
      const workspace = await ctx.workspace()
      const e = await ctx.call<Entry.Event>((c) => c.session.step({ params: { workspace }, payload: { kind: "note", text: need(args.join(" "), this.usage) } }))
      print("Noted.", e)
    },
  },
  read: {
    group: "Log a trajectory",
    usage: "read <url|path> [--version v41]",
    summary: "Records what the agent read and at which version, and prints the content if Work holds it.",
    async run(ctx, [input], opts) {
      ctx.needSession()
      const workspace = await ctx.workspace()
      const target = Target.resolveTarget(need(input, this.usage))
      const version = parseVersion(str(opts.version)) ?? target.version ?? undefined
      const e = await ctx.call<Entry.Event>((c) => c.session.step({ params: { workspace }, payload: { kind: "read", url: target.url, title: str(opts.title), version } }))
      if (!e.version) return print(`No versions of ${e.keys[0]} in Work yet. Write the first with: work put ${e.keys[0]} --base new --from <file>`, e)
      const got = await ctx.call<{ version: Write.Version_; content: string | null }>((c) => c.write.version({ params: { workspace }, query: { url: target.url, version: e.version! } }))
      const fields = got.content ? Fields.parse(got.content) : {}
      const size = "#header" in fields ? plural(Object.keys(fields).length - 1, "row") : "content" in fields ? "text" : plural(Object.keys(fields).length, "field")
      if (isJson()) return print("", { entry: e, version: got.version, content: got.content })
      info(`v${e.version} · ${size} · written ${clock(got.version.at)} by ${address(got.version.actor)}`)
      if (got.content !== null) process.stdout.write(got.content.endsWith("\n") ? got.content : `${got.content}\n`)
    },
  },
  done: {
    group: "Log a trajectory",
    usage: "done",
    summary: "Ends the trajectory and releases its claims.",
    async run(ctx) {
      ctx.needSession()
      const workspace = await ctx.workspace()
      const r = await ctx.call<{ event: Entry.Event; released: string[] }>((c) => c.session.end({ params: { workspace }, payload: { status: "done" } }))
      print(`Finished ${r.event.trajectory}.${r.released.length ? ` Released ${list(r.released)}.` : ""}`, r)
    },
  },
  fail: {
    group: "Log a trajectory",
    usage: 'fail "<why>"',
    summary: "Ends the trajectory as given up, with why, and releases its claims.",
    async run(ctx, args) {
      ctx.needSession()
      const workspace = await ctx.workspace()
      const r = await ctx.call<{ event: Entry.Event; released: string[] }>((c) => c.session.end({ params: { workspace }, payload: { status: "failed", why: args.join(" ") || undefined } }))
      print(`Gave up ${r.event.trajectory}.${r.released.length ? ` Released ${list(r.released)}.` : ""}`, r)
    },
  },

  // Coordinate

  claim: {
    group: "Coordinate",
    usage: "claim <url|path>… [--wait 20m] [--title <title>]",
    summary: "Claims all the URLs or none, waiting up to a limit for any that are held.",
    async run(ctx, inputs, opts) {
      ctx.needSession()
      if (inputs.length === 0) throw new Exit(EXIT.usage, `Usage: work ${this.usage}`)
      const workspace = await ctx.workspace()
      const urls = inputs.map((i) => ({ url: Target.resolveTarget(i).url, title: inputs.length === 1 ? str(opts.title) : undefined }))
      const wait = opts.wait ? parseDuration(String(opts.wait)) : 0
      const started = Date.now()
      const r = await ctx.call<Claim.Result>((c) => c.claim.claim({ params: { workspace }, payload: { urls, wait } }))
      if (r._tag === "Claimed") return print(`Claimed ${r.keys.length === 1 ? r.keys[0] : plural(r.keys.length, "URL")}.`, r)
      const held = r.conflicts.length > 0 ? `Held by ${r.conflicts.map((c) => `${address(c.holder)} since ${clock(c.since)}${c.intent ? ` for "${c.intent}"` : ""}`).join("; ")}.` : "Others are already waiting for it."
      if (r._tag === "Held") throw new Exit(EXIT.refused, `${held}\nAsk the holder with: work ask ${urls[0]!.url} "<question>", or wait with --wait 10m.`, r)
      info(`${held} Waiting up to ${String(opts.wait)}…`)
      const status = await waitForClaim(ctx, workspace, r.waiter, r.deadline)
      if (status === "granted") {
        const minutes = Math.round((Date.now() - started) / 60_000)
        return print(`Claimed after ${minutes < 1 ? `${Math.round((Date.now() - started) / 1000)} seconds` : plural(minutes, "minute")}.`, { _tag: "Claimed", waited: Date.now() - started })
      }
      throw new Exit(EXIT.refused, status === "interrupted" ? "Stopped waiting." : `Still held after ${String(opts.wait)}.`, { _tag: status })
    },
  },
  release: {
    group: "Coordinate",
    usage: "release [<url|path>…]",
    summary: "Releases claims, or all of this session's; the next agent waiting gets them.",
    async run(ctx, inputs) {
      ctx.needSession()
      const workspace = await ctx.workspace()
      const urls = inputs.map((i) => Target.resolveTarget(i).url)
      const r = await ctx.call<{ released: string[]; granted: unknown[] }>((c) => c.claim.release({ params: { workspace }, payload: { urls } }))
      if (r.released.length === 0) return print("Nothing to release.", r)
      print(`Released ${list(r.released)}.${r.granted.length ? ` ${r.granted.length === 1 ? "An agent was waiting and holds it now." : `${r.granted.length} waiting agents hold them now.`}` : ""}`, r)
    },
  },
  who: {
    group: "Coordinate",
    usage: "who <url|path>",
    summary: "Who holds it and since when, who waits, the current version.",
    async run(ctx, [input]) {
      const workspace = await ctx.workspace()
      const target = Target.resolveTarget(need(input, this.usage))
      const w = await ctx.call<Claim.Who>((c) => c.claim.who({ params: { workspace }, query: { url: target.url } }))
      const lines = [`${w.key}${w.title ? ` (${w.title})` : ""}`, w.version ? `v${w.version}, written ${clock(w.writtenAt!)} by ${address(w.writtenBy!)}` : "No versions yet."]
      for (const h of w.holders) lines.push(`Held${h.key !== w.key ? ` (${h.key})` : ""} by ${address(h.holder)} since ${clock(h.since)}${h.intent ? ` for "${h.intent}"` : ""}, active ${clock(h.lastActive)}.`)
      if (w.holders.length === 0) lines.push("Nobody holds it.")
      for (const q of w.waiters) lines.push(`${address(q.actor)} waits since ${clock(q.since)}, until ${clock(q.deadline)}.`)
      print(lines.join("\n"), w)
    },
  },
  put: {
    group: "Coordinate",
    usage: "put <url|path> [--base v43|new] [--from <file>|-] [--why <text>] [--revert v7]",
    summary: "Writes. Refused if the URL moved past the base or someone else holds it.",
    async run(ctx, [input], opts) {
      ctx.needSession()
      const workspace = await ctx.workspace()
      const target = Target.resolveTarget(need(input, this.usage))
      const content = await contentFrom(opts, target)
      const revertOf = parseVersion(str(opts.revert)) ?? undefined
      let base = parseVersion(str(opts.base))
      // A revert's base is the version `work revert` saw; the agent holds the claim, so it is still current.
      if (base === undefined && revertOf !== undefined) base = (await ctx.call<Claim.Who>((c) => c.claim.who({ params: { workspace }, query: { url: target.url } }))).version
      const r = await ctx.call<{ version: number; summary: string; released: string[]; entry: Entry.Info }>((c) =>
        c.write.put({ params: { workspace }, payload: { url: target.url, content, ...(base !== undefined ? { base } : {}), title: str(opts.title), why: str(opts.why), revertOf } }),
      )
      print(`Wrote v${r.version}${revertOf ? `, reverting v${revertOf}` : ""} (${r.summary}).${r.released.length ? " Released." : ""}`, r)
    },
  },
  revert: {
    group: "Coordinate",
    usage: "revert <url|path>@v7 [--fields a,b] [--out <file>] | revert <url|path>@v7 --ask <handle/agent>",
    summary: "Claims the URL and saves what to put back; apply it, then log it with work put --revert v7. --ask asks an agent to do it, as the app's Revert button does.",
    async run(ctx, [input], opts) {
      const workspace = await ctx.workspace()
      const target = Target.resolveTarget(need(input, this.usage))
      if (!target.version) throw new Exit(EXIT.usage, "Name the version to revert: work revert <url>@v7")
      const ask = str(opts.ask)
      if (ask) {
        const e = await ctx.call<Entry.Info>((c) => c.write.requestRevert({ params: { workspace }, payload: { url: target.url, version: target.version!, to: ask } }))
        return print(`Asked ${ask} to revert v${target.version} of ${e.keys[0]}. It arrives in their inbox.`, e)
      }
      ctx.needSession()
      const fields = str(opts.fields)?.split(",").map((f) => f.trim()).filter(Boolean)
      const plan = await ctx.call<Write.RevertPlan>((c) => c.write.revert({ params: { workspace }, payload: { url: target.url, version: target.version!, fields } }))
      const shape = plan.content?.trim().startsWith("{") ? "json" : plan.content?.includes(",") ? "csv" : "txt"
      const out = str(opts.out) ?? `${basename(plan.key.split(/[?#]/)[0]!) || "content"}.v${plan.current + 1}.${shape}`
      if (plan.content !== null) writeFileSync(out, plan.content)
      const values = Object.entries(plan.values).map(([f, v]) => `${f} ${unquote(v)}`)
      print(
        [
          `Claimed. Reverting ${list([...plan.fields])} from v${plan.revertOf}; no write since touched ${plan.fields.length === 1 ? "it" : "them"}.`,
          `Put back ${list(values)}${plan.content !== null ? `, saved to ${out}` : ""}.`,
          `Apply it in the app, then: work put ${plan.key} --revert v${plan.revertOf} --from ${out}`,
        ].join("\n"),
        { ...plan, file: out },
      )
    },
  },
  task: {
    group: "Coordinate",
    usage: 'task add "<title>" | task take <id|title> | task done <id|title>',
    summary: "Work any agent can pick up.",
    async run(ctx, [verb, ...rest]) {
      ctx.needSession()
      const workspace = await ctx.workspace()
      const what = need(rest.join(" "), this.usage)
      if (verb === "add") return print(`Added "${what}".`, await ctx.call((c) => c.message.addTask({ params: { workspace }, payload: { title: what } })))
      if (verb === "take") {
        const t = await ctx.call<Task.Info>((c) => c.message.takeTask({ params: { workspace }, payload: { task: what } }))
        return print(`Took "${t.title}".`, t)
      }
      if (verb === "done") return print(`Done: "${what}".`, await ctx.call((c) => c.message.doneTask({ params: { workspace }, payload: { task: what } })))
      throw new Exit(EXIT.usage, `Usage: work ${this.usage}`)
    },
  },
  tasks: {
    group: "Coordinate",
    usage: "tasks [--all]",
    summary: "The open tasks, and who took them.",
    async run(ctx, _args, opts) {
      const workspace = await ctx.workspace()
      const all = await ctx.call<Task.Info[]>((c) => c.message.tasks({ params: { workspace } }))
      const shown = opts.all ? all : all.filter((t) => t.status !== "done")
      if (shown.length === 0) return print("No open tasks.", shown)
      print(
        shown.map((t) => `${String(t.id).padStart(4)}  ${t.status.padEnd(5)}  ${t.title}${t.taker ? `  (${address(t.taker)})` : t.to ? `  (for ${t.to})` : ""}`).join("\n"),
        shown,
      )
    },
  },
  handoff: {
    group: "Coordinate",
    usage: 'handoff "<task>" --to <handle/agent>',
    summary: "Gives a task to another agent, with a link to this trajectory.",
    async run(ctx, args, opts) {
      ctx.needSession()
      const workspace = await ctx.workspace()
      const to = need(str(opts.to), this.usage)
      const e = await ctx.call<Entry.Event>((c) => c.message.send({ params: { workspace }, payload: { kind: "handoff", text: need(args.join(" "), this.usage), to } }))
      print(`Handed off to ${to}.`, e)
    },
  },
  ask: {
    group: "Coordinate",
    usage: 'ask <handle/agent|url|path> "<text>"',
    summary: "Asks an agent, or whoever holds a URL.",
    async run(ctx, [to, ...text]) {
      await message(ctx, "ask", need(to, this.usage), need(text.join(" "), this.usage))
    },
  },
  tell: {
    group: "Coordinate",
    usage: 'tell <handle/agent|url|path> "<text>"',
    summary: "Answers or informs an agent.",
    async run(ctx, [to, ...text]) {
      await message(ctx, "tell", need(to, this.usage), need(text.join(" "), this.usage))
    },
  },
  comment: {
    group: "Coordinate",
    usage: 'comment <url|path[@v7]|entry> "<text>"',
    summary: "Comments, the same as people do in the browser.",
    async run(ctx, [on, ...text]) {
      const workspace = await ctx.workspace()
      const body = need(text.join(" "), this.usage)
      const target = need(on, this.usage)
      const payload = /^\d+$/.test(target)
        ? { kind: "comment" as const, text: body, ref: Number(target) }
        : (() => {
            const t = Target.resolveTarget(target)
            return { kind: "comment" as const, text: body, url: t.url, version: t.version ?? undefined }
          })()
      const e = await ctx.call<Entry.Event>((c) => c.message.send({ params: { workspace }, payload }))
      print("Commented.", e)
    },
  },
  inbox: {
    group: "Coordinate",
    usage: "inbox [--peek]",
    summary: "Comments, questions, hand-offs and revert requests for this agent, its person and the URLs it holds.",
    async run(ctx, _args, opts) {
      ctx.needSession()
      const workspace = await ctx.workspace()
      const r = await ctx.call<{ items: Entry.Info[] }>((c) => c.log.inbox({ params: { workspace }, query: opts.peek ? { peek: "1" } : {} }))
      if (r.items.length === 0) return print("Nothing new.", r)
      print(r.items.map((e) => `${clock(e.at)}  ${describeEntry(e, (h) => h)}`).join("\n"), r)
    },
  },
  watch: {
    group: "Coordinate",
    usage: "watch [<url|path>…] [--for 10m] [--from-start]",
    summary: "Streams new entries, replaying from where this session left off.",
    async run(ctx, inputs, opts) {
      const workspace = await ctx.workspace()
      const keys = inputs.map((i) => Target.resolveTarget(i).url.replace(/^[a-z]+:\/\/(www\.)?/i, "").replace(/\/$/, "").toLowerCase())
      const stateKey = `${workspace}:${keys.join(",")}`
      const own = ctx.who.ownSession ?? ctx.who.session
      const saved = own ? (Config.state(own).watch?.[stateKey] ?? null) : null
      const after = opts["from-start"] ? 0 : (saved ?? (await ctx.call<Entry.Info[]>((c) => c.log.log({ params: { workspace }, query: { limit: 1 } })))[0]?.seq ?? 0)
      const matches = (e: Entry.Info) => keys.length === 0 || e.keys.some((k) => keys.some((w) => k === w || k.startsWith(w) || w.startsWith(k)))
      let last = after
      await new Promise<void>((resolve) => {
        const socket = WorkSocket.watch(ctx.options, workspace, after, {
          synced: () => info(`Watching${keys.length ? ` ${keys.join(", ")}` : " the workspace"} from #${after}. Ctrl-C to stop.`),
          entries: (entries) => {
            for (const e of entries) {
              last = e.seq
              if (matches(e)) print(line(e), e)
            }
          },
        })
        const stop = () => {
          socket.close()
          resolve()
        }
        process.once("SIGINT", stop)
        if (opts.for) setTimeout(stop, parseDuration(String(opts.for)))
      })
      if (own) {
        const s = Config.state(own)
        Config.saveState(own, { ...s, watch: { ...(s.watch ?? {}), [stateKey]: last } })
      }
    },
  },

  // Read history

  log: {
    group: "Read history",
    usage: "log [<url|path>] [--since v42] [--by <handle/agent>] [--in <session>] [--trajectory t_…] [--limit 50]",
    summary: "The log of a URL, an agent, a trajectory or the workspace, oldest first.",
    async run(ctx, [input], opts) {
      const workspace = await ctx.workspace()
      const url = input ? Target.resolveTarget(input).url : undefined
      const sinceVersion = parseVersion(str(opts.since)) ?? undefined
      const entries = await ctx.call<Entry.Info[]>((c) =>
        c.log.log({ params: { workspace }, query: { url, sinceVersion, by: str(opts.by), trajectory: str(opts.trajectory), session: str(opts.in), limit: Number(str(opts.limit) ?? 50) } }),
      )
      if (entries.length === 0) return print("Nothing logged.", entries)
      print([...entries].reverse().map(line).join("\n"), entries)
    },
  },
  show: {
    group: "Read history",
    usage: "show <entry|t_…|url@v7>",
    summary: "One entry, a whole trajectory, or a URL's content at a version.",
    async run(ctx, [what]) {
      const workspace = await ctx.workspace()
      const target = need(what, this.usage)
      if (/^\d+$/.test(target)) {
        const e = await ctx.call<Entry.Info>((c) => c.log.entry({ params: { workspace, seq: Number(target) } }))
        return print([line(e), e.text && !line(e).includes(e.text) ? e.text : "", e.data ? JSON.stringify(e.data, null, 2) : ""].filter(Boolean).join("\n"), e)
      }
      if (/^t_[a-z0-9]+$/i.test(target)) {
        const entries = await ctx.call<Entry.Info[]>((c) => c.log.log({ params: { workspace }, query: { trajectory: target, limit: 5000 } }))
        if (entries.length === 0) throw new Exit(EXIT.failed, `No trajectory ${target}.`)
        return print([...entries].reverse().map(line).join("\n"), entries)
      }
      const t = Target.resolveTarget(target)
      const version = t.version ?? (await ctx.call<Claim.Who>((c) => c.claim.who({ params: { workspace }, query: { url: t.url } }))).version
      if (!version) throw new Exit(EXIT.failed, `No versions of ${t.url} yet.`)
      const got = await ctx.call<{ version: Write.Version_; content: string | null }>((c) => c.write.version({ params: { workspace }, query: { url: t.url, version } }))
      if (isJson()) return print("", got)
      info(`v${version} · written ${clock(got.version.at)} by ${address(got.version.actor)}${got.version.why ? ` · ${got.version.why}` : ""}`)
      process.stdout.write(got.content === null ? "(content not stored)\n" : got.content.endsWith("\n") ? got.content : `${got.content}\n`)
    },
  },
  blame: {
    group: "Read history",
    usage: "blame <url|path>",
    summary: "For each field or row, the write and trajectory that last changed it.",
    async run(ctx, [input]) {
      const workspace = await ctx.workspace()
      const t = Target.resolveTarget(need(input, this.usage))
      const h = await ctx.call<Views.History>((c) => c.write.history({ params: { workspace }, query: { url: t.url } }))
      if (h.blame.length === 0) return print("Nothing written yet.", h.blame)
      const width = Math.min(24, Math.max(...h.blame.map((b) => b.field.length)))
      print(
        h.blame.map((b) => `${b.field.padEnd(width)}  v${String(b.version).padEnd(3)} ${clock(b.at)}  ${address(b.actor).padEnd(14)} ${b.trajectory ?? ""}  ${unquote(b.value).slice(0, 60)}`).join("\n"),
        h.blame,
      )
    },
  },
  diff: {
    group: "Read history",
    usage: "diff <url|path> [v41] [v43]",
    summary: "What changed between two versions; with one, against the one before it.",
    async run(ctx, [input, a, b]) {
      const workspace = await ctx.workspace()
      const t = Target.resolveTarget(need(input, this.usage))
      const current = (await ctx.call<Claim.Who>((c) => c.claim.who({ params: { workspace }, query: { url: t.url } }))).version
      if (!current) throw new Exit(EXIT.failed, `No versions of ${t.url} yet.`)
      const to = parseVersion(b) ?? parseVersion(a) ?? current
      const from = b ? parseVersion(a)! : to - 1
      const get = async (v: number) => (v < 1 ? "" : ((await ctx.call<{ content: string | null }>((c) => c.write.version({ params: { workspace }, query: { url: t.url, version: v } }))).content ?? ""))
      const [before, after] = [Fields.parse(await get(from)), Fields.parse(await get(to))]
      if (from < 1) for (const k of Object.keys(before)) delete before[k]
      const changed = Fields.changed(before, after)
      if (changed.length === 0) return print(`No difference between v${from} and v${to}.`, { from, to, changed })
      const out = [`v${from} → v${to}: ${plural(changed.length, "change")}`]
      for (const f of changed) {
        if (f in before) out.push(`- ${f}: ${unquote(before[f]!)}`)
        if (f in after) out.push(`+ ${f}: ${unquote(after[f]!)}`)
      }
      print(out.join("\n"), { from, to, changed, before: Object.fromEntries(changed.map((f) => [f, before[f] ?? null])), after: Object.fromEntries(changed.map((f) => [f, after[f] ?? null])) })
    },
  },
}

async function message(ctx: Ctx, kind: "ask" | "tell", to: string, text: string) {
  ctx.needSession()
  const workspace = await ctx.workspace()
  const target = isAddress(to) ? to : Target.resolveTarget(to).url
  const e = await ctx.call<Entry.Event>((c) => c.message.send({ params: { workspace }, payload: { kind, text, to: target } }))
  print(kind === "ask" ? `Asked ${e.to}. The answer arrives in \`work inbox\`.` : `Told ${e.to}.`, e)
}

export { label }
