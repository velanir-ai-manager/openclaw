# Pending Responsibility Context — Design

Status: historical phase-one design plus the superseding 0.4.0 delivery
contract below. The original runner architecture reference remains
`docs/superpowers/plans/2026-07-10-runner-architecture-handoff.md`.

## 0.4.0 canonical transaction/finalization contract

This section supersedes any phase-one statement below that describes only
prompt guidance or the old `responsibility_confirm` tool.

- `responsibility_select_option` is the canonical selection tool. Stable option
  ids are preferred; a displayed number is resolved to the stable option only
  when authoritative pending state makes it unambiguous.
- `message_received` records a fresh host-provided message id, sender, and
  exact session. The manifest-declared `authoritative-pending-action` trusted
  policy binds that record to one action tool call. The model schema never
  includes a message id.
- `suppressNonFinalReplies=true` cancels non-final reply payloads only after a
  fresh inbound run has both a matching authorization and matching strict-scope
  pending state. It cannot make unrelated or stale chat globally final-only.
- The first action is authoritative for that run. Its result blocks follow-up
  tools/retries; `reply_payload_sending` admits one final and suppresses a
  duplicate. `before_message_write` keeps the persisted assistant text aligned
  with that same final.
- A model cannot claim successful scheduling without a typed non-dry-run
  receipt proving an Outlook event id, Zoom join URL, and counterpart reply.
  The delivery boundary rewrites an ungrounded, partial, or failed claim to a
  concise truthful result.
- `dryRun` remains true by default. A source must additionally supply an
  explicit action argv before a false can execute anything; no default effect
  command exists.

## Problem this closes

OpenClaw 2026.7.2 mirrors a successful direct cron announce into the
resolved destination session. The mirror is best-effort and occurs after
delivery, so the main agent cannot use transcript presence as a durable workflow
record. Pilot evidence (Riley Quinn, 2026-07-10): a bare reply like "Lets do 1
pm" got bound to a stale thread from a 128k-token session, and the main agent
then improvised provider calls. The tick surface already has code enforcement
(`pending`-based binding, runner guards); the interactive surface did not. This
plugin gives the interactive surface the same enforcement: **structural state
in context + typed, credential-free tools** instead of prose "don't".

## OpenClaw hooks and seams used (openclaw@2026.7.2)

Verified by inspecting the installed beta's plugin SDK
(`openclaw/plugin-sdk/plugin-entry` → bundled `types-*.d.ts` / `hook-types-*.d.ts`),
not guessed:

