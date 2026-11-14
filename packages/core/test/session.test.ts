import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { Effect } from "effect"
import { ContentHash } from "../src/content/hash.ts"
import { Session } from "../src/session/session.ts"
import { Workspace } from "../src/workspace/workspace.ts"
import { caller, person, tick, world } from "./harness.ts"

const strip = (events: ReadonlyArray<object>) => events.map((e) => Object.fromEntries(Object.entries(e).filter(([k]) => k !== "seq")))

/** Each session's log equals the workspace log filtered to that session, once everything is flushed. */
const sameLogs = async (w: ReturnType<typeof world>, id: string) => {
  await w.session(id, Session.flush)
  const local = await w.session(id, Session.events())
  const remote = await w.workspace(Workspace.sessionEvents(id, 0))
  expect(strip(remote)).toEqual(strip(local))
  expect(local.map((e) => e.aseq)).toEqual(local.map((_, i) => i + 1))
}

const coordinatedClaim = (w: ReturnType<typeof world>, id: string, handle: string, agent: string, key: string) => {
  const who = w.who(id, handle, agent)
  return Session.coordinate(who, "claim", [key], w.inWorkspace(Workspace.claim({ ...caller(handle, agent, id), now: who.now }, [{ key, title: null }])))
}

describe("session flush", () => {
  test("is idempotent when the workspace's reply is lost", async () => {
    const w = world()
    const who = w.who("s1", "karl", "codex")
    await w.session("s1", Session.start(who, { id: "t_aaaa", intent: "Move bearings", forHandle: "karl", forName: "Karl Svensson" }))
    for (const text of ["read the list", "compare quotes", "draft"]) await w.session("s1", Session.record(who, { kind: "note", text }))
    w.faults.replayReplyLost = 1
    expect((await w.sessionExit("s1", Session.flush))._tag).toBe("Failure")
    expect(await w.session("s1", Session.flushed)).toBe(0)
    // The workspace committed; the retry resends the same events and changes nothing there.
    expect(await w.session("s1", Session.flush)).toBe(4)
    await w.workspace(Workspace.replay("s1", await w.session("s1", Session.events()), tick()))
    await sameLogs(w, "s1")
    expect((await w.workspace(Workspace.today(0))).trajectories[0].steps).toBe(4)
  })

  test("ending a trajectory clears the member's current one, and the next start takes over", async () => {
    const w = world()
    const who = w.who("s1", "karl", "codex")
    await w.session("s1", Session.start(who, { id: "t_aaaa", intent: "One", forHandle: "karl", forName: "Karl" }))
    await w.session("s1", Session.end(who, "done", null))
    expect(await w.session("s1", Session.current("karl/codex"))).toBeNull()
    await w.session("s1", Session.start(who, { id: "t_bbbb", intent: "Two", forHandle: "karl", forName: "Karl" }))
    expect(await w.session("s1", Session.current("karl/codex"))).toBe("t_bbbb")
    expect((await w.session("s1", Session.trajectories)).map((t): [string, string] => [t.id, t.status])).toEqual([["t_bbbb", "running"], ["t_aaaa", "done"]])
    await sameLogs(w, "s1")
  })

  test("a coordinated action flushes first, so the session's order holds in the workspace", async () => {
    const w = world()
    const who = w.who("s1", "karl", "codex")
    await w.session("s1", Session.record(who, { kind: "note", text: "one" }))
    await w.session("s1", Session.record(who, { kind: "note", text: "two" }))
    await w.session("s1", coordinatedClaim(w, "s1", "karl", "codex", "erp.se/prices"))
    const log = await w.workspace(Workspace.log({ session: "s1", order: "asc" }))
    expect(log.map((e) => e.kind)).toEqual(["note", "note", "claim"])
    await sameLogs(w, "s1")
  })

  test("a refusal is recorded in the session and reaches the workspace", async () => {
    const w = world()
    await w.session("s1", coordinatedClaim(w, "s1", "karl", "codex", "erp.se/prices"))
    const who = w.who("s2", "karl", "claude")
    const write = Workspace.write({ ...caller("karl", "claude", "s2"), now: who.now }, { key: "erp.se/prices", title: null, base: null, content: "x", fields: { a: "1" }, why: null, revertOf: null, reads: [] })
    const exit = await w.sessionExit("s2", Session.coordinate(who, "write", ["erp.se/prices"], w.inWorkspace(write)))
    expect(exit._tag).toBe("Failure")
    await sameLogs(w, "s2")
    expect((await w.session("s2", Session.events())).map((e) => [e.kind, e.title, e.text])).toEqual([["refused", "write", "KeyHeld"]])
  })

  test("a session repairs what the workspace decided before the session heard back", async () => {
    const w = world()
    w.faults.pullLost = 1
    expect((await w.sessionExit("s1", coordinatedClaim(w, "s1", "karl", "codex", "erp.se/p")))._tag).toBe("Failure")
    expect(await w.session("s1", Session.events())).toEqual([])
    await w.session("s1", Session.repair)
    await sameLogs(w, "s1")
    expect((await w.session("s1", Session.events())).map((e) => e.kind)).toEqual(["claim"])
  })

  test("any mix of local events, coordinated actions and lost replies leaves both logs equal", () =>
    fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            session: fc.constantFrom("s1", "s2"),
            op: fc.constantFrom("note", "tool", "flush", "lost-flush", "claim", "release", "write"),
            key: fc.constantFrom("erp.se/a", "erp.se/a/b", "erp.se/c"),
          }),
          { maxLength: 25 },
        ),
        async (ops) => {
          const w = world()
          const agent = { s1: "codex", s2: "claude" } as const
          for (const o of ops) {
            const who = w.who(o.session, "karl", agent[o.session])
            const c = { ...caller("karl", agent[o.session], o.session), now: who.now }
            const run = (e: Effect.Effect<unknown, unknown, never>) => w.sessionExit(o.session, Session.coordinate(who, o.op as never, [o.key], e))
            if (o.op === "note" || o.op === "tool") await w.session(o.session, Session.record(who, { kind: o.op, text: o.key }))
            if (o.op === "flush") await w.session(o.session, Session.flush)
            if (o.op === "lost-flush") {
              w.faults.replayReplyLost = 1
              await w.sessionExit(o.session, Session.flush)
              w.faults.replayReplyLost = 0
            }
            if (o.op === "claim") await run(w.inWorkspace(Workspace.claim(c, [{ key: o.key, title: null }])))
            if (o.op === "release") await run(w.inWorkspace(Workspace.release(c, [o.key])))
            if (o.op === "write") {
              const head = await w.workspace(Workspace.who(o.key))
              const fields = { v: String(who.now) }
              await run(w.inWorkspace(Workspace.write(c, { key: o.key, title: null, base: head.version, content: ContentHash.sha256(fields.v), fields, why: null, revertOf: null, reads: [] })))
            }
          }
          await sameLogs(w, "s1")
          await sameLogs(w, "s2")
        },
      ),
      { numRuns: 40 },
    ))
})

