export * as Target from "./target.ts"

import { existsSync, statSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"

const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" })
  return result.exitCode === 0 ? result.stdout.toString().trim() : null
}

/** `git@github.com:holm/pricing.git` and `https://github.com/holm/pricing` both become `github.com/holm/pricing`. */
export const remoteBase = (remote: string) =>
  remote
    .trim()
    .replace(/^[a-z+]+:\/\//, "")
    .replace(/^[^@/]+@/, "")
    .replace(/^([^/:]+):(?!\d)/, "$1/")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")

/** A file or folder inside a Git checkout, as the URL of the same path on its remote and branch. */
export function fromPath(path: string, cwd = process.cwd()) {
  const full = resolve(cwd, path)
  if (!existsSync(full)) return null
  const dir = statSync(full).isDirectory() ? full : dirname(full)
  const root = git(dir, "rev-parse", "--show-toplevel")
  if (!root) return null
  const remote = git(root, "remote", "get-url", "origin") ?? git(root, "remote", "get-url", git(root, "remote")?.split("\n")[0] ?? "origin")
  if (!remote) return null
  const branch = git(root, "rev-parse", "--abbrev-ref", "HEAD") ?? "main"
  const rel = relative(root, full).split("\\").join("/")
  const kind = statSync(full).isDirectory() ? "tree" : "blob"
  return `https://${remoteBase(remote)}/${kind}/${branch === "HEAD" ? (git(root, "rev-parse", "HEAD") ?? "main") : branch}${rel ? `/${rel}` : ""}`
}

/** Whether text names a URL rather than a local path: a scheme, or a host with a dot before the first slash. */
export const looksLikeUrl = (text: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?([/?#]|$)/i.test(text)

/**
 * What the agent named: a URL as written (the server normalizes it), or a path in a checkout as its remote URL.
 * `url@v7` splits off the version.
 */
export function resolveTarget(input: string, cwd = process.cwd()): { url: string; version: number | null; path: string | null } {
  const at = input.match(/^(.*)@v(\d+)$/)
  const raw = at ? at[1]! : input
  const version = at ? Number(at[2]) : null
  if (!looksLikeUrl(raw) || existsSync(resolve(cwd, raw))) {
    const fromGit = fromPath(raw, cwd)
    if (fromGit) return { url: fromGit, version, path: resolve(cwd, raw) }
    if (!looksLikeUrl(raw)) throw new Error(`${raw} is not a URL, and not a file in a Git checkout with a remote`)
  }
  return { url: /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`, version, path: null }
}
