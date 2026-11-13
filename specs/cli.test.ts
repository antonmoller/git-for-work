/**
 * End to end through the `work` CLI against a running server (local dev by default, WORK_URL otherwise). Each person
 * has their own WORK_HOME, so their sign-ins and session state are apart, as on separate machines. The transcript of
 * every command goes to .cache/cli-e2e-<workspace>.log.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const baseUrl = process.env.WORK_URL ?? "http://localhost:8787"
const config = await fetch(`${baseUrl}/api/config`)
  .then((r) => (r.ok ? (r.json() as Promise<{ devAuth: boolean }>) : null))
  .catch(() => null)
// Signing in as anyone needs a local server with DEV_AUTH; elsewhere this suite needs real sign-ins.
const runnable = !!config?.devAuth

const CLI = resolve(import.meta.dir, "../packages/cli/src/index.ts")
const ws = `cli-${Date.now().toString(36)}`
const root = resolve(import.meta.dir, "../.cache/cli-e2e", ws)
const transcript: string[] = []

interface Who {
  readonly name: string
  readonly env: Record<string, string>
}

/** The environment of a fresh terminal: nothing from whatever runs these tests. */
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("WORK_") && k !== "CLAUDE_ENV_FILE")) as Record<string, string>

const person = (handle: string) => {
  const home = join(root, "homes", handle)
  mkdirSync(home, { recursive: true })
  return { handle, home, env: { WORK_HOME: home, WORK_URL: baseUrl, WORK_NO_BROWSER: "1" } }
}
const as = (p: ReturnType<typeof person>, agent: string, session: string, extra: Record<string, string> = {}): Who => ({
  name: `${p.handle}/${agent}`,
  env: { ...p.env, WORK_WORKSPACE: ws, WORK_AGENT: agent, WORK_SESSION: session, ...extra },
})

interface Run {
  readonly out: string
  readonly err: string
  readonly code: number
  readonly text: string
}

async function work(who: Who, args: string[], options: { stdin?: string; cwd?: string; env?: Record<string, string> } = {}): Promise<Run> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: { ...cleanEnv(), ...who.env, ...options.env },
    cwd: options.cwd ?? root,
    stdin: options.stdin !== undefined ? new Blob([options.stdin]) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  transcript.push(`$ [${who.name}] work ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}${options.stdin ? ` <<< ${JSON.stringify(options.stdin)}` : ""}\n${out}${err}(exit ${code})\n`)
  return { out, err, code, text: out + err }
}

/** Retries until the check passes: some things land a moment later (a session's log is flushed to the workspace). */
async function eventually<A>(f: () => Promise<A>, check: (a: A) => boolean, ms = 10_000): Promise<A> {
  const until = Date.now() + ms
  for (;;) {
    const a = await f()
    if (check(a) || Date.now() > until) return a
    await Bun.sleep(250)
  }
}

const karl = person("karl")
const anna = person("anna")
const lea = person("lea")
const K = as(karl, "claude", `karl-claude-${ws}`)
const A = as(anna, "codex", `anna-codex-${ws}`)
const L = as(lea, "claude", `lea-claude-${ws}`)
const host = `docs.example.com/${ws}`

afterAll(() => {
  mkdirSync(resolve(import.meta.dir, "../.cache"), { recursive: true })
  writeFileSync(resolve(import.meta.dir, `../.cache/cli-e2e-${ws}.log`), transcript.join("\n"))
})

