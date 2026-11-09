import { z } from 'zod'
import { ApprovalPendingSchema, ApprovalRespondResponseSchema, BackgroundTasksResponseSchema, CancelResponseSchema, ClarifyPendingSchema, ClarifyRespondResponseSchema, GoalResponseSchema, PendingSteerSchema, ProfilesSchema, ProjectSchema, ProjectsSchema, SessionActivityPhaseSchema, SessionRowSchema, SteerSendNowResponseSchema, SteerWithdrawResponseSchema, WorkspacesSchema } from '../views.js'
import { CompressionSummarySchema, HandoffSummarySchema } from '../routes/sessions.js'
import { WorkspacesMutation } from '../routes/workspaces.js'
import { DecisionItemInputSchema, DecisionOutcomeStateSchema, DecisionProgressSchema, DecisionReviewSchema, DecisionReviewStatusSchema } from '../decisions.js'
import { ProposalKindSchema, ProposalSchema, ProposalStatusSchema } from '../proposals.js'
import { ShowBlockIdSchema, ShowKindSchema } from '../show.js'
import { DisplayMediaSchema } from '../display-media.js'
import { TerminalIdSchema, TerminalSliceSchema } from '../terminal.js'

/**
 * Sidecar-to-server requests (TAL-1164): the sidecar asks the server on the same stdio pipe, in the `server.*`
 * namespace, with `s:`-prefixed string ids that never collide with the server's integer request ids. The server
 * answers on the sidecar's stdin with the usual JSON-RPC result or error envelope.
 */
export const SidecarRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.string().regex(/^s:\d+$/),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
})
export type SidecarRequest = z.infer<typeof SidecarRequestSchema>

/**
 * The sidebar attention summary the server computes for every `/api/sessions` row: approvals outrank questions, and
 * both outrank the session's open decision reviews (TAL-1963, `count` open reviews).
 */
export const SessionAttentionSchema = z.object({
  kind: z.enum(['approval', 'clarify', 'decision']),
  count: z.number().int().positive(),
  severity: z.enum(['critical', 'question']),
})

/** `caller_session_id` is the Web session whose agent called the tool; the server resolves its profile and scopes to it. */
export const ServerSessionListParamsSchema = z.object({
  caller_session_id: z.string().min(1),
  query: z.string().nullable().optional(),
})

export const AGENT_SESSION_LIST_LIMIT = 50

export const ServerSessionListResultSchema = z.object({
  sessions: z.array(z.object({
    session_id: z.string(),
    title: z.string(),
    /** Seconds since the epoch of the row's latest activity, the order the list is in (newest first). */
    updated_at: z.number(),
    is_caller: z.boolean(),
    is_streaming: z.boolean(),
    pending_steer_count: z.number().int().nonnegative(),
    attention: SessionAttentionSchema.nullable(),
  })).max(AGENT_SESSION_LIST_LIMIT),
  /** More sessions matched than the list carries. */
  truncated: z.boolean(),
})

/**
 * TAL-1167: another session's queue of pending steers. `session_id` is the target, which must be in the caller's
 * profile, must not be the caller (its own queue drains only after its turn ends), and must be writable.
 */
export const ServerQueueListParamsSchema = z.object({
  caller_session_id: z.string().min(1),
  session_id: z.string().min(1),
})

/** The target's `pending_steers` exactly as its session detail ships them (TAL-424), oldest first. */
export const ServerQueueListResultSchema = z.object({
  session_id: z.string(),
  is_streaming: z.boolean(),
  pending_steers: z.array(PendingSteerSchema),
})

export const ServerQueueSteerParamsSchema = ServerQueueListParamsSchema.extend({ steer_id: z.string().min(1) })

/**
 * TAL-1165: the session tools. `session_new` makes a chat in the caller's profile, with that profile's default model and
 * workspace, and starts its first turn with `message`.
 */
export const ServerSessionNewParamsSchema = z.object({
  caller_session_id: z.string().min(1),
  message: z.string().min(1),
  title: z.string().nullable().optional(),
})

/** `stream_id` is the first turn's run; null when the message started none (a `[SILENT]` control message). */
export const ServerSessionNewResultSchema = z.object({
  session_id: z.string(),
  title: z.string(),
  stream_id: z.string().nullable(),
})

export const ServerSessionSendParamsSchema = ServerQueueListParamsSchema.extend({ message: z.string().min(1) })

