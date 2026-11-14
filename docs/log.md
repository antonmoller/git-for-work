# The log

As built. The model is opencode's event log (`packages/core/src/bus.ts`, `event/sql.ts` in anomalyco/opencode),
applied to two kinds of Durable Object. No SlateDB, no R2 log segments and no hash chain for now. R2 holds content
blobs only, at `ws/{workspaceId}/blobs/{sha256}`, put-if-absent.

## Events

One shape, `Entry.Event` (packages/schema/src/entry.ts). Every event belongs to an **aggregate**, an agent session or
`workspace`, and is numbered contiguously within it by `aseq`. The workspace also gives every event a `seq` in arrival
order across all aggregates.

## Where they live

- **Session object:** its own events in `event` (aseq, body), and `meta.flushed`, the highest aseq the workspace
  confirmed. Presence (WebSockets) also lives here and is not logged as state.
- **Workspace object:** `entry` holds every event from every session plus its own, with filter columns (session,
  trajectory, kind, keys, to, version). `sequence` holds each aggregate's latest aseq. The read tables (claims, waiters,
  URL versions and fields, tasks, trajectories, presence, inbox cursors) are updated in the same transaction as the
  event that changes them.

Listing anything (`work log`, Today, a URL's history, the web app) reads only the workspace object.

## Session events

`work start`, `note`, `read`, tool calls, `done`, ask/tell, comment, hand-off, task add and done: the session object
commits them and answers. Its alarm flushes them to the workspace in batches.

A flush is opencode's replay. For each event in aseq order:
- at or below the aggregate's latest aseq: it must be the stored event (same id) and is skipped. A different event is
  a defect.
- otherwise it must be exactly latest + 1, or the workspace answers `Gap { expected }` and the session resends from
  there.

So a retried flush, or one whose reply was lost, is harmless.

## Coordinated events

Claim, release, write with `--base`, revert, and taking a task are decided by the workspace. The session object holds
a lock on its log while it:
1. flushes everything unflushed, so the workspace has the session's earlier events first;
2. calls the workspace, which checks and appends the event as the session's next aseq, in one transaction with its
   read tables, and answers only after that commits;
3. pulls the session's events above its own latest back from the workspace.

A refusal (held, stale base, revert conflict) becomes the session's own `refused` event. If the session crashed
between 2 and 3, `repair` on its next start pulls what it missed.

Expiries, grants to waiters and comments from the browser are the workspace's own events (aggregate `workspace`).

## Laws, tested (packages/core/test)

- A flush is idempotent when its reply is lost.
- A coordinated action lands after the session's earlier events.
- After any mix of local events, coordinated actions and lost replies, a session's log equals the workspace log
  filtered to that session (property test).
- Claims are all or none; writes land iff their base is current; revert is refused exactly when a later write changed
  one of the same fields (property tests).
- A write never silently undoes another: the current content writes nothing, and an earlier version's content is
  refused unless it is a revert (property test).
- A write that names no base is on the last version the session wrote or read while it was the latest. Reading an
  older version, to look at history, never becomes the base (property test).

## Later

When a workspace nears the Durable Object's 10 GB, seal old entries into immutable R2 segments. Nothing depends on
that yet.
