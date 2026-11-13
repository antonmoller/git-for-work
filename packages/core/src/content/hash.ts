export * as ContentHash from "./hash.ts"

import { createHash } from "node:crypto"

/** Lowercase hex SHA-256, synchronous so it can run inside a storage transaction. Bun and workerd (nodejs_compat). */
export const sha256 = (input: string | Uint8Array) => createHash("sha256").update(input).digest("hex")

/** Canonical JSON: keys sorted, undefined dropped, so the same value always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`
  return JSON.stringify(value) ?? "null"
}

export const GENESIS = "0".repeat(64)

/** The hash of an entry: the canonical JSON of every field but `hash` (so it covers `prev`). */
export const chain = (entry: Record<string, unknown>) =>
  sha256(canonicalJson(Object.fromEntries(Object.entries(entry).filter(([k]) => k !== "hash"))))

/** Checks a chain of entries in order. Returns the index of the first broken link, or -1. */
export function verify(entries: ReadonlyArray<Record<string, unknown> & { prev: string; hash: string }>) {
  return entries.findIndex((e, i) => e.prev !== (i === 0 ? GENESIS : entries[i - 1].hash) || chain(e) !== e.hash)
}
