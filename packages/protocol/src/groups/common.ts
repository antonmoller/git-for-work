import { Schema } from "effect"
import { Errors } from "@work/schema/errors"

export const ws = (path: string) => `/api/w/:workspace${path}` as const
export const params = { workspace: Schema.String }
export const common = [Errors.Invalid, Errors.NotFound] as const
export const UrlRef = Schema.Struct({ url: Schema.String, title: Schema.optional(Schema.NullOr(Schema.String)) })
