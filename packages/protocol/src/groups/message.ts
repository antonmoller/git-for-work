import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Entry } from "@work/schema/entry"
import { Errors } from "@work/schema/errors"
import { Task } from "@work/schema/task"
import { common, params, ws } from "./common.ts"

/** Comments, questions, answers, hand-offs and tasks. From an agent they go to its session's log first. */
export const MessageGroup = HttpApiGroup.make("message")
  .add(
    HttpApiEndpoint.post("send", ws("/messages"), {
      params,
      payload: Schema.Struct({
        kind: Schema.Literals(["comment", "ask", "tell", "handoff"]),
        text: Schema.String,
        to: Schema.optional(Schema.String),
        url: Schema.optional(Schema.String),
        ref: Schema.optional(Schema.Int),
        version: Schema.optional(Schema.Int),
      }),
      success: Entry.Event,
      error: [...common],
    }),
  )
  .add(HttpApiEndpoint.post("addTask", ws("/tasks"), { params, payload: Schema.Struct({ title: Schema.String }), success: Entry.Event, error: [...common] }))
  .add(
    HttpApiEndpoint.post("takeTask", ws("/tasks/take"), {
      params,
      payload: Schema.Struct({ task: Schema.String }),
      success: Task.Info,
      error: [...common, Errors.TaskTaken],
    }),
  )
  .add(HttpApiEndpoint.post("doneTask", ws("/tasks/done"), { params, payload: Schema.Struct({ task: Schema.String }), success: Entry.Event, error: [...common] }))
  .add(HttpApiEndpoint.get("tasks", ws("/tasks"), { params, success: Schema.Array(Task.Info), error: [...common] }))
