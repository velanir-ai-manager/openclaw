// Shared types for the pending-responsibility-context plugin.
// This module has NO OpenClaw imports so it can be unit-tested directly
// under `node --test` (Node type-stripping) with zero dependencies.

export type InteractionStage =
  | "awaiting_confirmation"
  | "needs_info"
  | "proposed"
  | "scheduled"
  | "booked"
  | "closed"
  // Unknown/future stages are tolerated as opaque strings; they are treated
  // as terminal (no action allowed) by the legality table below.
  | (string & {});

export type InteractionAction = "select_option" | "reject" | "change" | "status";

export type OfferedSlot = {
  // Optional stable slot id; when absent the ISO `start` is the identity.
  id?: string;
  // Optional displayed one-based option number (compatibility selection path).
  number?: number;
  // ISO-8601 local start the runner computed. The model may only pick one of these.
  start: string;
  // Human display string (e.g. "Tue Jul 15 1:00–1:30 PM PT").
  display: string;
};

// The normalized, redacted interaction the plugin works with internally.
export type PendingInteraction = {
  interactionId: string;
  // Opaque token of the interaction's current state. Any state write changes it.
  stateVersion: string;
  stage: InteractionStage;
  responsibilityId: string;
  // Scope keys. When set, an item is only surfaced/actionable in a turn whose
  // corresponding trusted runtime context matches.
  agentId?: string;
  channel?: string;
  userId?: string;
  sessionKey?: string;
  accountId?: string;
  conversationId?: string;
  // One-line redacted human summary (subject).
  summary: string;
  // [] when the interaction has not offered any slots yet (e.g. needs_info).
  offeredSlots: OfferedSlot[];
  requestedWindowHint?: string;
  lastAskedToUser?: string;
  deliveryMessageId?: string;
  note?: string;
  // The config source id this interaction came from (for diagnostics/status).
  source: string;
};

// The item shape the plugin EXPECTS `node runner.mjs pending` to emit per
// interaction. Fields are all optional to stay backward-compatible with the
// reference runner's current `pending` output (threadKey/subject/candidateSlots).
export type RawPendingSlot =
  | string
  | {
      id?: string;
      optionId?: string;
      number?: string | number;
      start?: string;
      value?: unknown;
      display?: string;
      label?: string;
    };

export type RawPendingItem = {
  id?: string;
  interactionId?: string;
  stateVersion?: string | number;
  stage?: string;
  responsibilityId?: string;
  agentId?: string;
  channel?: string;
  userId?: string;
  managerUserId?: string;
  sessionKey?: string;
  accountId?: string;
  conversationId?: string;
  summary?: string;
  offeredSlots?: RawPendingSlot[];
  numberedSlots?: RawPendingSlot[];
  options?: RawPendingSlot[];
  requestedWindowHint?: string;
  lastAskedToUser?: string;
  deliveryMessageId?: string;
  delivery?: { messageId?: string };
  note?: string;
  // Reference-runner compatibility fields:
  threadKey?: string;
  subject?: string;
  counterpart?: string;
  candidateSlots?: RawPendingSlot[];
};

export type RawPendingEnvelope = {
  ok?: boolean;
  pendingCount?: number;
  pending?: RawPendingItem[];
  hint?: string;
  facts?: Array<{
    kind?: string;
    payload?: {
      pendingCount?: number;
      pending?: RawPendingItem[];
      hint?: string;
    };
  }>;
};

export type ResponsibilitySource = {
  id: string;
  responsibilityId: string;
  agentId?: string;
  workspacePath: string;
  // argv array; defaults to ["node", "runner.mjs", "pending"].
  command: string[];
  // Optional runner-owned transaction argv. It has no default deliberately:
  // setting dryRun=false must never invent an effect command. Platform must
  // render an explicit reviewed bridge before this plugin can execute effects.
  actionCommand?: string[];
  timeoutMs: number;
  actionTimeoutMs?: number;
  maxOutputBytes: number;
  channel?: string;
  userId?: string;
  sessionKey?: string;
  accountId?: string;
  conversationId?: string;
};

export type PluginConfig = {
  // Default ON. Turning it off is necessary but not sufficient for effects:
  // the source must also declare an explicit actionCommand.
  dryRun: boolean;
  // Injection budget.
  maxInjectionChars: number;
  maxItemsInInjection: number;
  // When true (default) an interaction with no userId is never injected into a
  // user-scoped chat, preventing cross-user leakage of unscoped items.
  strictUserScope: boolean;
  // When true (default), an interaction must name an exact session or
  // conversation before it can be surfaced in a channel turn.
  strictSessionScope: boolean;
  // Maximum age (ms) of a trusted inbound message that can authorize one typed
  // action; also bounds the delivery/finalization stores and quiet sessions.
  authorizationTtlMs: number;
  // When true (default), cancel non-final reply payloads for a fresh inbound
  // session that currently owns pending responsibility context. Never global.
  suppressNonFinalReplies: boolean;
  sources: ResponsibilitySource[];
  logging: {
    decisions: boolean;
    includeContent: boolean;
  };
};

export type TurnScope = {
  agentId?: string;
  channel?: string;
  userId?: string;
  sessionKey?: string;
  accountId?: string;
  conversationId?: string;
};

export type ToolErrorCode =
  | "unknown_interaction"
  | "state_version_mismatch"
  | "interaction_version_conflict"
  | "missing_user_message_id"
  | "action_not_allowed_for_stage"
  | "slot_not_offered"
  | "slot_no_longer_available"
  | "slot_in_past"
  | "missing_slot"
  | "missing_option"
  | "missing_reason"
  | "missing_requested_window"
  | "ambiguous_requires_interaction_id"
  | "no_pending_interactions"
  | "authorization_unavailable"
  | "zoom_create_failed"
  | "transaction_recovery_required"
  | "transaction_receipt_invalid"
  | "source_unavailable"
  // Runner-derived codes are passed through verbatim when not recognized.
  | (string & {});

export type ToolError = {
  ok: false;
  error: ToolErrorCode;
  message: string;
  // Present for ambiguity so the model can re-issue with an explicit id.
  candidates?: string[];
};

export type DryRunOutcome = {
  ok: true;
  dryRun: boolean;
  action: InteractionAction;
  interactionId: string;
  stateVersion: string;
  // The stage the interaction WOULD transition to if effects were enabled.
  wouldTransitionTo?: InteractionStage;
  // Redacted human description of the effect that WOULD happen.
  wouldPerform: string;
  // Echo of the accepted, redacted parameters (never raw provider data).
  accepted: Record<string, string>;
};

export type StatusOutcome = {
  ok: true;
  interactionId: string;
  stateVersion: string;
  stage: InteractionStage;
  summary: string;
  offeredSlots: OfferedSlot[];
  requestedWindowHint?: string;
  lastAskedToUser?: string;
  note?: string;
};

export type PendingListOutcome = {
  ok: true;
  pendingCount: number;
  pending: Array<{
    interactionId: string;
    stateVersion: string;
    stage: InteractionStage;
    summary: string;
    offeredSlots: OfferedSlot[];
    requestedWindowHint?: string;
    lastAskedToUser?: string;
    note?: string;
  }>;
  // Present only on an empty scoped result: the exact final text the agent
  // must return, plus machine-readable markers proving absence is scope-local.
  visibility?: "authenticated_session";
  absenceProof?: "scoped_only";
  stopAfterThisTool?: boolean;
  userVisibleText?: string;
  hint: string;
};
