# Git for work

A shared, append-only log of what AI agents did, and the means for many agents to coordinate on the same URLs.
No pull requests, review or approvals. Revert is a forward write an agent carries out in the app.

## Durable rules

- Bun and `bunx` only. TypeScript, Effect 4, Drizzle. No SDK: agents go through the `work` CLI.
- Dependencies point one way: schema → core and protocol → server. client depends only on schema and protocol;
  cli and app build on client. Never import core or server from client, cli or app.
- Drizzle tables use snake_case columns, one `*.sql.ts` per object kind (organization, workspace, session).
  After changing one: `KIND=<kind> bunx drizzle-kit generate --name <what>` in packages/core, then
  `bun run script/migrations.ts`. Never edit `migrations.gen.ts` by hand.
- The workspace object is the only sequencer and the only place to list from. Sessions keep their own event log and
  flush it there with opencode-style replay; see docs/log.md.
- Write the law first, then its property test (packages/core/test). Core runs on Bun SQLite in tests and on
  Durable Object SQLite in the Worker; keep it unaware of Cloudflare.
- Never put a secret in source, logs, fixtures or test output. Secrets are set with `bunx wrangler secret put`.
- Conventional commits (`feat(core): …`). Commit locally, never amend, never push without Anton's yes.
- Run evidence (test logs, e2e transcripts) goes in the ignored `.cache/`.
- `packages/core/src/database/drizzle` is copied from opencode (MIT); see its README before changing it.

<!-- work:start -->
## Work log

This project logs agent work with the `work` CLI, so people and other agents see what was done, by whom and why, and nobody overwrites anyone.

- Start each task with `work start "<what you are doing, for whom>"`; end it with `work done` or `work fail "<why>"`. Both release your claims.
- Before you change something others may change too (a file, a doc, a sheet, a record), claim it: `work claim <url or path>`. If it is held, ask the holder with `work ask <url> "<question>"`, or wait with `work claim <url> --wait 10m`.
- Say what you read with `work read <url>` and write with `work put <url> --from <file>` (a path in this checkout needs no --from). A refusal names who wrote since you read: read again, redo the change on top, then put. `work read <path> --out <path>` brings a checkout file up to date with Work.
- Check `work inbox` when you start and between steps (with Claude Code's hooks, new items appear in your context by themselves). Answer with `work tell <who> "<text>"`; `work note "<text>"` records a decision in your own words.
- Waiting on another agent? Run `work wait --for 30m` in the background: it ends when something reaches your inbox, so the answer wakes you instead of waiting for the person to prompt you.
- A revert request names its command: `work revert <url>@vN --put` puts the old values back and writes the next version.
- `work help` lists everything. Exit 1 is a refusal to act on, 2 a mistake in the command, 3 means sign in with `work login`.
<!-- work:end -->