describe.skipIf(!runnable)("the work CLI", () => {
  test("people sign in and choose a workspace", async () => {
    for (const [p, name] of [
      [karl, "Karl Holm"],
      [anna, "Anna Berg"],
      [lea, "Lea Nyström"],
    ] as const) {
      const r = await work({ name: p.handle, env: p.env }, ["login", "--as", p.handle, "--name", name])
      expect(r.code).toBe(0)
      expect(r.out).toContain("Signed in.")
    }
    const created = await work({ name: "karl", env: karl.env }, ["use", ws, "--create"])
    expect(created.code).toBe(0)
    expect(created.err).toContain(`Created ${ws}`)
    const me = await work({ name: "karl", env: { ...karl.env, WORK_AGENT: "claude", WORK_SESSION: K.env.WORK_SESSION! } }, ["whoami"])
    expect(me.out).toContain(`Workspace: ${ws}.`)
    expect(me.out).toContain(`Agent karl/claude, session ${K.env.WORK_SESSION}.`)
    const unsigned = await work({ name: "nobody", env: person("nobody").env }, ["whoami"])
    expect(unsigned.code).toBe(3)
  })

  test("two agents: one claims, the other is refused, asks, waits, writes on a stale base and redoes it", async () => {
    const url = `https://${host}/prices.json`
    expect((await work(K, ["start", "Raise bearing prices"])).code).toBe(0)
    expect((await work(K, ["claim", url])).out).toContain(`Claimed ${host}/prices.json`)
    expect((await work(K, ["put", url, "--base", "new", "--from", "-", "--why", "Q4 list"], { stdin: '{"bearing":10,"bolt":2}' })).out).toContain("Wrote v1")

    expect((await work(A, ["start", "Fix the bolt price"])).code).toBe(0)
    const held = await work(A, ["claim", url])
    expect(held.code).toBe(1)
    expect(held.err).toContain("Held by karl/claude")
    expect(held.err).toContain('for "Raise bearing prices"')

    expect((await work(A, ["ask", url, "When will you be done with the prices?"])).code).toBe(0)
    const asked = await work(K, ["inbox"])
    expect(asked.out).toContain("anna/codex asks")
    expect(asked.out).toContain("When will you be done with the prices?")
    expect((await work(K, ["inbox"])).out).toContain("Nothing new.")

    expect((await work(A, ["read", url])).err).toContain("v1")
    const waiting = work(A, ["claim", url, "--wait", "30s"])
    const queued = await eventually(
      () => work(K, ["who", url]),
      (r) => r.out.includes("anna/codex waits"),
    )
    expect(queued.out).toContain("anna/codex waits")

    expect((await work(K, ["put", url, "--from", "-"], { stdin: '{"bearing":12,"bolt":2}' })).out).toContain("Wrote v2")
    expect((await work(K, ["done"])).out).toContain(`Released ${host}/prices.json`)
    const granted = await waiting
    expect(granted.code).toBe(0)
    expect(granted.out).toContain("Claimed after")

    const stale = await work(A, ["put", url, "--from", "-"], { stdin: '{"bearing":10,"bolt":3}' })
    expect(stale.code).toBe(1)
    expect(stale.err).toContain("is at v2")
    expect(stale.err).toContain("not v1")
    expect((await work(A, ["read", url])).out).toContain('"bearing":12')
    expect((await work(A, ["put", url, "--from", "-", "--why", "bolt was wrong"], { stdin: '{"bearing":12,"bolt":3}' })).out).toContain("Wrote v3")

    expect((await work(A, ["tell", "karl/claude", "Bolt fixed on top of your bearing change"])).code).toBe(0)
    expect((await work(K, ["inbox"])).out).toContain("Bolt fixed on top of your bearing change")

    const blame = await work(K, ["blame", url])
    expect(blame.out).toMatch(/bearing\s+v2\s.*karl\/claude/)
    expect(blame.out).toMatch(/bolt\s+v3\s.*anna\/codex/)
    const diff = await work(K, ["diff", url])
    expect(diff.out).toContain("v2 → v3: 1 change")
    expect(diff.out).toContain("- bolt: 2")
    expect(diff.out).toContain("+ bolt: 3")
    const log = await eventually(
      () => work(K, ["log", url]),
      (r) => r.out.includes("refused write: StaleBase"),
    )
    expect(log.out).toContain("claimed after waiting")
    expect(log.out).toContain("refused write: StaleBase")
    expect(log.out).toContain("wrote v3")
    expect((await work(A, ["done"])).code).toBe(0)
  })

  test("a third agent joins a session, presence shows it, and its steps land in that session", async () => {
    const session = A.env.WORK_SESSION!
    expect((await work(A, ["start", "Check the totals"])).code).toBe(0)
    const joined = await work(L, ["join", session])
    expect(joined.code).toBe(0)
    expect(joined.out).toContain(`Joined ${session}, anna/codex's session.`)
    expect(joined.out).toContain('"Check the totals"')

    const here = await eventually(
      () => work(K, ["here", session]),
      (r) => r.out.includes("lea/claude"),
    )
    expect(here.out).toContain("lea/claude")
    expect(here.out).toContain("anna")

    expect((await work(L, ["whoami"])).out).toContain(`session ${session} (joined; own ${L.env.WORK_SESSION})`)
    expect((await work(L, ["note", "Totals add up after the bolt fix"])).code).toBe(0)
    const log = await eventually(
      () => work(K, ["log", "--in", session]),
      (r) => r.out.includes("Totals add up") && r.out.includes("join"),
    )
    expect(log.out).toMatch(/lea\/claude\s+join/)
    expect(log.out).toMatch(/lea\/claude\s+note: Totals add up after the bolt fix/)

    expect((await work(L, ["leave"])).out).toContain(`Left ${session}.`)
    const gone = await eventually(
      () => work(K, ["here", session]),
      (r) => !r.out.includes("lea/claude"),
    )
    expect(gone.out).not.toContain("lea/claude")
    const left = await eventually(
      () => work(K, ["log", "--in", session]),
      (r) => /lea\/claude\s+leave/.test(r.out),
    )
    expect(left.out).toMatch(/lea\/claude\s+leave/)
    expect((await work(L, ["whoami"])).out).toContain(`session ${L.env.WORK_SESSION}.`)
    expect((await work(A, ["done"])).code).toBe(0)
  })

  test("a comment on a URL reaches the inbox of the agent holding it", async () => {
    const url = `${host}/suppliers.csv`
    expect((await work(K, ["start", "Update supplier terms"])).code).toBe(0)
    expect((await work(K, ["claim", url])).code).toBe(0)
    expect((await work(L, ["comment", url, "Lindqvist changed their payment terms"])).out).toContain("Commented.")
    const inbox = await work(K, ["inbox", "--peek"])
    expect(inbox.out).toContain(`lea/claude on ${url}: Lindqvist changed their payment terms`)
    // Peeking leaves it there; reading takes it.
    expect((await work(K, ["inbox"])).out).toContain("Lindqvist")
    expect((await work(K, ["inbox"])).out).toContain("Nothing new.")
    // Nobody else holds it, so it reaches nobody else.
    expect((await work(A, ["inbox"])).out).not.toContain("Lindqvist")
    expect((await work(K, ["done"])).code).toBe(0)
  })

  test("a revert round trip: a person asks in the browser, the agent reverts and logs it", async () => {
    const url = `${host}/terms.json`
    expect((await work(K, ["start", "Longer payment terms"])).code).toBe(0)
    expect((await work(K, ["claim", url])).code).toBe(0)
    expect((await work(K, ["put", url, "--base", "new", "--from", "-"], { stdin: '{"days":30,"currency":"EUR"}' })).out).toContain("Wrote v1")
    expect((await work(K, ["put", url, "--from", "-"], { stdin: '{"days":45,"currency":"EUR"}' })).out).toContain("Wrote v2")
    expect((await work(K, ["done"])).code).toBe(0)

    // The browser's Revert button, as Anna the person (no agent).
    const token = JSON.parse(JSON.parse(readFileSync(join(anna.home, "credentials.json"), "utf8"))[baseUrl]).access as string
    const response = await fetch(`${baseUrl}/api/w/${ws}/revert-requests`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ url: `https://${url}`, version: 2, to: "karl/claude" }),
    })
    expect(response.status).toBe(200)

    const inbox = await work(K, ["inbox"])
    expect(inbox.out).toContain(`Anna Berg, in the browser: revert v2 of ${url}. Do it with: work revert ${url}@v2`)

    expect((await work(K, ["start", "Revert the terms change Anna asked for"])).code).toBe(0)
    const file = join(root, "terms.v3.json")
    const plan = await work(K, ["revert", `${url}@v2`, "--out", file])
    expect(plan.code).toBe(0)
    expect(plan.out).toContain("Reverting days from v2")
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ days: 30, currency: "EUR" })
    // Anyone else trying to write now finds it claimed.
    expect((await work(A, ["put", url, "--base", "v2", "--from", file])).code).toBe(1)
    expect((await work(K, ["put", url, "--revert", "v2", "--from", file])).out).toContain("Wrote v3, reverting v2")
    expect(JSON.parse((await work(K, ["show", `${url}@v3`])).out)).toEqual({ days: 30, currency: "EUR" })
    const log = await work(K, ["log", url])
    expect(log.out).toContain("started reverting v2")
    expect(log.out).toContain("wrote v3, reverting v2")
    expect((await work(K, ["who", url])).out).toContain("Nobody holds it.")
    expect((await work(K, ["done"])).code).toBe(0)
  })

  const repo = join(root, "pricing")

  test("a path in a Git checkout stands for its URL on the remote", async () => {
    mkdirSync(repo, { recursive: true })
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: repo })
    Bun.spawnSync(["git", "remote", "add", "origin", "git@github.com:holm/pricing.git"], { cwd: repo })
    writeFileSync(join(repo, "prices.csv"), "sku,price\nB-12,12\nN-4,3\n")
    expect((await work(K, ["start", "Prices in the repo"], { cwd: repo })).code).toBe(0)
    expect((await work(K, ["claim", "prices.csv"], { cwd: repo })).out).toContain("Claimed github.com/holm/pricing/blob/main/prices.csv")
    expect((await work(K, ["put", "prices.csv", "--base", "new"], { cwd: repo })).out).toContain("Wrote v1 (2 rows)")
    expect((await work(K, ["show", "github.com/holm/pricing/blob/main/prices.csv@v1"])).out).toBe("sku,price\nB-12,12\nN-4,3\n")
    writeFileSync(join(repo, "prices.csv"), "sku,price\nB-12,13\nN-4,3\n")
    expect((await work(K, ["put", "prices.csv"], { cwd: repo })).out).toContain("Wrote v2")
    const diff = await work(K, ["diff", "prices.csv"], { cwd: repo })
    expect(diff.out).toContain("v1 → v2: 1 change")
    expect(diff.out).toContain("+ B-12:")
    expect((await work(K, ["done"], { cwd: repo })).out).toContain("Released github.com/holm/pricing/blob/main/prices.csv")
  })

  test("init claude sets up hooks once, and the hooks log tool calls without contents", async () => {
    const command = `bun ${CLI}`
    const first = await work(K, ["init", "claude", "--command", command], { cwd: repo })
    expect(first.out).toContain("Added hooks to .claude/settings.json")
    const settings = JSON.parse(readFileSync(join(repo, ".claude/settings.json"), "utf8")) as { hooks: Record<string, { hooks: { command: string }[] }[]> }
    expect(Object.keys(settings.hooks).sort()).toEqual(["PostToolUse", "SessionEnd", "SessionStart", "UserPromptSubmit"])
    expect(settings.hooks.PostToolUse![0]!.hooks[0]!.command).toBe(`${command} hook claude tool`)
    expect(readFileSync(join(repo, "CLAUDE.md"), "utf8")).toContain("<!-- work:start -->")
    const again = await work(K, ["init", "claude", "--command", command], { cwd: repo })
    expect(again.out).toContain("Hooks already in")
    expect(again.out).toContain("Work section already in")
    expect(readFileSync(join(repo, "CLAUDE.md"), "utf8").match(/work:start/g)!.length).toBe(1)

    // Hooks run as Claude Code runs them: no WORK_AGENT or WORK_SESSION yet, input on stdin.
    const id = crypto.randomUUID()
    const session = `claude-${id}`
    const claude: Who = { name: "karl/claude (hooks)", env: { ...karl.env, WORK_WORKSPACE: ws } }
    const envFile = join(root, "claude-env")
    const hook = (event: string, input: Record<string, unknown>) =>
      work(claude, ["hook", "claude", event], { cwd: repo, stdin: JSON.stringify({ session_id: id, cwd: repo, ...input }), env: { CLAUDE_ENV_FILE: envFile } })

    const start = await hook("session-start", { hook_event_name: "SessionStart", source: "startup" })
    expect(start.code).toBe(0)
    expect(JSON.parse(start.out).hookSpecificOutput.additionalContext).toContain(`this session is ${session} in workspace ${ws}`)
    expect(readFileSync(envFile, "utf8")).toContain(`export WORK_SESSION=${session}`)

    expect((await hook("tool", { tool_name: "Write", tool_input: { file_path: join(repo, "secret.txt"), content: "TOP SECRET VALUE" } })).code).toBe(0)
    expect((await hook("tool", { tool_name: "Bash", tool_input: { command: "ls -la\necho second line" } })).code).toBe(0)
    expect((await hook("tool", { tool_name: "Bash", tool_input: { command: "work note hello" } })).code).toBe(0)

    expect((await work(A, ["tell", "karl/claude", "Prices are approved"])).code).toBe(0)
    const prompt = await hook("prompt", { hook_event_name: "UserPromptSubmit", prompt: "go on" })
    expect(JSON.parse(prompt.out).hookSpecificOutput.additionalContext).toContain("anna/codex says: Prices are approved")

    const log = await eventually(
      () => work(K, ["log", "--in", session, "--json"]),
      (r) => r.out.includes("Bash: ls -la"),
    )
    // --json gives the log as the server does, newest first.
    const texts = (JSON.parse(log.out) as { seq: number; kind: string; text: string | null }[])
      .filter((e) => e.kind === "tool")
      .sort((a, b) => a.seq - b.seq)
      .map((e) => e.text)
    expect(texts).toEqual(["Write: secret.txt", "Bash: ls -la"])
    expect(log.out).not.toContain("TOP SECRET")
    expect(log.out).not.toContain("second line")

    expect((await hook("session-end", { hook_event_name: "SessionEnd", reason: "exit" })).code).toBe(0)
    // Whatever arrives, a hook never fails the agent.
    expect((await work(claude, ["hook", "claude", "tool"], { stdin: "not json" })).code).toBe(0)
  })

  test("init codex writes AGENTS.md and adds notify once", async () => {
    const codexHome = join(root, "codex-home")
    mkdirSync(codexHome, { recursive: true })
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5"\n\n[profiles.fast]\nmodel = "gpt-5-mini"\n')
    const first = await work(K, ["init", "codex", "--codex-home", codexHome, "--command", `bun ${CLI}`], { cwd: repo })
    expect(first.out).toContain("Added notify to")
    const toml = readFileSync(join(codexHome, "config.toml"), "utf8")
    expect(toml.startsWith(`notify = ["bun", "${CLI}", "hook", "codex", "notify"]\n`)).toBe(true)
    expect(toml).toContain("[profiles.fast]")
    expect(existsSync(join(repo, "AGENTS.md"))).toBe(true)
    expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toContain("Run `work inbox` when you start")
    expect((await work(K, ["init", "codex", "--codex-home", codexHome, "--command", `bun ${CLI}`], { cwd: repo })).out).toContain("notify already set")
  })
})
