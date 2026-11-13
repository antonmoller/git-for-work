import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { KeyNormalize } from "../src/key/normalize.ts"
import { KeyOverlap } from "../src/key/overlap.ts"

const segment = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,8}$/).filter((s) => !["edit", "view", "preview", "show"].includes(s))
const host = fc.tuple(fc.stringMatching(/^[a-z][a-z0-9]{0,6}$/), fc.constantFrom("se", "com", "app")).map(([a, b]) => `${a}.${b}`)
const path = fc.array(segment, { maxLength: 4 })
const params = fc.uniqueArray(fc.tuple(fc.stringMatching(/^[a-z]{1,4}$/).filter((k) => k !== "ref" && k !== "si" && k !== "usp"), segment), { selector: ([k]) => k, maxLength: 3 })
const fragment = fc.option(fc.stringMatching(/^heading=h\.[a-z]{1,5}$/), { nil: undefined })
const url = fc.record({ host, path, params, fragment })
const render = (u: { host: string; path: string[]; params: [string, string][]; fragment?: string }, opts: { scheme?: string; upper?: boolean; www?: boolean; slash?: boolean; reverse?: boolean; utm?: boolean } = {}) => {
  const h = (opts.www ? "www." : "") + (opts.upper ? u.host.toUpperCase() : u.host)
  const ps = [...(opts.reverse ? [...u.params].reverse() : u.params), ...(opts.utm ? [["utm_source", "mail"] as [string, string]] : [])]
  const q = ps.length ? "?" + ps.map(([k, v]) => `${k}=${v}`).join("&") : ""
  return `${opts.scheme ?? ""}${h}/${u.path.join("/")}${opts.slash && u.path.length ? "/" : ""}${q}${u.fragment ? "#" + u.fragment : ""}`
}

describe("URL normalization", () => {
  test("is idempotent", () =>
    fc.assert(fc.property(url, (u) => {
      const k = KeyNormalize.normalize(render(u))
      expect<string>(KeyNormalize.normalize(k)).toBe(k)
    })))

  test("ignores scheme, host case, www, trailing slash, parameter order and tracking parameters", () =>
    fc.assert(fc.property(url, fc.record({ scheme: fc.constantFrom("", "http://", "https://", "HTTPS://"), upper: fc.boolean(), www: fc.boolean(), slash: fc.boolean(), reverse: fc.boolean(), utm: fc.boolean() }), (u, opts) => {
      expect<string>(KeyNormalize.normalize(render(u, opts))).toBe(KeyNormalize.normalize(render(u)))
    })))

  test("drops trailing views and keeps fragments that name a part", () => {
    expect<string>(KeyNormalize.normalize("https://docs.google.com/document/d/1Kp9/edit?usp=sharing#heading=h.supp")).toBe("docs.google.com/document/d/1Kp9#heading=h.supp")
    expect<string>(KeyNormalize.normalize("ERP.holm.se/suppliers/")).toBe("erp.holm.se/suppliers")
  })

  test("applies workspace rules", () => {
    expect<string>(KeyNormalize.normalize("erp.holm.se/p?id=1&sess=9", [{ host: "erp.holm.se", keepParams: ["id"] }])).toBe("erp.holm.se/p?id=1")
  })

  test("refuses what is not a URL", () => {
    expect(() => KeyNormalize.normalize("")).toThrow()
    expect(() => KeyNormalize.normalize("not a url")).toThrow()
  })
})

describe("claim overlap", () => {
  const key = url.map((u) => KeyNormalize.normalize(render(u)))
  test("is reflexive and symmetric", () =>
    fc.assert(fc.property(key, key, (a, b) => {
      expect(KeyOverlap.overlaps(a, a)).toBe(true)
      expect(KeyOverlap.overlaps(a, b)).toBe(KeyOverlap.overlaps(b, a))
    })))

  test("a URL covers everything under it", () =>
    fc.assert(fc.property(host, path, fc.array(segment, { minLength: 1, maxLength: 3 }), (h, p, more) => {
      const parent = KeyNormalize.normalize(`${h}/${p.join("/")}`)
      const child = KeyNormalize.normalize(`${h}/${[...p, ...more].join("/")}`)
      expect(KeyOverlap.covers(parent, child)).toBe(true)
      expect(KeyOverlap.covers(child, parent)).toBe(false)
    })))

  test("siblings sharing a string prefix do not clash", () => {
    expect(KeyOverlap.overlaps("erp.holm.se/prices/bearings", "erp.holm.se/prices/bearings-2027")).toBe(false)
    expect(KeyOverlap.overlaps("d.com/doc#heading=h.a", "d.com/doc#heading=h.b")).toBe(false)
    expect(KeyOverlap.overlaps("d.com/doc", "d.com/doc#heading=h.a")).toBe(true)
    expect(KeyOverlap.overlaps("erp.holm.se/suppliers", "erp.holm.se/suppliers/nordlager")).toBe(true)
  })
})
