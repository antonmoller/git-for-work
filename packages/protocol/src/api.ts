import { HttpApi } from "effect/http-api"
import { AccountGroup } from "./groups/account.ts"
import { ClaimGroup } from "./groups/claim.ts"
import { LogGroup } from "./groups/log.ts"
import { MessageGroup } from "./groups/message.ts"
import { SessionGroup } from "./groups/session.ts"
import { WriteGroup } from "./groups/write.ts"
import { Authorization } from "./middleware.ts"

export const Api = HttpApi.make("work")
  .add(AccountGroup)
  .add(SessionGroup)
  .add(ClaimGroup)
  .add(WriteGroup)
  .add(MessageGroup)
  .add(LogGroup)
  .middleware(Authorization)

/** WebSocket paths, outside the HttpApi. `after` is a workspace seq to replay from. */
export const sockets = {
  watch: (workspace: string, after: number) => `/api/w/${workspace}/watch?after=${after}`,
  presence: (workspace: string, session: string) => `/api/w/${workspace}/sessions/${encodeURIComponent(session)}/socket`,
} as const
