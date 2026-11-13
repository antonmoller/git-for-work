# Setup

## Local development

```bash
bun install
cd services/api && bunx wrangler dev --port 8787 --local   # DEV_AUTH=1 comes from .dev.vars (ignored)
bun --cwd=packages/app run dev                              # the app on :5173, proxying /api and /auth
bun packages/cli/src/index.ts login --as anton              # sign in as anyone, locally only
```

Tests: `bun test` in `packages/core` (laws), `specs/` (swarm and CLI end to end, against `WORK_URL` or local dev).

## The dev stage

On Cloudflare account `d80a2e659b001d3af37d9d28ec76f875`, at https://work-api-dev.anton-j-moller.workers.dev.

| Resource | Name |
| --- | --- |
| Worker, serving the app as assets | `work-api-dev` (workers.dev) |
| Durable Objects (SQLite) | `OrganizationObject`, `WorkspaceObject`, `SessionObject` |
| R2 bucket, EU jurisdiction | `work-blobs-dev` |
| Secret | `WORKOS_API_KEY` (set by Anton) |

Deploy:

```bash
bun --cwd=packages/app run build
cd services/api && bunx wrangler deploy --env dev
```

Secrets are set by a person, never in source: `bunx wrangler secret put WORKOS_API_KEY --env dev`.

## WorkOS (per environment)

The dev stage uses the Staging environment of "mimetic's Project" (client `client_01HKAAVJ8N2TTGAPKM9738E1SN`, the
default application, shared with mimetic's staging console). The client ID goes in `services/api/wrangler.jsonc` under
the stage's `vars`; the environment's API key is the `WORKOS_API_KEY` secret. In the WorkOS dashboard:

1. **Applications → the application → Redirects → Redirect URIs**: add
   `https://work-api-dev.anton-j-moller.workers.dev/auth/callback`. It need not be the default: the Worker names it on
   every sign-in.
2. **CLI Auth** needs no setting with hosted AuthKit; `work login` uses the device flow.
3. **Organizations**: one per Work organization (dev: "Tangent", `org_01M7BCPRRHX8JT9TARR93DANEK`). Add each person
   under the organization's **Users**. A sign-in without an organization is refused.
4. **Roles** (Authorization): `admin` creates workspaces, `member` (the default) works in them, `viewer` reads and
   comments. Set a person's role with the row's **Edit membership role**.
5. **JWT template** (optional): `{"email": "{{user.email}}", "name": "{{user.first_name}} {{user.last_name}}"}`. Without
   it the Worker looks people up with `WORKOS_API_KEY`.

## Signing in

- The app: open the stage URL and sign in with WorkOS.
- The CLI: `work login --url https://work-api-dev.anton-j-moller.workers.dev`. Tokens go in the keychain.
- End to end on the stage, as the person signed in on this machine (needs the admin role):

```bash
cd specs && WORK_URL=https://work-api-dev.anton-j-moller.workers.dev WORK_E2E_SIGNED_IN=1 bun test cli.test.ts
```