/** `started`: an idle target began a turn (`stream_id`). `queued`: a running target got it as a pending steer (`steer_id`). */
export const ServerSessionSendResultSchema = z.object({
  outcome: z.enum(['started', 'queued']),
  stream_id: z.string().nullable(),
  steer_id: z.string().nullable(),
})

export const SESSION_WAIT_DEFAULT_S = 300
export const SESSION_WAIT_MAX_S = 600
export const SESSION_WAIT_MESSAGE_LIMIT = 4000

export const ServerSessionWaitParamsSchema = ServerQueueListParamsSchema.extend({
  timeout_s: z.number().int().positive().max(SESSION_WAIT_MAX_S).optional(),
})

/**
 * `ended`: the run that was going when the wait began finished. `not_running`: there was none. `timeout`: it was still
 * going after `timeout_s`. `cancelled`: the caller's own turn was stopped first. `run_state` is the target's activity
 * phase at that moment; `last_assistant_message` is its latest assistant reply, cut to 4,000 characters (`truncated`).
 */
export const ServerSessionWaitResultSchema = z.object({
  session_id: z.string(),
  outcome: z.enum(['ended', 'not_running', 'timeout', 'cancelled']),
  is_streaming: z.boolean(),
  run_state: SessionActivityPhaseSchema.nullable(),
  last_assistant_message: z.string().nullable(),
  truncated: z.boolean(),
})

/**
 * TAL-1166: session management. Each target must be in the caller's profile and may be the caller; each action honours
 * the target row's `can_*` flag (`read_only` for a title or project), refused with the server's reason.
 */
export const ServerSessionBranchParamsSchema = ServerQueueListParamsSchema.extend({ mode: z.enum(['branch', 'duplicate']) })

/** The new session, made as `/api/session/branch` (whole history) or `/api/session/duplicate` makes it. */
export const ServerSessionBranchResultSchema = z.object({ session_id: z.string(), title: z.string() })

/** Only the fields given are applied: `title` (rename), `project_id` (move; null or empty leaves the project), `pinned`, `archived`. */
export const ServerSessionUpdateParamsSchema = ServerQueueListParamsSchema.extend({
  title: z.string().min(1).optional(),
  project_id: z.string().nullable().optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
}).refine((p) => p.title !== undefined || p.project_id !== undefined || p.pinned !== undefined || p.archived !== undefined, 'give at least one of title, project_id, pinned, archived')

/** The target's row after the last change, as the routes return it. */
export const ServerSessionUpdateResultSchema = z.object({ session: SessionRowSchema })

/** `/api/session/compress`'s summary, without the session it returns (its whole transcript). */
export const ServerSessionCompressResultSchema = z.object({ session_id: z.string(), summary: CompressionSummarySchema })

/** A tool that takes no target: only the calling session, whose profile scopes the answer. */
export const ServerCallerParamsSchema = z.object({ caller_session_id: z.string().min(1) })

/**
 * TAL-1168: the approvals and clarify questions sessions in the caller's profile wait on. With `session_id`, that one
 * session (the caller included); without, every session the server holds a prompt for, native-owned ones it watches
 * included.
 */
export const ServerPendingListParamsSchema = z.object({
  caller_session_id: z.string().min(1),
  session_id: z.string().min(1).optional(),
})

const pendingEntry = <K extends 'approval' | 'clarify', P extends z.ZodType>(kind: K, prompt: P) => z.object({
  session_id: z.string(),
  kind: z.literal(kind),
  /** The prompt's `approval_id` or `clarify_id`, the id an answer names. */
  id: z.string(),
  /** How many prompts of this kind the session holds; answering this one shows the next. */
  pending_count: z.number().int().positive(),
  /** The oldest prompt of this kind, exactly as `/api/approval/pending` or `/api/clarify/pending` ships it. */
  prompt,
})

export const ServerPendingListResultSchema = z.object({
  pending: z.array(z.discriminatedUnion('kind', [pendingEntry('approval', ApprovalPendingSchema), pendingEntry('clarify', ClarifyPendingSchema)])),
})

/**
 * TAL-1168: answer another session's clarify question as `/api/clarify/respond` does. `answer` is the reply text; a
 * multi-question prompt takes `{"answers": {"q0": "…", "q1": ["…"]}}` as JSON. The caller's own question is the user's.
 * A target with more access than the caller (YOLO, a toolset it lacks, or a native owner's) is refused, as `session_send` refuses it.
 */
