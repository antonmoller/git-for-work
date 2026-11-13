export * as Fields from "./fields.ts"

/** A CSV's header row, as a field. */
export const HEADER = "#header"

/**
 * The fields of a piece of content, so revert and blame can work per field. A JSON object's top-level keys are its
 * fields; a CSV's rows are fields named by their first column; anything else is one field, `content`.
 * Values are canonical strings so equal values compare equal.
 */
export function parse(content: string): Record<string, string> {
  const trimmed = content.trim()
  if (trimmed.startsWith("{")) {
    try {
      const value = JSON.parse(trimmed)
      if (value && typeof value === "object" && !Array.isArray(value))
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, canonical(v)]))
    } catch {
      // not JSON: fall through
    }
  }
  const lines = trimmed.split(/\r?\n/).filter((l) => l.length > 0)
  if (lines.length >= 2 && lines.every((l) => l.includes(","))) {
    const header = lines[0]
    const rows = lines.slice(1)
    const ids = rows.map((r) => r.split(",")[0].trim())
    if (new Set(ids).size === ids.length && ids.every((id) => id.length > 0))
      return Object.fromEntries([[HEADER, header], ...rows.map((r, i) => [ids[i], r] as const)])
  }
  return { content }
}

/** The fields whose values differ, including added and removed ones. Sorted. */
export function changed(before: Record<string, string>, after: Record<string, string>) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((k) => before[k] !== after[k])
    .sort()
}

/** Puts `values` (null removes) onto content's fields and renders it in the same shape. */
export function apply(content: string | null, values: Record<string, string | null>) {
  const base = content === null ? {} : parse(content)
  const next = { ...base }
  for (const [k, v] of Object.entries(values)) {
    if (v === null) delete next[k]
    else next[k] = v
  }
  return render(content, next)
}

function render(original: string | null, fields: Record<string, string>) {
  const trimmed = original?.trim() ?? ""
  if (trimmed.startsWith("{") || original === null && !("content" in fields))
    return JSON.stringify(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, JSON.parse(v)])), null, 2)
  if (HEADER in fields) return [fields[HEADER], ...Object.entries(fields).filter(([k]) => k !== HEADER).map(([, v]) => v)].join("\n") + "\n"
  return fields.content ?? ""
}

function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === "object")
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]))
  return value
}

/** "2 rows" for CSV, "2 fields" otherwise. */
export function describe(content: string, changed: ReadonlyArray<string>) {
  const fields = parse(content)
  const count = changed.filter((f) => f !== HEADER).length
  if (HEADER in fields) return changed.includes(HEADER) && count === 0 ? "header" : `${count} ${count === 1 ? "row" : "rows"}`
  if ("content" in fields && Object.keys(fields).length === 1) return "content"
  return `${count} ${count === 1 ? "field" : "fields"}`
}
