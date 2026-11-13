import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { Effect } from "effect"
import { ContentFields } from "../src/content/fields.ts"
import { ContentHash } from "../src/content/hash.ts"
import { Workspace } from "../src/workspace/workspace.ts"
import { caller, runWorkspace } from "./harness.ts"

const keys = ["erp.se/prices", "erp.se/prices/a", "erp.se/prices/b", "erp.se/suppliers", "erp.se/suppliers/x", "doc.se/d#h=1", "doc.se/d"]
const put = (c: Workspace.Caller, key: string, base: number | null, fields: Record<string, string>) =>
  Workspace.write(c, { key, title: null, base, content: ContentHash.sha256(JSON.stringify(fields)), fields, why: null, revertOf: null, reads: [] })

describe("claims are all or none", () => {
  test("a claim either takes every key or changes nothing", () =>
    fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.constantFrom("s1", "s2", "s3"), fc.subarray(keys, { minLength: 1, maxLength: 3 })), { maxLength: 6 }),
        fc.subarray(keys, { minLength: 1, maxLength: 3 }),
        async (before, wanted) => {
          await runWorkspace(
            Effect.gen(function* () {
              for (const [s, ks] of before) yield* Workspace.claim(caller("a", "codex", s), ks.map((key) => ({ key, title: null })))
              const held = (yield* Workspace.today(0)).claims
              const result = yield* Workspace.claim(caller("b", "claude", "s9"), wanted.map((key) => ({ key, title: null })))
              const after = (yield* Workspace.today(0)).claims
              const clash = Workspace.conflicts(held, wanted, "s9")
              if (clash.length > 0) {
                expect(result._tag).toBe("Held")
                expect(after).toEqual(held)
              } else {
                expect(result._tag).toBe("Claimed")
                for (const k of wanted) expect(after.some((c) => c.key === k && c.session === "s9")).toBe(true)
              }
            }),
          )
        },
      ),
      { numRuns: 60 },
    ))

  test("a waiter gets the keys the moment they are released, in order", async () => {
    await runWorkspace(
      Effect.gen(function* () {
        const codex = caller("karl", "codex", "s1")
        yield* Workspace.claim(codex, [{ key: "erp.se/prices", title: "Prices" }])
        const waiting = yield* Workspace.claim(caller("karl", "claude", "s2"), [{ key: "erp.se/prices", title: null }], 20 * 60_000)
        expect(waiting._tag).toBe("Waiting")
        const later = yield* Workspace.claim(caller("anna", "claude", "s3"), [{ key: "erp.se/prices", title: null }], 20 * 60_000)
        expect(later._tag).toBe("Waiting")
        const released = yield* Workspace.release(caller("karl", "codex", "s1"))
        expect(released.granted.map((g) => g.session)).toEqual(["s2"])
        expect<string>((yield* Workspace.who("erp.se/prices")).holders[0].session).toBe("s2")
      }),
    )
  })

  test("quiet holders lose their claims and waits end at their deadline", async () => {
    await runWorkspace(
      Effect.gen(function* () {
        yield* Workspace.claim(caller("karl", "codex", "s1", 0), [{ key: "erp.se/a", title: null }])
        yield* Workspace.claim(caller("karl", "claude", "s2", 1000), [{ key: "erp.se/b", title: null }])
        const result = yield* Workspace.expire(Workspace.CLAIM_TTL + 500, caller("x", "y", "z").actor)
        expect(result.expired).toEqual(["erp.se/a"])
        expect(result.next).toBe(1000 + Workspace.CLAIM_TTL)
      }),
    )
  })
})

describe("writes state their base", () => {
  test("a write lands iff its base is the current version", () =>
    fc.assert(
      fc.asyncProperty(fc.array(fc.option(fc.integer({ min: 1, max: 6 }), { nil: null }), { minLength: 1, maxLength: 10 }), async (bases) => {
        await runWorkspace(
          Effect.gen(function* () {
            let current: number | null = null
            for (const [i, base] of bases.entries()) {
              const result = yield* Effect.result(put(caller("a", "codex", "s1"), "erp.se/p", base, { n: String(i) }))
              if (base === current) {
                expect(result._tag).toBe("Success")
                current = (current ?? 0) + 1
              } else expect(result._tag).toBe("Failure")
            }
            expect((yield* Workspace.who("erp.se/p")).version).toBe(current)
          }),
        )
      }),
      { numRuns: 60 },
    ))

  test("a write is refused while another session holds the URL or one above it", async () => {
    await runWorkspace(
      Effect.gen(function* () {
        yield* Workspace.claim(caller("karl", "codex", "s1"), [{ key: "erp.se/suppliers", title: null }])
        const result = yield* Effect.flip(put(caller("karl", "claude", "s2"), "erp.se/suppliers/x", null, { a: "1" }))
        expect(result._tag).toBe("KeyHeld")
      }),
    )
  })

  test("the stale-write refusal names who moved it", async () => {
    await runWorkspace(
      Effect.gen(function* () {
        yield* put(caller("karl", "codex", "s1"), "erp.se/p", null, { a: "1" })
        yield* put(caller("karl", "codex", "s1"), "erp.se/p", 1, { a: "2" })
        const error = yield* Effect.flip(put(caller("karl", "claude", "s2"), "erp.se/p", 1, { a: "3" }))
        expect(error._tag).toBe("StaleBase")
        if (error._tag === "StaleBase") expect([error.current, error.by.agent]).toEqual([2, "codex"])
      }),
    )
  })
})

describe("revert", () => {
  const fieldMap = fc.dictionary(fc.constantFrom("terms", "discount", "bank", "contact"), fc.constantFrom("1", "2", "3"), { minKeys: 1 })
  test("is refused exactly when a later write changed one of the same fields", () =>
    fc.assert(
      fc.asyncProperty(fc.array(fieldMap, { minLength: 2, maxLength: 6 }), fc.nat(), async (writes, pick) => {
        await runWorkspace(
          Effect.gen(function* () {
            const c = caller("lea", "claude", "s1")
            const states: Array<Record<string, string>> = [{}]
            for (const [i, f] of writes.entries()) {
              const next = { ...states[i], ...f }
              states.push(next)
              yield* put(c, "erp.se/sup", i === 0 ? null : i, next)
            }
            const v = (pick % writes.length) + 1
            const changed = ContentFields.changed(states[v - 1], states[v])
            const laterTouches = states.slice(v + 1).some((s, j) => ContentFields.changed(states[v + j], s).some((f) => changed.includes(f)))
            const result = yield* Effect.result(Workspace.revert(c, "erp.se/sup", v))
            if (laterTouches) expect(result._tag).toBe("Failure")
            else {
              expect(result._tag).toBe("Success")
              if (result._tag === "Success")
                expect(result.success.values).toEqual(Object.fromEntries(changed.map((f) => [f, states[v - 1][f] ?? null])))
            }
          }),
        )
      }),
      { numRuns: 60 },
    ))
})