export const ServerClarifyRespondParamsSchema = ServerQueueListParamsSchema.extend({
  clarify_id: z.string().min(1),
  answer: z.string().min(1),
})

/**
 * TAL-1169: approve once or deny another session's pending command as `/api/approval/respond` does, only while the
 * profile's `talaria.agent_approvals` is on (else `agent_approvals_off`). `session`, `always` and YOLO are never accepted,
 * so an agent cannot widen another session's standing permissions. The caller's own approval is the user's
 * (`self_target`); an answered or expired one is `stale`; a target with more access than the caller is refused as
 * `session_send` refuses it (`exceeds_caller`). The answer is recorded on the target's tool row (`approval_answered_by`).
 */
export const ServerApprovalRespondParamsSchema = ServerQueueListParamsSchema.extend({
  approval_id: z.string().min(1),
  choice: z.enum(['once', 'deny']),
})

/**
 * TAL-1170: organise the containers sessions live in, in the caller's profile, through the services behind
 * `/api/projects{,/create,/rename}`, `/api/workspaces{,/add,/rename}` and `/api/profiles`, each answering as its route
 * does. No tool deletes a project or workspace, or switches or creates a profile.
 */
export const ServerProjectCreateParamsSchema = ServerCallerParamsSchema.extend({ name: z.string().min(1) })
export const ServerProjectRenameParamsSchema = ServerCallerParamsSchema.extend({ project_id: z.string().min(1), name: z.string().min(1) })
export const ServerProjectResultSchema = z.object({ ok: z.literal(true), project: ProjectSchema })
/** `name` defaults to the folder's name; the path passes the route's validation. */
export const ServerWorkspaceAddParamsSchema = ServerCallerParamsSchema.extend({ path: z.string().min(1), name: z.string().min(1).optional() })
/** A workspace is named by its `path`, as `workspace_list` gives it. */
export const ServerWorkspaceRenameParamsSchema = ServerCallerParamsSchema.extend({ path: z.string().min(1), name: z.string().min(1) })

/**
 * TAL-1170: a session's `/goal`, through the service behind `/api/goal`. `goal_get` runs `/goal status`; `goal_set` runs
 * `/goal <text>`, so a new goal starts the target's kickoff turn and `pause`, `resume` or `clear` control the standing one.
 * The target is in the caller's profile and may be the caller; a target with more access than the caller is refused
 * (`exceeds_caller`) for `goal_set`, as `session_send` refuses it.
 */
export const ServerGoalSetParamsSchema = ServerQueueListParamsSchema.extend({ text: z.string().min(1) })

/**
 * TAL-1963: the `harness` toolset's decision reviews, each of the calling session (another session's review is
 * `review_unknown`). `decision_review_put` creates a review, or revises the caller's `review_id`: a changed item keeps
 * its answer and needs review, a removed item's answer stays in the review's history. The server validates the items
 * against `DECISION_LIMITS` and refuses with the failed condition, writing nothing.
 */
export const ServerDecisionReviewPutParamsSchema = z.object({
  caller_session_id: z.string().min(1),
  title: z.string(),
  intro: z.string().nullable().optional(),
  items: z.array(DecisionItemInputSchema),
  review_id: z.string().min(1).optional(),
})
/** `url` is the review's page path; `title` and `progress` let the transcript card show the review before it loads. */
export const ServerDecisionReviewPutResultSchema = z.object({ review_id: z.string(), url: z.string(), title: z.string(), status: DecisionReviewStatusSchema, progress: DecisionProgressSchema })
export const ServerDecisionReviewReadParamsSchema = z.object({ caller_session_id: z.string().min(1), review_id: z.string().min(1) })
/** Every id must be an item of the review, or nothing is written (`unknown_item`); a review whose answered items all have an outcome is `applied` once submitted. */
export const ServerDecisionReviewRecordParamsSchema = ServerDecisionReviewReadParamsSchema.extend({
  outcomes: z.array(z.object({ id: z.string().min(1), state: DecisionOutcomeStateSchema, note: z.string().nullable().optional() })).min(1),
})

