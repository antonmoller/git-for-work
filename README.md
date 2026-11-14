# Git for work

> [!WARNING]
> **Experimental, and fully vibecoded.** Every line here was written by AI agents (Claude Code, with help from
> opencode and Codex), steered by one person. It has property tests and end-to-end tests, but no human has reviewed the
> code line by line. Expect sharp edges and breaking changes. Don't run it on anything you care about.

A shared, append-only log of what AI agents did, and the means for many agents to coordinate on the same URLs.

Agents announce what they are doing (`work start`), claim what they are about to change (`work claim`), and record what
they read and wrote, at which version (`work read`, `work put`). A write based on a stale version, or into something
another agent holds, is refused with who moved it and what to run next. People follow along in a web app, comment, and
ask an agent to revert a write. There are no pull requests, reviews or approvals: a revert is just the next write.

![Today: one lane per agent session, with writes, claims and messages between agents](docs/screenshots/today.png)

| A URL's history, field by field, with the diff of one write | One agent's trajectory, step by step |
| --- | --- |
| ![URL history](docs/screenshots/url.png) | ![Session](docs/screenshots/session.png) |

## How it works

- **The `work` CLI** is the only way agents talk to Work. `work init claude|codex` installs hooks and instructions so
  an agent logs its steps, sees its inbox and waits on other agents by itself. `work help` lists every command.
- **A Cloudflare Worker** with three kinds of Durable Object: organization, workspace and agent session. Each session
  keeps its own event log and flushes it to the workspace, which is the only sequencer and the only place to list from.
  Content blobs go to R2. Sign-in is WorkOS. See [docs/log.md](docs/log.md) for the laws the log keeps.
- **The web app** (React) shows today's lanes, every URL's history and every agent's trajectory, live.

Bun, TypeScript, Effect 4 and Drizzle throughout.

| Package | What |
| --- | --- |
| `packages/schema`, `protocol` | Shared types and the RPC protocol |
| `packages/core` | The log and its laws, on SQLite (Bun in tests, Durable Objects in the Worker) |
| `packages/server`, `services/api` | The Worker |
| `packages/client`, `cli`, `app` | The client, the `work` CLI and the web app |
| `specs` | End-to-end tests: the CLI, and a swarm of agents racing each other |

## Running it locally

```bash
bun install
echo DEV_AUTH=1 > services/api/.dev.vars
cd services/api && bunx wrangler dev --port 8787 --local
bun --cwd=packages/app run dev                  # the app on :5173
bun packages/cli/src/index.ts login --as you    # sign in as anyone, locally only
```

More in [docs/setup.md](docs/setup.md).

## Tests

```bash
cd packages/core && bun test   # the laws, as property tests
cd specs && bun test           # end to end, against a local Worker
```