describe("inbox and tasks through sessions", () => {
  test("an inbox gets comments on URLs it holds, questions to its agent or its URLs, and hand-offs", async () => {
    const w = world()
    await w.session("s1", coordinatedClaim(w, "s1", "karl", "codex", "erp.se/p"))
    await w.workspace(Workspace.comment({ actor: person("karl"), session: null, member: null, trajectory: null, intent: null, now: tick() }, { key: "erp.se/p", ref: null, text: "Check freight", version: null }))
    await w.session("s2", Session.record(w.who("s2", "karl", "claude"), { kind: "ask", to: "erp.se/p", keys: ["erp.se/p" as never], text: "How long?" }))
    await w.session("s3", Session.record(w.who("s3", "anna", "claude"), { kind: "handoff", to: "karl/codex", text: "Draft order" }))
    await w.session("s2", Session.record(w.who("s2", "karl", "claude"), { kind: "ask", to: "anna/claude", text: "not for codex" }))
    for (const s of ["s2", "s3"]) await w.session(s, Session.flush)
    const me = { session: "s1", address: "karl/codex", handle: "karl" }
    expect((await w.workspace(Workspace.inbox(me, true))).items.map((e) => e.kind)).toEqual(["comment", "ask", "handoff"])
    expect((await w.workspace(Workspace.inbox(me, true))).items).toEqual([])
  })

  test("a comment on a trajectory reaches its session, and only that one", async () => {
    const w = world()
    const browser = { actor: person("anna"), session: null, member: null, trajectory: null, intent: null, now: tick() }
    await w.workspace(Workspace.comment(browser, { key: null, ref: null, text: "Use the EU list", version: null, to: "s1" }))
    expect((await w.workspace(Workspace.inbox({ session: "s1", address: "karl/codex", handle: "karl" }, true))).items.map((e) => e.text)).toEqual(["Use the EU list"])
    expect((await w.workspace(Workspace.inbox({ session: "s2", address: "karl/claude", handle: "karl" }, true))).items).toEqual([])
  })

  test("one taker per task", async () => {
    const w = world()
    await w.session("s1", Session.record(w.who("s1", "karl", "codex"), { kind: "task.add", text: "Check freight" }))
    await w.session("s1", Session.flush)
    const take = (s: string, handle: string, agent: string) => {
      const who = w.who(s, handle, agent)
      return w.sessionExit(s, Session.coordinate(who, "task.take", [], w.inWorkspace(Workspace.takeTask({ ...caller(handle, agent, s), now: who.now }, "Check freight"))))
    }
    expect((await take("s2", "karl", "claude"))._tag).toBe("Success")
    expect((await take("s3", "anna", "claude"))._tag).toBe("Failure")
  })

  test("a task is done when named by id or by title", async () => {
    const w = world()
    const who = w.who("s1", "karl", "codex")
    for (const text of ["Check freight", "Call Anna", "1"]) await w.session("s1", Session.record(who, { kind: "task.add", text }))
    await w.session("s1", Session.record(who, { kind: "task.done", text: "2" }))
    await w.session("s1", Session.record(who, { kind: "task.done", text: "Check freight" }))
    await w.session("s1", Session.flush)
    const status = Object.fromEntries((await w.workspace(Workspace.tasks())).map((t) => [t.title, t.status]))
    expect(status).toEqual({ "Check freight": "done", "Call Anna": "done", "1": "open" })
  })
})

describe("the default base", () => {
  test("is the last version written, or read while it was the latest; an older read never is", () =>
    fc.assert(
      fc.property(
        fc.array(fc.record({ kind: fc.constantFrom("read", "older", "write", "other"), key: fc.constantFrom("a", "b"), version: fc.integer({ min: 1, max: 20 }) }), { maxLength: 30 }),
        (steps) => {
          const events = steps.map(
            (s, i) =>
              ({
                kind: s.kind === "older" ? "read" : s.kind === "other" ? "note" : s.kind,
                keys: [s.key],
                version: s.version,
                data: s.kind === "older" ? { older: true } : null,
                aseq: i + 1,
              }) as never,
          )
          for (const key of ["a", "b"]) {
            const model = steps.filter((s) => s.key === key && (s.kind === "read" || s.kind === "write")).at(-1)?.version
            expect(Session.defaultBase(events, key)).toBe(model)
          }
        },
      ),
      { numRuns: 200 },
    ))
})