/**
 * TAL-1967: the `harness` toolset's proposals, each of the calling session (another session's is `proposal_unknown`).
 * `proposal_put` validates `payload` for its `kind` and refuses with the failed condition, writing nothing.
 * `timeout_seconds` is the session's clarify timeout as the sidecar resolved it; 0 or less never expires.
 */
export const ServerProposalPutParamsSchema = z.object({
  caller_session_id: z.string().min(1),
  kind: z.string(),
  payload: z.record(z.string(), z.unknown()),
  timeout_seconds: z.number().int().optional(),
})
/** `url` is the session's page, where the card is; `kind` and `summary` let the transcript card show before the proposal loads. */
export const ServerProposalPutResultSchema = z.object({ proposal_id: z.string(), status: ProposalStatusSchema, url: z.string(), kind: ProposalKindSchema, summary: z.string() })
export const ServerProposalReadParamsSchema = z.object({ caller_session_id: z.string().min(1), proposal_id: z.string().min(1) })

/**
 * TAL-1968: the `harness` toolset's `show`. The server validates `payload` for `kind` (`file {path, title?}`,
 * `table {title?, columns, rows}`, `chart {title, kind, series, unit?}`, `html {title, body}`) and refuses with the failed
 * condition, storing nothing. It collects no input.
 */
export const ServerShowPutParamsSchema = z.object({ caller_session_id: z.string().min(1), kind: z.string(), payload: z.record(z.string(), z.unknown()) })
/** `url` is the session's page, where the block shows; `note` tells the agent what the server cut (a table past its caps), else null. */
export const ServerShowPutResultSchema = z.object({ block_id: ShowBlockIdSchema, url: z.string(), kind: ShowKindSchema, title: z.string(), note: z.string().nullable() })

/**
 * TAL-1971: the `harness` toolset's `deliver`. The server stores a `file` show block for a file of the calling session's
 * workspace, recording its digest, and refuses `outside_workspace` (a path the `/api/file` rules put outside the
 * workspace, symlinks included), `is_directory`, `file_too_large` (over 200 MB) or `file_not_found`, storing nothing.
 */
export const ServerDeliverParamsSchema = z.object({ caller_session_id: z.string().min(1), path: z.string(), title: z.string().optional() })
/**
 * The block the transcript row renders, and the file as the user gets it: `media` is the detected media kind with its
 * inline URL, or kind `file` with its download URL; `url` is the session's page.
 */
export const ServerDeliverResultSchema = z.object({ block_id: ShowBlockIdSchema, url: z.string(), kind: z.literal('file'), title: z.string(), size: z.number().int().nonnegative(), media: DisplayMediaSchema })

/** TAL-1974: the most output lines one `terminal_read` returns, and its default. */
export const TERMINAL_READ_MAX_LINES = 400
/**
 * TAL-1974: the `harness` toolset's `terminal_open`. The server starts the Web host PTY of the calling session in its
 * workspace, as `/api/terminal/start` does, and types `command` once, followed by Enter. Only a session whose turns
 * have the `terminal` toolset may (`terminal_toolset_disabled`). One live terminal per session: a
 * running one is `limit_reached`. A command of more than 8192 characters is `command_too_long` and one with a control
 * character (a tab or a second line included) `invalid_command`, starting nothing.
 */
export const ServerTerminalOpenParamsSchema = z.object({ caller_session_id: z.string().min(1), command: z.string().optional(), title: z.string().optional() })
/** `url` is the session's page, where the user opens the terminal pane; `title` defaults to the command, else "Terminal". */
export const ServerTerminalOpenResultSchema = z.object({ terminal_id: TerminalIdSchema, url: z.string(), title: z.string(), command: z.string().nullable() })
/**
 * TAL-1974: the `harness` toolset's `terminal_read`, the output the terminal's SSE backlog keeps after `after_event_id`
 * (from the start without one), with escape sequences removed. A terminal of another session, a replaced one or one
 * retired after it closed is `terminal_not_found`.
 */
export const ServerTerminalReadParamsSchema = z.object({ caller_session_id: z.string().min(1), terminal_id: z.string().min(1), after_event_id: z.number().int().nonnegative().optional(), max_lines: z.number().int().positive().optional() })
/** At most `max_lines` lines (`TERMINAL_READ_MAX_LINES` by default and at most), as `TerminalSliceSchema` says. */
export const ServerTerminalReadResultSchema = TerminalSliceSchema

