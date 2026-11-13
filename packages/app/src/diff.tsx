import { MultiFileDiff } from "@pierre/diffs/react"

/**
 * What a write changed, as a diff. Text is diffed whole; a CSV's changed rows and other documents' changed fields are
 * diffed as lines, one per row or `field: value`, so a reader sees exactly what moved.
 */
export function Change({ k, changed, before, after }: { k: string; changed: ReadonlyArray<string>; before: Readonly<Record<string, string | null>>; after: Readonly<Record<string, string | null>> }) {
  const name = k.split("/").at(-1) || "content"
  const text = changed.length === 1 && changed[0] === "content"
  const csv = /\.csv$/i.test(name)
  const lines = (side: Readonly<Record<string, string | null>>) =>
    [...changed]
      .sort()
      .filter((f) => side[f] != null)
      .map((f) => (csv ? side[f]! : `${f}: ${side[f]}`))
      .join("\n") + "\n"
  const lang = text || csv ? {} : { lang: "yaml" as const }
  const oldFile = { name, contents: text ? (before.content ?? "") : lines(before), ...lang }
  const newFile = { name, contents: text ? (after.content ?? "") : lines(after), ...lang }
  return (
    <div className="diff">
      <MultiFileDiff
        oldFile={oldFile}
        newFile={newFile}
        disableWorkerPool
        options={{
          diffStyle: "unified",
          disableFileHeader: true,
          themeType: "system",
          overflow: "wrap",
          lineDiffType: "word",
          diffIndicators: "bars",
          hunkSeparators: "line-info-basic",
          disableLineNumbers: !text,
        }}
      />
    </div>
  )
}
