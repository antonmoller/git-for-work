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

The client ID goes in `services/api/wrangler.jsonc` under the stage's `vars`. In the WorkOS dashboard:

1. **Redirects**: add `https://work-api-dev.anton-j-moller.workers.dev/auth/callback` as a redirect URI (the default),
   and `https://work-api-dev.anton-j-moller.workers.dev/` as the sign-out redirect.
2. **Authentication → CLI Auth**: on. `work login` uses the device flow.
3. **Organizations**: create one and add each person as a member. A sign-in without an organization is refused; each
   WorkOS organization is one Work organization.
4. **Roles**: `admin` (creates workspaces), `member` (the default: works in them), `viewer` (reads and comments).
5. **JWT template** (optional): `{"email": "{{user.email}}", "name": "{{user.first_name}} {{user.last_name}}"}`. Without
   it the Worker looks people up with `WORKOS_API_KEY`.

## Signing in

- The app: open the stage URL and sign in with WorkOS.
- The CLI: `work login --url https://work-api-dev.anton-j-moller.workers.dev`. Tokens go in the keychain.
- End to end on the stage, as the person signed in on this machine (needs the admin role):

```bash
cd specs && WORK_URL=https://work-api-dev.anton-j-moller.workers.dev WORK_E2E_SIGNED_IN=1 bun test cli.test.ts
```