/** TAL-1972: the longest `report_issue` summary (the feedback title) and detail it sends; longer ones are refused, never cut. */
export const REPORT_ISSUE_LIMITS = { summary: 120, detail: 4000 } as const
/**
 * TAL-1972: the `harness` toolset's `report_issue`. The server files one feedback report through the service behind
 * `/api/feedback/submit`, marked `source: agent` with the calling session's id, the Agent version and its model, and the
 * redacted diagnostics `/api/feedback/diagnostics` previews when `include_diagnostics` is true. A blank summary or detail
 * is `invalid_params`, a longer one than `REPORT_ISSUE_LIMITS` `summary_too_long` or `detail_too_long`; a second report
 * with the same summary from the same session within an hour is `duplicate`. The route's refusals keep their name as the
 * condition: `rate_limited` (with `retry_after_seconds` in the error data), `feedback_unavailable`, `relay_unreachable`
 * and `invalid`.
 */
export const ServerReportIssueParamsSchema = z.object({ caller_session_id: z.string().min(1), summary: z.string(), detail: z.string(), include_diagnostics: z.boolean().optional() })
/** `report_id` is the Relay's receipt for the report. */
export const ServerReportIssueResultSchema = z.object({ report_id: z.string().min(1) })

/**
 * TAL-1969: the `harness` toolset's `request_secret`. The server refuses a malformed or reserved `env_name` before any
 * prompt; otherwise it queues an `agent_secret` vault prompt on the calling session and answers once the owner saves or
 * declines it or `timeout_seconds` passes (0 or less: no limit). A save writes the profile `.env`; the value is never in
 * the result. A refused write is an error with its reason, and nothing stays written.
 */
export const ServerSecretRequestParamsSchema = z.object({
  caller_session_id: z.string().min(1),
  env_name: z.string(),
  purpose: z.string(),
  optional: z.boolean().optional(),
  timeout_seconds: z.number().int().optional(),
})
export const ServerSecretRequestResultSchema = z.object({ env_name: z.string(), outcome: z.enum(['saved', 'declined', 'timed_out']), existed_before: z.boolean() })

/**
 * TAL-1970: the `harness` toolset's `notify`, an alert about the calling session on the user's devices. `info` (the
 * default) is muted while a Talaria tab is attached to the profile, as run alerts are; `attention` is not. A title over
 * 80 or a body over 300 characters is refused (`title_too_long`, `body_too_long`) before anything is sent.
 */
export const AgentNotifyLevelSchema = z.enum(['info', 'attention'])
export type AgentNotifyLevel = z.infer<typeof AgentNotifyLevelSchema>
export const ServerNotifyParamsSchema = z.object({ caller_session_id: z.string().min(1), title: z.string(), body: z.string(), level: AgentNotifyLevelSchema.optional() })
/**
 * `rate_limited` (more than 5 in 10 minutes, or a second `attention` within a minute) sends nothing and says when the next
 * call goes through. Otherwise `channels` maps each notification channel (`web-push`, `relay`) to `sent` (handed to its
 * subscribed devices), `muted` (a Talaria tab is open) or `unavailable` (no device of the session's owner subscribes, or
 * the session has no live or recently finished run to alert about). A child run's notice opens its parent chat (`url`).
 */
export const ServerNotifyResultSchema = z.object({
  status: z.enum(['sent', 'rate_limited']),
  notice_id: z.string().nullable(),
  level: AgentNotifyLevelSchema,
  url: z.string(),
  channels: z.record(z.string(), z.enum(['sent', 'muted', 'unavailable'])),
  retry_after_seconds: z.number().int().positive().nullable(),
})
export type ServerNotifyResult = z.infer<typeof ServerNotifyResultSchema>