| Seam                                                     | Signature (as found)                                                                                                                                                                                                                                                               | Why                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.on("agent_turn_prepare", h)`                        | `(event: PluginAgentTurnPrepareEvent, ctx: PluginHookAgentContext) => PluginAgentTurnPrepareResult \| void`. `PROMPT_INJECTION_HOOK_NAMES` includes `"agent_turn_prepare"`. Result = `{ prependContext?, appendContext? }`.                                                        | The prompt-injection seam for **main-agent turns**. We return `appendContext` with the scoped pending block so the model sees pending interactions before interpreting a reply. `ctx` carries `agentId`, `sessionKey`, provider `channel`, `channelId`/`chatId`, and `senderId`. It does **not** carry `accountId` in beta.5. |
| `api.registerTool(factory)`                              | `registerTool(tool: AnyAgentTool \| OpenClawPluginToolFactory, opts?)`. Factory = `(ctx: OpenClawPluginToolContext) => AnyAgentTool`. `OpenClawPluginToolContext` carries `agentId`, `sessionKey`, `messageChannel`, `agentAccountId`, `requesterSenderId`, and `deliveryContext`. | Registers the five tools. We use the **factory** form so each tool invocation is scoped to the calling agent/provider/session/user.                                                                                                                                                                                           |
| `AnyAgentTool` / `AgentTool`                             | `{ name, description, parameters: TSchema, label, execute(toolCallId, params, signal?, onUpdate?) => Promise<AgentToolResult> }`; `AgentToolResult = { content: (TextContent\|ImageContent)[], details }`.                                                                         | Tool shape. `parameters` is a TypeBox `TSchema`; our JSON-Schema contract objects are structurally compatible and cast at the registration boundary (`src/api.ts`).                                                                                                                                                           |
| `definePluginEntry({ id, name, description, register })` | from `openclaw/plugin-sdk/plugin-entry`.                                                                                                                                                                                                                                           | Same registration convention as `participation-gate`.                                                                                                                                                                                                                                                                         |

Not used (considered): `enqueueNextTurnInjection` (queues a one-shot injection
for the _next_ turn — wrong timing; we want the block on the _current_ turn, and
`agent_turn_prepare` is synchronous per-turn) and `before_prompt_build` /
`before_agent_start` (also prompt-injection hooks, but `agent_turn_prepare` is
the narrowest surface that carries the full turn scope).

## Injection format (exact block)

Returned as `appendContext`. Header + intro + one line per in-scope
interaction + optional truncation indicator + footer:

```
[pending responsibility interactions]
You have 2 pending responsibility interactions awaiting this user's reply. Delivery transcript mirrors are best-effort; pending state is authoritative. Before interpreting a scheduling reply, call responsibility_pending and bind it to exactly ONE interactionId. If more than one could match, ask which — never guess a thread or improvise provider actions.
1. id=SM-1 · v=v1 · stage=awaiting_confirmation · "Sync with Dana" offered: Tue Jul 15 1:00–1:30 PM PT; Tue Jul 15 3:00–3:30 PM PT
2. id=SM-2 · v=v2 · stage=needs_info · "Budget review" awaiting a preferred time
(+3 more — call responsibility_pending for the full list)
Act only via responsibility_confirm | responsibility_reject | responsibility_change with the exact interactionId and stateVersion (dry-run: no external effects yet).
```

Size cap (`maxInjectionChars`, default 1800): over budget, trailing item lines
are dropped and a `(+N more …)` indicator is kept, so the header/intro/footer and
the "call responsibility_pending" escape hatch always survive. `maxItemsInInjection`
(default 6) caps inline lines before the size cap even applies.

## Scoping (never leak across users)

Primary scope key = `(agentId, channel, sessionKey, userId)`, with
`conversationId` as an exact-destination fallback only when `sessionKey` is
absent. When a session key is present, it is authoritative and the plugin does
not also require hook-specific conversation representations to match.
`filterForTurn` is
**fail-closed**:

- If an item declares a scope value, the turn must carry an equal value
  (`item set, turn unset → excluded`).
- `strictUserScope` (default ON): an item with no `userId` is never injected into
  a user-scoped chat, so unattributable items cannot leak.
- `strictSessionScope` (default ON): an item with neither `sessionKey` nor
  `conversationId` is never injected or exposed through a tool. User + provider
  is not an exact boundary because the same user can participate in several DMs,
  group chats, and channel threads.
- `accountId` is an optional additional restriction. In beta.5 the tool factory
  receives it but `agent_turn_prepare` does not. Configuring an item/source with
  `accountId` therefore intentionally suppresses prompt injection. Do not set it
  for Riley until OpenClaw exposes the account on the prepare hook or this plugin
  moves injection to an equally early account-aware seam.

Both the injection hook (`ctx.senderId`) and the tool factory
(`ctx.requesterSenderId`) build the same `TurnScope` and use the same fail-closed
filter. The exact `sessionKey` is the stable common boundary in beta.5.

## Sourcing (`node runner.mjs pending`)

`loadPendingFromSource` runs a **read-only** exec (default argv
`["node","runner.mjs","pending"]`, configurable per source: `workspacePath`,
`command`, `timeoutMs`, `maxOutputBytes`) via an injected `RunnerExec`
(`src/runner-exec.ts` uses `execFileSync` — argv array, no shell). Guards:

- **Timeout + size cap**: `execFileSync({ timeout, maxBuffer })`; ENOBUFS →
  `output_truncated`. A truncated payload is **refused, never parsed** (a partial
  provider blob could smuggle unredacted bytes past a redaction boundary).
- **Fail-safe**: any exec/parse failure yields zero items + a recorded error;
  the turn is never crashed and the injection simply omits that source.
- **Backward-compatible mapping**: the parser accepts both a top-level
  `pending` array and the packaged runtime's `facts[].payload.pending` array.
  `threadKey`, `interactionId`, `numberedSlots`/`candidateSlots`, stable
  `optionId`, object-valued `startsAt`, `lastAskedToUser`, and numeric/string
  state versions map to normalized interactions. When a legacy runner omits
  `interactionId` / `stateVersion`, they fall back to `threadKey` and a
  deterministic content hash that includes the current ask.

## Tool contracts (validation, dry-run)

`responsibility_pending` is registered FIRST and is read-only. Action tools
validate, in order: interactionId resolves (`unknown_interaction`) → userMessageId
present (`missing_user_message_id`) → stateVersion equals current
(`state_version_mismatch`) → action legal for stage
(`action_not_allowed_for_stage`) → action-specific (`slot_not_offered`,
`missing_reason`, `missing_requested_window`). Any failure → typed error, no
effect. Ambiguity: `selectInteraction` returns
`ambiguous_requires_interaction_id` (with candidate ids) when the id is omitted
and more than one interaction is pending — the model must name one, never guess.

Stage/action legality:

| Stage                                                     | confirm | reject | change |
| --------------------------------------------------------- | ------- | ------ | ------ |
| `awaiting_confirmation` / `proposed` (with offered slots) | ✅      | ✅     | ✅     |
| `needs_info` (no slots)                                   | ❌      | ✅     | ✅     |
| `scheduled` / `booked` / `closed`                         | ❌      | ❌     | ❌     |

`dryRun` defaults ON: valid confirm/reject/change return
`{ ok, dryRun:true, wouldTransitionTo, wouldPerform, accepted }` — no external
effects, no state writes. Nothing here calls a provider or the runner's write
substeps.

## Credential safety (#5)

`redactText` runs over every model-visible string (summaries, notes, slot
displays, echoed params) and strips connection ids (`conn_mod_def::…`,
`live::…`), api keys (`ak_/sk_/pk_/ghp_/xox…`), bearer tokens, JWTs, and
reasoning-tag residue (`<think>`, `mm:think`). Tool results only ever carry
whitelisted, mapped fields — raw runner stdout is never returned.

## Later effects integration

The packaged typed runner is now installed through Platform, but this plugin
still does **not** import runner code or execute effects. Do not flip `dryRun`
off by configuration alone. A later integration needs an OpenClaw-authenticated
inbound capability that the child cannot forge and must preserve the generated
main -> responsibility child ownership flow.

| Tool (dry-run today)     | Runner substep(s) it drives (interactive bridge)                                            | Notes                                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `responsibility_pending` | `pending` (read-only, no lock)                                                              | Already the exact source; 1:1.                                                                                                                                                            |
| `responsibility_confirm` | `state -> validate/commit typed select_option -> next -> confirm -> book -> reply -> close` | Runs on the mute-leaf responsibility child, never main. The committed option, start, duration, source counterpart, state version, and inbound authorization are rechecked before effects. |
| `responsibility_reject`  | `state -> validate/commit` a matching typed reject/close decision                           | No provider effect.                                                                                                                                                                       |
| `responsibility_change`  | `state -> availability -> validate/commit` a matching change/propose decision               | Recomputes only runner-grounded slots.                                                                                                                                                    |
| `responsibility_status`  | `pending` / `state` read                                                                    | Read-only.                                                                                                                                                                                |

The packaged runner emits a stable `interactionId`, numeric `stateVersion`,
`lastAskedToUser`, numbered stable options, `agentId`, manager target, and
channel. A freshly created proposal does not yet know OpenClaw's canonical
destination session, so the exact `sessionKey`, conversation, and user scope
must come from reviewed Platform source configuration. When effects are enabled,
`confirm`/`reject`/`change` must delegate to the worker agent via
`sessions_spawn` and wait with `sessions_yield` (ack → spawn → yield → deliver), per
`docs/plans/workflow-responsibilities-architecture-decisions.md` (mute leaves,
never spawn-and-exit); the plugin returns the worker's DATA line, it does not
call providers itself.

## Config schema

See `openclaw.plugin.json`. Normalized (and rebuilt, so unknown fields drop) by
`src/config.ts`:

```
{
  dryRun: boolean = true,
  maxInjectionChars: number = 1800,
  maxItemsInInjection: number = 6,
  strictUserScope: boolean = true,
  strictSessionScope: boolean = true,
  sources: [{
    id?, responsibilityId (req), agentId?, workspacePath (req),
    command? = ["node","runner.mjs","pending"], timeoutMs? = 5000,
    maxOutputBytes? = 262144, channel?, userId?, sessionKey?,
    conversationId?, accountId?
  }],
  logging: { decisions: boolean = true, includeContent: boolean = false }
}
```

## Module map

```
src/
  types.ts        shared types (no OpenClaw import)
  redaction.ts    credential / reasoning-residue stripping
  source.ts       runner exec (injectable) → parse → map → PendingInteraction[]
  runner-exec.ts  the real execFileSync RunnerExec (timeout + size cap)
  interactions.ts index, selectInteraction (ambiguity), stage/action legality
  tools.ts        tool contracts + validate + dry-run
  injection.ts    scope filter + injection block + size-cap truncation
  config.ts       normalizeConfig
  api.ts          typed facade over openclaw/plugin-sdk/plugin-entry (ONLY OpenClaw import besides index)
  index.ts        registers tools (pending first) + agent_turn_prepare hook
```

Everything except `api.ts`, `index.ts`, and `runner-exec.ts` is OpenClaw-free
and unit-tested directly under `node --test`.
