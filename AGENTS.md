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
- The workspace object is the only sequencer. Claims, writes, reverts, comments, tasks and messages go through it.
- Write the law first, then its property test (packages/core/test). Core runs on Bun SQLite in tests and on
  Durable Object SQLite in the Worker; keep it unaware of Cloudflare.
- Never put a secret in source, logs, fixtures or test output. Secrets are set with `bunx wrangler secret put`.
- Conventional commits (`feat(core): …`). Commit locally, never amend, never push without Anton's yes.
- Run evidence (test logs, e2e transcripts) goes in the ignored `.cache/`.
- `packages/core/src/database/drizzle` is copied from opencode (MIT); see its README before changing it.
