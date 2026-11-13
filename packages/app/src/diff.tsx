import { lazy, Suspense, type ComponentProps } from "react"

// The diff renderer and its highlighter are large, so they load only when a diff is first shown.
const PierreChange = lazy(() => import("./pierre.tsx"))

/** What a write changed, as a diff. */
export function Change(props: ComponentProps<typeof PierreChange>) {
  return (
    <Suspense fallback={<div className="diff loading" />}>
      <PierreChange {...props} />
    </Suspense>
  )
}
