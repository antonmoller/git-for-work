export * as KeyOverlap from "./overlap.ts"

/**
 * A claim covers its URL and everything under it. `a` covers `b` when `b` is `a`, or continues `a` at a boundary:
 * a path segment, the query or the fragment. `prices/bearings` does not cover `prices/bearings-2027`.
 */
export function covers(a: string, b: string) {
  if (a === b) return true
  if (!b.startsWith(a)) return false
  const next = b.charAt(a.length)
  // A key with a query or fragment is a part; only its own continuations sit under it.
  if (next === "/") return !a.includes("?") && !a.includes("#")
  if (next === "?") return !a.includes("?") && !a.includes("#")
  if (next === "#") return !a.includes("#")
  if (next === "&") return a.includes("?") && !a.includes("#")
  return false
}

/** Two claims clash when one covers the other. Symmetric. */
export const overlaps = (a: string, b: string) => covers(a, b) || covers(b, a)
