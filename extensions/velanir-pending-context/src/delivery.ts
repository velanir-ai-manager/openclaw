// Transaction delivery finalization. Owns the mapping from ONE authoritative
// responsibility action per run to ONE exact user-visible final message.
//
// Responsibilities:
//   - Track runs whose turn was prepared with pending responsibility context.
//   - Admit at most one action attempt per run; later attempts are duplicates.
//   - Derive the expected final text from the action receipt (success requires
//     complete typed receipts, never model prose).
//   - Detect ungrounded scheduling-success claims when no action ran.
//   - Suppress duplicate final delivery per session.
//
// This module has NO OpenClaw imports so it runs under `node --test`.

export const DELIVERY_ACTION_TOOLS: ReadonlySet<string> = new Set([
  "responsibility_select_option",
  "responsibility_reject",
  "responsibility_change",
]);

function clean(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// Deterministic detector for a positive scheduling-success claim. Negative
// statements ("no meeting was scheduled", "I couldn't book…") are removed
// before matching so a truthful failure answer is never flagged.
export function claimsSchedulingSuccess(value: unknown): boolean {
  const text = clean(value)?.toLowerCase();
  if (!text) {
    return false;
  }
  const withoutNegativeClaims = text
    .replace(
      /\b(?:no|not)\s+(?:calendar\s+)?(?:meeting|event|invite|booking)\b[^.!?\n]{0,80}\b(?:scheduled|booked|created|sent|confirmed)\b/g,
      "",
    )
    .replace(
      /\b(?:could(?:n't| not)|did(?:n't| not)|was(?:n't| not)|is(?:n't| not)|has(?:n't| not)|haven(?:'t| not))\b[^.!?\n]{0,80}\b(?:schedule|scheduled|book|booked|create|created|send|sent|confirm|confirmed)\b/g,
      "",
    );
  return (
    /\b(?:done|finished|all set)\b/.test(withoutNegativeClaims) ||
    /\b(?:i|we)(?:'ve|\s+have)?\s+(?:scheduled|booked|created|sent)\b/.test(
      withoutNegativeClaims,
    ) ||
    /\b(?:i|we)(?:'ve|\s+have)?\s+confirmed\s+(?:the\s+)?(?:booking|meeting|slot|invite)\b/.test(
      withoutNegativeClaims,
    ) ||
    /\b(?:meeting|event|invite|booking)\s+(?:(?:has been|is|was)\s+)?(?:scheduled|booked|created|sent|confirmed)\b/.test(
      withoutNegativeClaims,
    ) ||
    /\b(?:calendar event|meeting invite)\s+(?:was|has been)\s+(?:created|sent)\b/.test(
      withoutNegativeClaims,
    )
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// Tool results arrive either as the raw outcome payload or wrapped in the
// AgentToolResultLike envelope ({ content: [{text}], details }).
export function parseToolOutcome(result: unknown): Record<string, unknown> | undefined {
  const resultRecord = asRecord(result);
  if (!resultRecord) {
    return undefined;
  }
  const details = asRecord(resultRecord.details);
  if (details) {
    return details;
  }
  const content = Array.isArray(resultRecord.content) ? resultRecord.content : [];
  for (const item of content) {
    const text = clean(asRecord(item)?.text);
    if (!text) {
      continue;
    }
    try {
      const parsed = asRecord(JSON.parse(text));
      if (parsed) {
        return parsed;
      }
    } catch {
      // fall through to the raw record
    }
  }
  return resultRecord;
}

export function buildTransactionFailureText(errorCode: string | undefined): string {
  if (errorCode === "dry_run") {
    return "I checked your selection in dry-run mode. No calendar event, video meeting, or confirmation email was created.";
  }
  if (errorCode === "authorization_unavailable") {
    return "I couldn't complete the scheduling because this action was not securely bound to your latest message. No calendar event was created.";
  }
  if (errorCode === "state_version_mismatch" || errorCode === "interaction_version_conflict") {
    return "I couldn't complete the scheduling because the meeting details changed before the transaction finished. No calendar event was created.";
  }
  if (errorCode === "slot_not_offered" || errorCode === "slot_no_longer_available") {
    return "I couldn't complete the scheduling because that time is no longer one of the available options. No calendar event was created.";
  }
  if (errorCode === "slot_in_past") {
    return "I couldn't complete the scheduling because that meeting time has already passed. No calendar event was created.";
  }
  if (errorCode === "zoom_create_failed") {
    return "I couldn't create the Zoom meeting, so no calendar event or confirmation email was created. I need the Zoom connection fixed before I retry.";
  }
  if (errorCode === "action_not_allowed_for_stage") {
    return "I couldn't confirm that slot because this scheduling request is not currently awaiting your selection. No calendar event or confirmation email was created.";
  }
  if (errorCode === "transaction_recovery_required") {
    return "I couldn't retry this meeting because the previous booking attempt is waiting for recovery. No calendar event or confirmation email was created.";
  }
  if (errorCode === "transaction_receipt_invalid") {
    return "I couldn't verify the complete scheduling receipts, so I won't claim the meeting was completed. Check the calendar and sent mail before retrying.";
  }
  return "I couldn't complete the scheduling transaction. No calendar event was created or changed.";
}

export function buildTransactionSuccessText(outcome: Record<string, unknown>): string {
  const explicit = clean(outcome.userVisibleText);
  if (explicit) {
    return explicit;
  }
  const result = asRecord(outcome.result);
  const counterpart = clean(result?.counterpart);
  const display = clean(result?.display) ?? clean(result?.start);
  const replied = result?.replied === true;
  const subject = counterpart ? ` with ${counterpart}` : "";
  const when = display ? ` for ${display}` : "";
  const receipt = replied
    ? "The calendar event was created and the confirmation was sent."
    : "The calendar event was created.";
  return `Done — I scheduled the meeting${subject}${when}. ${receipt}`;
}

// A success claim requires the complete typed receipt set: a real (non-dry-run)
// select_option transaction that reached `scheduled` with calendar event id,
// Zoom join URL, and the counterparty reply receipt. Anything less fails closed.
export function hasCompleteSchedulingReceipts(
  outcome: Record<string, unknown> | undefined,
): boolean {
  if (
    outcome?.ok !== true ||
    outcome.dryRun !== false ||
    outcome.action !== "select_option" ||
    outcome.status !== "scheduled"
  ) {
    return false;
  }
  const result = asRecord(outcome.result);
  return Boolean(clean(result?.eventId) && clean(result?.joinUrl) && result?.replied === true);
}

export type DeliveryRunRecord = {
  runId: string;
  sessionKey?: string;
  updatedAt: number;
  actionAttempted: boolean;
  actionFinished: boolean;
  actionSucceeded: boolean;
  finalTextClaimed?: boolean;
  userVisibleText?: string;
  errorCode?: string;
  finalDelivered?: boolean;
};

export type TransactionDeliveryState = {
  byRun: Map<string, DeliveryRunRecord>;
  runByToolCall: Map<string, string>;
};

export function createTransactionDeliveryState(): TransactionDeliveryState {
  return {
    byRun: new Map(),
    runByToolCall: new Map(),
  };
}

export function sharedTransactionDeliveryState(): TransactionDeliveryState {
  const key = "__velanirPendingContextDeliveryV1";
  const runtime = globalThis as Record<string, unknown>;
  const existing = runtime[key];
  if (existing) {
    return existing as TransactionDeliveryState;
  }
  const state = createTransactionDeliveryState();
  runtime[key] = state;
  return state;
}

export type DeliveryHookEvent = {
  runId?: string;
  toolName?: string;
  toolCallId?: string;
  result?: unknown;
  error?: unknown;
  kind?: string;
};

export type DeliveryHookContext = {
  runId?: string;
  toolName?: string;
  toolCallId?: string;
  sessionKey?: string;
};

export type TransactionDeliveryStore = {
  markPendingTurn(runIdValue: unknown, sessionKeyValue: unknown): boolean;
  beginAction(
    event: DeliveryHookEvent,
    ctx: DeliveryHookContext,
  ): { tracked: boolean; duplicate: boolean };
  failAction(
    event: DeliveryHookEvent,
    ctx: DeliveryHookContext,
    errorCode: string | undefined,
  ): boolean;
  finishAction(event: DeliveryHookEvent, ctx: DeliveryHookContext): boolean;
  blockFurtherTool(event: DeliveryHookEvent, ctx: DeliveryHookContext): boolean;
  suppressNonFinal(event: DeliveryHookEvent): boolean;
  expectedFinalText(runIdValue: unknown): string | undefined;
  expectedFinalTextForToolCall(toolCallIdValue: unknown): string | undefined;
  pendingWithoutAction(runIdValue: unknown): boolean;
  claimNoActionFailureForSession(sessionKeyValue: unknown): string | undefined;
  authoritativeFinalForSession(
    sessionKeyValue: unknown,
    modelClaimsSuccess: boolean,
  ): string | undefined;
  markFinalDelivered(sessionKeyValue: unknown): boolean;
  finalAlreadyDelivered(sessionKeyValue: unknown): boolean;
  claimFinalTextForSession(sessionKeyValue: unknown): string | undefined;
  finalizeReply(event: DeliveryHookEvent): { text?: string } | undefined;
};

export function createTransactionDeliveryStore(
  ttlMs: number,
  now: () => number = Date.now,
  state: TransactionDeliveryState = createTransactionDeliveryState(),
): TransactionDeliveryStore {
  const { byRun, runByToolCall } = state;

  const prune = (): void => {
    for (const [runId, record] of byRun) {
      if (now() - record.updatedAt > ttlMs) {
        byRun.delete(runId);
      }
    }
    for (const [toolCallId, runId] of runByToolCall) {
      if (!byRun.has(runId)) {
        runByToolCall.delete(toolCallId);
      }
    }
  };

  const resolveRun = (event: DeliveryHookEvent, ctx: DeliveryHookContext): string | undefined =>
    clean(event.runId) ?? clean(ctx.runId);

  return {
    markPendingTurn(runIdValue: unknown, sessionKeyValue: unknown): boolean {
      prune();
      const runId = clean(runIdValue);
      if (!runId) {
        return false;
      }
      const existing = byRun.get(runId);
      byRun.set(runId, {
        runId,
        ...(clean(sessionKeyValue) ? { sessionKey: clean(sessionKeyValue) } : {}),
        updatedAt: now(),
        actionAttempted: existing?.actionAttempted ?? false,
        actionFinished: existing?.actionFinished ?? false,
        actionSucceeded: existing?.actionSucceeded ?? false,
        ...(existing?.finalTextClaimed ? { finalTextClaimed: true } : {}),
        ...(existing?.userVisibleText ? { userVisibleText: existing.userVisibleText } : {}),
        ...(existing?.errorCode ? { errorCode: existing.errorCode } : {}),
        ...(existing?.finalDelivered ? { finalDelivered: true } : {}),
      });
      return true;
    },
    beginAction(
      event: DeliveryHookEvent,
      ctx: DeliveryHookContext,
    ): { tracked: boolean; duplicate: boolean } {
      prune();
      const toolName = clean(event.toolName) ?? clean(ctx.toolName);
      if (!toolName || !DELIVERY_ACTION_TOOLS.has(toolName)) {
        return { tracked: false, duplicate: false };
      }
      const runId = resolveRun(event, ctx);
      const toolCallId = clean(event.toolCallId) ?? clean(ctx.toolCallId);
      if (!runId || !toolCallId) {
        return { tracked: false, duplicate: false };
      }
      const existing = byRun.get(runId);
      if (existing?.actionAttempted) {
        return { tracked: true, duplicate: true };
      }
      byRun.set(runId, {
        runId,
        ...(clean(ctx.sessionKey) ? { sessionKey: clean(ctx.sessionKey) } : {}),
        updatedAt: now(),
        actionAttempted: true,
        actionFinished: false,
        actionSucceeded: false,
      });
      runByToolCall.set(toolCallId, runId);
      return { tracked: true, duplicate: false };
    },
    failAction(
      event: DeliveryHookEvent,
      ctx: DeliveryHookContext,
      errorCode: string | undefined,
    ): boolean {
      prune();
      const toolCallId = clean(event.toolCallId) ?? clean(ctx.toolCallId);
      const runId =
        (toolCallId ? runByToolCall.get(toolCallId) : undefined) ?? resolveRun(event, ctx);
      if (!runId) {
        return false;
      }
      const record = byRun.get(runId);
      if (!record) {
        return false;
      }
      record.updatedAt = now();
      record.actionFinished = true;
      record.actionSucceeded = false;
      record.errorCode = clean(errorCode) ?? "transaction_failed";
      return true;
    },
    finishAction(event: DeliveryHookEvent, ctx: DeliveryHookContext): boolean {
      prune();
      const toolName = clean(event.toolName) ?? clean(ctx.toolName);
      if (!toolName || !DELIVERY_ACTION_TOOLS.has(toolName)) {
        return false;
      }
      const toolCallId = clean(event.toolCallId) ?? clean(ctx.toolCallId);
      const runId =
        (toolCallId ? runByToolCall.get(toolCallId) : undefined) ?? resolveRun(event, ctx);
      if (!runId) {
        return false;
      }
      const record = byRun.get(runId);
      if (!record) {
        return false;
      }
      const outcome = parseToolOutcome(event.result);
      const succeeded = event.error === undefined && hasCompleteSchedulingReceipts(outcome);
      record.updatedAt = now();
      record.actionFinished = true;
      record.actionSucceeded = succeeded;
      if (succeeded && outcome) {
        record.userVisibleText = buildTransactionSuccessText(outcome);
        delete record.errorCode;
      } else {
        record.errorCode =
          outcome?.ok === true && outcome?.dryRun === true
            ? "dry_run"
            : (clean(outcome?.error) ??
              clean(event.error) ??
              (event.error === undefined && outcome?.ok === true && outcome?.dryRun === false
                ? "transaction_receipt_invalid"
                : "transaction_failed"));
        // A runner-supplied user-visible string is trusted only after a full
        // receipt check. Failed/dry-run paths always use the canonical
        // truthful text below so a partial runner response cannot claim
        // completion.
        delete record.userVisibleText;
      }
      return true;
    },
    // After the one authoritative action finished, every OTHER tool call in the
    // same run is blocked (the action's own toolCallId is allowed through).
    blockFurtherTool(event: DeliveryHookEvent, ctx: DeliveryHookContext): boolean {
      prune();
      const runId = resolveRun(event, ctx);
      if (!runId) {
        return false;
      }
      const record = byRun.get(runId);
      if (!record?.actionFinished) {
        return false;
      }
      const toolCallId = clean(event.toolCallId) ?? clean(ctx.toolCallId);
      return !toolCallId || runByToolCall.get(toolCallId) !== runId;
    },
    suppressNonFinal(event: DeliveryHookEvent): boolean {
      prune();
      if (event.kind === "final") {
        return false;
      }
      const runId = clean(event.runId);
      return Boolean(runId && byRun.has(runId));
    },
    expectedFinalText(runIdValue: unknown): string | undefined {
      prune();
      const runId = clean(runIdValue);
      if (!runId) {
        return undefined;
      }
      const record = byRun.get(runId);
      if (!record?.actionAttempted) {
        return undefined;
      }
      return record.actionSucceeded
        ? record.userVisibleText
        : (record.userVisibleText ?? buildTransactionFailureText(record.errorCode));
    },
    expectedFinalTextForToolCall(toolCallIdValue: unknown): string | undefined {
      prune();
      const toolCallId = clean(toolCallIdValue);
      const runId = toolCallId ? runByToolCall.get(toolCallId) : undefined;
      return runId ? this.expectedFinalText(runId) : undefined;
    },
    pendingWithoutAction(runIdValue: unknown): boolean {
      prune();
      const runId = clean(runIdValue);
      if (!runId) {
        return false;
      }
      const record = byRun.get(runId);
      return Boolean(record && !record.actionAttempted);
    },
    claimNoActionFailureForSession(sessionKeyValue: unknown): string | undefined {
      prune();
      const sessionKey = clean(sessionKeyValue);
      if (!sessionKey) {
        return undefined;
      }
      const record = [...byRun.values()]
        .filter(
          (candidate) =>
            candidate.sessionKey === sessionKey &&
            !candidate.actionAttempted &&
            !candidate.finalTextClaimed,
        )
        .toSorted((left, right) => right.updatedAt - left.updatedAt)[0];
      if (!record) {
        return undefined;
      }
      record.finalTextClaimed = true;
      record.updatedAt = now();
      return "I didn't complete a scheduling transaction. No calendar event was created or changed.";
    },
    authoritativeFinalForSession(
      sessionKeyValue: unknown,
      modelClaimsSuccess: boolean,
    ): string | undefined {
      prune();
      const sessionKey = clean(sessionKeyValue);
      if (!sessionKey) {
        return undefined;
      }
      const record = [...byRun.values()]
        .filter((candidate) => candidate.sessionKey === sessionKey && !candidate.finalDelivered)
        .toSorted((left, right) => right.updatedAt - left.updatedAt)[0];
      if (!record) {
        return undefined;
      }
      if (record.actionAttempted) {
        return record.actionSucceeded
          ? record.userVisibleText
          : (record.userVisibleText ?? buildTransactionFailureText(record.errorCode));
      }
      return modelClaimsSuccess
        ? "I didn't complete a scheduling transaction. No calendar event was created or changed."
        : undefined;
    },
    markFinalDelivered(sessionKeyValue: unknown): boolean {
      prune();
      const sessionKey = clean(sessionKeyValue);
      if (!sessionKey) {
        return false;
      }
      const record = [...byRun.values()]
        .filter((candidate) => candidate.sessionKey === sessionKey)
        .toSorted((left, right) => right.updatedAt - left.updatedAt)[0];
      if (!record) {
        return false;
      }
      record.finalDelivered = true;
      record.updatedAt = now();
      return true;
    },
    finalAlreadyDelivered(sessionKeyValue: unknown): boolean {
      prune();
      const sessionKey = clean(sessionKeyValue);
      if (!sessionKey) {
        return false;
      }
      const latest = [...byRun.values()]
        .filter((candidate) => candidate.sessionKey === sessionKey)
        .toSorted((left, right) => right.updatedAt - left.updatedAt)[0];
      return latest?.finalDelivered === true;
    },
    claimFinalTextForSession(sessionKeyValue: unknown): string | undefined {
      prune();
      const sessionKey = clean(sessionKeyValue);
      if (!sessionKey) {
        return undefined;
      }
      const record = [...byRun.values()]
        .filter(
          (candidate) =>
            candidate.sessionKey === sessionKey &&
            candidate.actionAttempted &&
            !candidate.finalTextClaimed,
        )
        .toSorted((left, right) => right.updatedAt - left.updatedAt)[0];
      if (!record) {
        return undefined;
      }
      record.finalTextClaimed = true;
      record.updatedAt = now();
      return record.actionSucceeded
        ? record.userVisibleText
        : (record.userVisibleText ?? buildTransactionFailureText(record.errorCode));
    },
    finalizeReply(event: DeliveryHookEvent): { text?: string } | undefined {
      prune();
      if (event.kind !== "final") {
        return undefined;
      }
      const runId = clean(event.runId);
      if (!runId) {
        return undefined;
      }
      const record = byRun.get(runId);
      if (!record) {
        return undefined;
      }
      byRun.delete(runId);
      for (const [toolCallId, candidateRunId] of runByToolCall) {
        if (candidateRunId === runId) {
          runByToolCall.delete(toolCallId);
        }
      }
      if (!record.actionAttempted) {
        return {};
      }
      return {
        text: record.actionSucceeded
          ? record.userVisibleText
          : (record.userVisibleText ?? buildTransactionFailureText(record.errorCode)),
      };
    },
  };
}
