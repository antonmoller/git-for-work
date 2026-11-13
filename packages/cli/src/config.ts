export * as Config from "./config.ts"

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

/** Where the CLI keeps its files. `WORK_HOME` moves it, for tests and for people who want it elsewhere. */
export const home = () => process.env.WORK_HOME ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "work")

const file = (name: string) => join(home(), name)

const readJson = <A>(path: string, fallback: A): A => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as A
  } catch {
    return fallback
  }
}

const writeJson = (path: string, value: unknown, mode = 0o600) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode })
}

interface Settings {
  /** The Worker's URL, as `work login --url` set it. */
  url?: string
  /** Workspace per directory, as `work use` set it. The nearest ancestor wins. */
  dirs?: Record<string, string>
}

export const settings = () => readJson<Settings>(file("config.json"), {})
export const saveSettings = (next: Settings) => writeJson(file("config.json"), next, 0o644)

export const DEFAULT_URL = "http://localhost:8787"

/** The Worker to talk to: `--url`, `WORK_URL`, what `work login` saved, or local development. */
export const url = (flag?: string) => (flag ?? process.env.WORK_URL ?? settings().url ?? DEFAULT_URL).replace(/\/+$/, "")

/** The workspace for `dir`: `WORK_WORKSPACE`, or the nearest directory `work use` was run in. */
export const workspaceFor = (dir = process.cwd()) => {
  if (process.env.WORK_WORKSPACE) return process.env.WORK_WORKSPACE
  const dirs = settings().dirs ?? {}
  let d = resolve(dir)
  for (;;) {
    if (dirs[d]) return dirs[d]
    const parent = dirname(d)
    if (parent === d) return null
    d = parent
  }
}

export const useWorkspace = (slug: string, dir = process.cwd()) => {
  const s = settings()
  saveSettings({ ...s, dirs: { ...(s.dirs ?? {}), [resolve(dir)]: slug } })
}

/** Small per-session state: what this agent joined, its watch positions, when it last checked its inbox. */
export interface SessionState {
  joined?: { session: string; workspace: string; pid: number | null; at: number }
  watch?: Record<string, number>
  inboxCheckedAt?: number
}

const stateFile = (session: string) => file(join("sessions", `${session.replace(/[^A-Za-z0-9._-]/g, "_")}.json`))
export const state = (session: string) => readJson<SessionState>(stateFile(session), {})
export const saveState = (session: string, next: SessionState) => writeJson(stateFile(session), next)

export const credentialsFile = () => file("credentials.json")
export const readCredentialsFile = () => readJson<Record<string, string>>(credentialsFile(), {})
export const writeCredentialsFile = (value: Record<string, string>) => writeJson(credentialsFile(), value)

export const exists = existsSync
