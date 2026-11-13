export * as Auth from "./auth.ts"

import { Config } from "./config.ts"

/**
 * The person's tokens. In the OS keychain through Bun.secrets; in a 0600 file under WORK_HOME when the keychain is not
 * there or WORK_HOME is set (tests, CI). Never printed.
 */
interface Tokens {
  readonly access: string
  readonly refresh: string | null
}

const SERVICE = "work-cli"
const useFile = () => !!process.env.WORK_HOME || process.env.WORK_KEYCHAIN === "0"

async function load(url: string): Promise<Tokens | null> {
  try {
    const raw = useFile() ? (Config.readCredentialsFile()[url] ?? null) : await Bun.secrets.get({ service: SERVICE, name: url })
    return raw ? (JSON.parse(raw) as Tokens) : null
  } catch {
    const raw = Config.readCredentialsFile()[url]
    return raw ? (JSON.parse(raw) as Tokens) : null
  }
}

async function save(url: string, tokens: Tokens | null) {
  const value = tokens ? JSON.stringify(tokens) : null
  if (!useFile()) {
    try {
      if (value) await Bun.secrets.set({ service: SERVICE, name: url, value })
      else await Bun.secrets.delete({ service: SERVICE, name: url })
      return
    } catch {
      // No keychain on this machine: fall back to the file.
    }
  }
  const all = Config.readCredentialsFile()
  if (value) all[url] = value
  else delete all[url]
  Config.writeCredentialsFile(all)
}

export const logout = (url: string) => save(url, null)

interface ServerConfig {
  readonly clientId: string
  readonly stage: string
  readonly publicUrl: string
  readonly devAuth: boolean
}

export async function serverConfig(url: string): Promise<ServerConfig> {
  const response = await fetch(`${url}/api/config`).catch((error) => {
    throw new Error(`Cannot reach ${url}: ${(error as Error).message}`)
  })
  if (!response.ok) throw new Error(`${url} answered ${response.status}; is it a Work server?`)
  return (await response.json()) as ServerConfig
}

const expiresAt = (jwt: string) => {
  try {
    const payload = JSON.parse(atob(jwt.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")))
    return typeof payload.exp === "number" ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

const WORKOS = "https://api.workos.com/user_management"

async function authenticate(body: Record<string, string>) {
  const response = await fetch(`${WORKOS}/authenticate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  const json = (await response.json().catch(() => ({}))) as Record<string, string>
  return { ok: response.ok, json }
}

/** A valid access token, refreshed when it is about to expire. Null when the person is not signed in. */
export async function token(url: string): Promise<string | null> {
  const tokens = await load(url)
  if (!tokens) return null
  // Local dev tokens never expire and are never refreshed.
  if (tokens.access.startsWith("dev.")) return tokens.access
  const exp = expiresAt(tokens.access)
  if (exp === null || exp - Date.now() > 60_000 || !tokens.refresh) return tokens.access
  const config = await serverConfig(url)
  const result = await authenticate({ grant_type: "refresh_token", client_id: config.clientId, refresh_token: tokens.refresh })
  if (!result.ok || !result.json.access_token) return null
  await save(url, { access: result.json.access_token, refresh: result.json.refresh_token ?? tokens.refresh })
  return result.json.access_token
}

/** Local development: sign in as anyone. The server only allows it on localhost with DEV_AUTH set. */
export async function loginDev(url: string, handle: string, name?: string) {
  const config = await serverConfig(url)
  if (!config.devAuth) throw new Error(`${url} does not allow local sign-in; run \`work login\` without --as`)
  const query = new URLSearchParams({ as: handle, format: "token", ...(name ? { name } : {}) })
  const response = await fetch(`${url}/auth/dev?${query}`)
  if (!response.ok) throw new Error(`Local sign-in refused: ${response.status}`)
  const { token } = (await response.json()) as { token: string }
  await save(url, { access: token, refresh: null })
}

/**
 * WorkOS CLI Auth (device authorization): show a code, the person approves it in the browser, the CLI polls until it
 * gets tokens.
 */
export async function loginDevice(url: string, say: (line: string) => void, open: (link: string) => void) {
  const config = await serverConfig(url)
  const start = await fetch(`${WORKOS}/authorize/device`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_id: config.clientId }) })
  const device = (await start.json().catch(() => ({}))) as {
    device_code?: string
    user_code?: string
    verification_uri?: string
    verification_uri_complete?: string
    interval?: number
    expires_in?: number
    message?: string
  }
  if (!start.ok || !device.device_code) throw new Error(`WorkOS refused to start the sign-in: ${device.message ?? start.status}. Is CLI Auth turned on for this client?`)
  say(`Your code: ${device.user_code}`)
  say(`Approve it at ${device.verification_uri_complete ?? device.verification_uri}`)
  open(device.verification_uri_complete ?? device.verification_uri!)
  let interval = (device.interval ?? 5) * 1000
  const deadline = Date.now() + (device.expires_in ?? 300) * 1000
  while (Date.now() < deadline) {
    await Bun.sleep(interval)
    const result = await authenticate({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: device.device_code, client_id: config.clientId })
    if (result.ok && result.json.access_token) {
      await save(url, { access: result.json.access_token, refresh: result.json.refresh_token ?? null })
      return
    }
    const error = result.json.error ?? result.json.code
    if (error === "authorization_pending") continue
    if (error === "slow_down") {
      interval += 5000
      continue
    }
    if (error === "organization_selection_required") throw new Error("You belong to more than one organization; choose one in the browser and sign in again")
    throw new Error(`Sign-in ended: ${result.json.error_description ?? error ?? "unknown error"}`)
  }
  throw new Error("The code expired; run `work login` again")
}
