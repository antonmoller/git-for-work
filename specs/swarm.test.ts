import { expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { swarm } from "./src/swarm.ts"

const baseUrl = process.env.WORK_URL ?? "http://localhost:8787"
const reachable = await fetch(`${baseUrl}/api/config`).then((r) => r.ok).catch(() => false)

test.skipIf(!reachable)(
  "many agents on one workspace keep every law",
  async () => {
    const report = await swarm({
      baseUrl,
      people: Number(process.env.SWARM_PEOPLE ?? 6),
      rounds: Number(process.env.SWARM_ROUNDS ?? 5),
      seed: Number(process.env.SWARM_SEED ?? 7),
      joiners: 3,
      tasks: 5,
      log: (line) => console.log(line),
    })
    mkdirSync(`${import.meta.dir}/../.cache`, { recursive: true })
    writeFileSync(`${import.meta.dir}/../.cache/swarm-${report.workspace}.json`, JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ ...report, latency: undefined }, null, 2))
    console.table(report.latency)
    expect(report.violations).toEqual([])
  },
  600_000,
)
