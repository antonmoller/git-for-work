export * as KeyNormalize from "./normalize.ts"

import type { Key } from "@work/schema/key"

/** Query parameters that never name a thing. */
const tracking = /^(utm_.+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|ref|ref_src|usp|si|igshid)$/i

/** Trailing path segments that are views of the same thing. */
const defaultViews = ["edit", "view", "preview", "show"]

const noiseFragments = new Set(["", "!", "top", "/"])

export class InvalidKey extends Error {
  readonly _tag = "InvalidKey"
}

/**
 * Makes a URL comparable. The result has no scheme, a lowercase host without `www.` and default port, no trailing
 * slash or view segment, no tracking parameters, the rest of the query sorted, and the fragment kept when it names a
 * part (a heading, a sheet range, a line).
 *
 * Laws (see test/key.test.ts): idempotent; independent of scheme, host case, parameter order and tracking
 * parameters; never contains `//` in its path.
 */
export function normalize(input: string, rules: ReadonlyArray<Key.Rule> = []): Key.Value {
  const raw = input.trim()
  if (!raw) throw new InvalidKey("A key cannot be empty")
  const url = parse(raw)
  const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "")
  if (!host || !/^[a-z0-9.-]+$/.test(host) || !host.includes(".") && host !== "localhost")
    throw new InvalidKey(`Not a URL: ${input}`)
  const rule = rules.find((r) => r.host === host || host.endsWith(`.${r.host}`))
  const views = new Set([...defaultViews, ...(rule?.views ?? [])])
  const segments = url.pathname
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => encodeSegment(s))
  while (segments.length > 0 && views.has(segments[segments.length - 1].toLowerCase())) segments.pop()
  const params = [...url.searchParams.entries()]
    .filter(([k]) => !tracking.test(k))
    .filter(([k]) => !(rule?.dropParams ?? []).includes(k))
    .filter(([k]) => (rule?.keepParams ? rule.keepParams.includes(k) : true))
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1))
  const query = params.length ? "?" + new URLSearchParams(params).toString() : ""
  const fragment = decodeSafe(url.hash.replace(/^#/, ""))
  const keepFragment = !rule?.dropFragment && !noiseFragments.has(fragment)
  const port = url.port && !["80", "443"].includes(url.port) ? `:${url.port}` : ""
  return [host + port, ...segments].join("/") + query + (keepFragment ? `#${fragment}` : "") as Key.Value
}

function parse(raw: string) {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, "")}`
  try {
    return new URL(withScheme)
  } catch {
    throw new InvalidKey(`Not a URL: ${raw}`)
  }
}

function decodeSafe(s: string) {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** Decode, then encode only what must be encoded, so `%7E` and `~` are one spelling. */
function encodeSegment(segment: string) {
  return encodeURIComponent(decodeSafe(segment)).replace(/%(2[1-9A-C]|3[ABDF]|40|5[BD]|7E)/gi, (m) =>
    decodeURIComponent(m),
  ).replace(/[!'()*]/g, (c) => c)
}

/** The host of a key, for display. */
export const host = (key: string) => key.split(/[/?#]/)[0]