/** Every method the server answers for the sidecar; anything else is METHOD_NOT_FOUND. */
export const SIDECAR_SERVER_METHODS = {
  'server.session_list': { params: ServerSessionListParamsSchema, result: ServerSessionListResultSchema },
  'server.queue_list': { params: ServerQueueListParamsSchema, result: ServerQueueListResultSchema },
  /** TAL-1167: `/api/chat/steer/send-now`'s answer for the target's steer. */
  'server.queue_send_now': { params: ServerQueueSteerParamsSchema, result: SteerSendNowResponseSchema },
  /** TAL-1167: `/api/chat/steer/withdraw`'s answer (reason `cancel`) for the target's steer. */
  'server.queue_withdraw': { params: ServerQueueSteerParamsSchema, result: SteerWithdrawResponseSchema },
  'server.session_new': { params: ServerSessionNewParamsSchema, result: ServerSessionNewResultSchema },
  'server.session_send': { params: ServerSessionSendParamsSchema, result: ServerSessionSendResultSchema },
  'server.session_wait': { params: ServerSessionWaitParamsSchema, result: ServerSessionWaitResultSchema },
  /** TAL-1165: `/api/chat/cancel`'s answer for the target's running turn. */
  'server.session_interrupt': { params: ServerQueueListParamsSchema, result: CancelResponseSchema },
  'server.session_branch': { params: ServerSessionBranchParamsSchema, result: ServerSessionBranchResultSchema },
  'server.session_update': { params: ServerSessionUpdateParamsSchema, result: ServerSessionUpdateResultSchema },
  /** TAL-1166: `/api/session/handoff-summary`'s answer for the target (no `since`). */
  'server.session_handoff': { params: ServerQueueListParamsSchema, result: HandoffSummarySchema },
  'server.session_compress': { params: ServerQueueListParamsSchema, result: ServerSessionCompressResultSchema },
  /** The caller's own background work, as `/api/background/tasks` answers for its session. */
  'server.background_list': { params: ServerCallerParamsSchema, result: BackgroundTasksResponseSchema },
  'server.pending_list': { params: ServerPendingListParamsSchema, result: ServerPendingListResultSchema },
  'server.clarify_respond': { params: ServerClarifyRespondParamsSchema, result: ClarifyRespondResponseSchema },
  'server.approval_respond': { params: ServerApprovalRespondParamsSchema, result: ApprovalRespondResponseSchema },
  'server.project_list': { params: ServerCallerParamsSchema, result: ProjectsSchema },
  'server.project_create': { params: ServerProjectCreateParamsSchema, result: ServerProjectResultSchema },
  'server.project_rename': { params: ServerProjectRenameParamsSchema, result: ServerProjectResultSchema },
  'server.workspace_list': { params: ServerCallerParamsSchema, result: WorkspacesSchema },
  'server.workspace_add': { params: ServerWorkspaceAddParamsSchema, result: WorkspacesMutation },
  'server.workspace_rename': { params: ServerWorkspaceRenameParamsSchema, result: WorkspacesMutation },
  'server.profile_list': { params: ServerCallerParamsSchema, result: ProfilesSchema },
  'server.goal_get': { params: ServerQueueListParamsSchema, result: GoalResponseSchema },
  'server.goal_set': { params: ServerGoalSetParamsSchema, result: GoalResponseSchema },
  'server.decision_review_put': { params: ServerDecisionReviewPutParamsSchema, result: ServerDecisionReviewPutResultSchema },
  'server.decision_review_read': { params: ServerDecisionReviewReadParamsSchema, result: DecisionReviewSchema },
  'server.decision_review_record': { params: ServerDecisionReviewRecordParamsSchema, result: DecisionReviewSchema },
  'server.proposal_put': { params: ServerProposalPutParamsSchema, result: ServerProposalPutResultSchema },
  'server.proposal_read': { params: ServerProposalReadParamsSchema, result: ProposalSchema },
  'server.show_put': { params: ServerShowPutParamsSchema, result: ServerShowPutResultSchema },
  'server.secret_request': { params: ServerSecretRequestParamsSchema, result: ServerSecretRequestResultSchema },
  'server.notify': { params: ServerNotifyParamsSchema, result: ServerNotifyResultSchema },
  'server.deliver': { params: ServerDeliverParamsSchema, result: ServerDeliverResultSchema },
  'server.terminal_open': { params: ServerTerminalOpenParamsSchema, result: ServerTerminalOpenResultSchema },
  'server.terminal_read': { params: ServerTerminalReadParamsSchema, result: ServerTerminalReadResultSchema },
  'server.report_issue': { params: ServerReportIssueParamsSchema, result: ServerReportIssueResultSchema },
} as const

export type SidecarServerMethods = typeof SIDECAR_SERVER_METHODS
export type SidecarServerMethodName = keyof SidecarServerMethods
export type SidecarServerParams<M extends SidecarServerMethodName> = z.output<SidecarServerMethods[M]['params']>
export type SidecarServerResultInput<M extends SidecarServerMethodName> = z.input<SidecarServerMethods[M]['result']>
