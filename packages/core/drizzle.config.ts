import { defineConfig } from "drizzle-kit"

// One schema and one migrations folder per object kind: `KIND=workspace bunx drizzle-kit generate`.
const kind = process.env.KIND ?? "workspace"
export default defineConfig({
  dialect: "sqlite",
  schema: `./src/database/${kind}.sql.ts`,
  out: `./migrations/${kind}`,
})
