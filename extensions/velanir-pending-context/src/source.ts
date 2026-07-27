// Sourcing pending interactions from a responsibility's runner.
//
// HARD REQUIREMENT (#2): pending items come from a read-only exec of
// `node runner.mjs pending` in the responsibility workspace (configurable
// workspacePath + command), with a timeout and a size cap. The exec is
// injected so the pure mapping/parse logic is unit-testable offline; the real
// execFileSync runner lives in index.ts.

import { createHash } from "node:crypto";
import { redactText } from "./redaction.js";
import type {
  OfferedSlot,
  PendingInteraction,
  RawPendingEnvelope,
  RawPendingItem,
  ResponsibilitySource,
  ToolError,
} from "./types.js";

export type RunnerExecInput = {
  command: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  // Action input JSON, passed via stdin (never argv) so provider identifiers
  // and message ids never appear in a process list.
  stdin?: string;
};

export type RunnerExecResult = {
  ok: boolean;
  // Captured stdout, already truncated to <= maxOutputBytes by the executor.
  stdout?: string;
  // Present when the exec failed (non-zero, timeout, spawn error).
  error?: string;
  // True when stdout hit the size cap and was truncated.
  truncated?: boolean;
};

export type RunnerExec = (input: RunnerExecInput) => RunnerExecResult;

export type LoadPendingResult = {
  items: PendingInteraction[];
  error?: string;
};

function shortHash(parts: Array<string | undefined>): string {
  return createHash("sha256")
    .update(parts.map((p) => p ?? "").join("|"))
    .digest("hex")
    .slice(0, 16);
}

function normalizeSlots(raw: RawPendingItem): OfferedSlot[] {
  const source = raw.offeredSlots ?? raw.numberedSlots ?? raw.candidateSlots ?? raw.options ?? [];
  const slots: OfferedSlot[] = [];
  for (const entry of source) {
    if (!entry) {
      continue;
    }
    if (typeof entry === "string") {
      const value = entry.trim();
      if (value) {
        slots.push({ start: value, display: redactText(value) || value });
      }
      continue;
    }
    const start =
      typeof entry.start === "string" && entry.start.trim()
        ? entry.start.trim()
        : typeof entry.value === "string" && entry.value.trim()
          ? entry.value.trim()
          : entry.value &&
              typeof entry.value === "object" &&
              typeof (entry.value as { startsAt?: unknown }).startsAt === "string" &&
              (entry.value as { startsAt: string }).startsAt.trim()
            ? (entry.value as { startsAt: string }).startsAt.trim()
            : "";
    if (!start) {
      continue;
    }
    const slotId =
      typeof entry.optionId === "string" && entry.optionId.trim()
        ? entry.optionId.trim()
        : typeof entry.id === "string" && entry.id.trim()
          ? entry.id.trim()
          : entry.number !== undefined
            ? String(entry.number)
            : undefined;
    // Preserve an explicit displayed option number so a numeric user choice can
    // be resolved to the stable option without positional guessing.
    const slotNumber =
      typeof entry.number === "number" && Number.isSafeInteger(entry.number) && entry.number > 0
        ? entry.number
        : typeof entry.number === "string" &&
            /^[1-9]\d*$/.test(entry.number.trim()) &&
            Number.isSafeInteger(Number(entry.number.trim()))
          ? Number(entry.number.trim())
          : undefined;
    const display = entry.display ?? entry.label ?? start;
    slots.push({
      ...(slotId ? { id: slotId } : {}),
      ...(slotNumber ? { number: slotNumber } : {}),
      start,
      display: redactText(display) || start,
    });
  }
  return slots;
}

export function mapRawItem(
  raw: RawPendingItem,
  source: ResponsibilitySource,
): PendingInteraction | null {
  const interactionId = (raw.interactionId ?? raw.id ?? raw.threadKey ?? "").trim();
  if (!interactionId) {
    // An item with no stable identity cannot be bound or acted on; drop it.
    return null;
  }
  const stage = (raw.stage ?? "").trim() || "needs_info";
  const offeredSlots = normalizeSlots(raw);
  const summary =
    redactText(
      raw.summary ?? raw.subject ?? raw.counterpart ?? raw.lastAskedToUser ?? "(no subject)",
    ) || "(no subject)";
  const note = raw.note ? redactText(raw.note) : undefined;
  const lastAskedToUser = raw.lastAskedToUser ? redactText(raw.lastAskedToUser) : undefined;
  const stateVersion =
    raw.stateVersion === undefined || raw.stateVersion === null
      ? ""
      : String(raw.stateVersion).trim();
  const effectiveStateVersion =
    stateVersion ||
    shortHash([interactionId, stage, JSON.stringify(offeredSlots), summary, lastAskedToUser]);

  return {
    interactionId,
    stateVersion: effectiveStateVersion,
    stage,
    responsibilityId: source.responsibilityId,
    ...((source.agentId ?? raw.agentId) ? { agentId: source.agentId ?? raw.agentId } : {}),
    ...((source.channel ?? raw.channel) ? { channel: source.channel ?? raw.channel } : {}),
    ...((source.userId ?? raw.userId ?? raw.managerUserId)
      ? { userId: source.userId ?? raw.userId ?? raw.managerUserId }
      : {}),
    ...((source.sessionKey ?? raw.sessionKey)
      ? { sessionKey: source.sessionKey ?? raw.sessionKey }
      : {}),
    ...((source.accountId ?? raw.accountId)
      ? { accountId: source.accountId ?? raw.accountId }
      : {}),
    ...((source.conversationId ?? raw.conversationId)
      ? { conversationId: source.conversationId ?? raw.conversationId }
      : {}),
    summary,
    offeredSlots,
    ...(raw.requestedWindowHint
      ? { requestedWindowHint: redactText(raw.requestedWindowHint) }
      : {}),
    ...(lastAskedToUser ? { lastAskedToUser } : {}),
    ...((raw.deliveryMessageId ?? raw.delivery?.messageId)
      ? { deliveryMessageId: (raw.deliveryMessageId ?? raw.delivery?.messageId ?? "").trim() }
      : {}),
    ...(note ? { note } : {}),
    source: source.id,
  };
}

export function parsePendingEnvelope(stdout: string): RawPendingEnvelope | null {
  // Tolerate leading/trailing log noise: take the last balanced JSON object.
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as RawPendingEnvelope;
  } catch {
    // Fall back to the last {...} block on the final non-empty line.
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as RawPendingEnvelope;
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function loadPendingFromSource(
  source: ResponsibilitySource,
  exec: RunnerExec,
): LoadPendingResult {
  let result: RunnerExecResult;
  try {
    result = exec({
      command: source.command,
      cwd: source.workspacePath,
      timeoutMs: source.timeoutMs,
      maxOutputBytes: source.maxOutputBytes,
    });
  } catch (err) {
    return { items: [], error: `exec_failed: ${(err as Error).message}` };
  }
  if (!result.ok) {
    return { items: [], error: result.error ?? "exec_failed" };
  }
  if (result.truncated) {
    // Fail safe: never parse a truncated provider payload — it may be partial
    // and could smuggle unredacted content past a pattern boundary.
    return { items: [], error: "output_truncated" };
  }
  const envelope = parsePendingEnvelope(result.stdout ?? "");
  const packagedPending =
    envelope?.facts
      ?.filter((fact) => fact?.kind === "pending")
      .flatMap((fact) => (Array.isArray(fact.payload?.pending) ? fact.payload.pending : [])) ?? [];
  const pending = Array.isArray(envelope?.pending)
    ? envelope.pending
    : packagedPending.length > 0 || envelope?.facts?.some((fact) => fact?.kind === "pending")
      ? packagedPending
      : null;
  if (!envelope || envelope.ok === false || !pending) {
    return { items: [], error: "unparseable_pending_output" };
  }
  const items: PendingInteraction[] = [];
  for (const raw of pending) {
    const mapped = mapRawItem(raw, source);
    if (mapped) {
      items.push(mapped);
    }
  }
  return { items };
}

export function loadPendingFromSources(
  sources: ResponsibilitySource[],
  exec: RunnerExec,
): { items: PendingInteraction[]; errors: Record<string, string> } {
  const items: PendingInteraction[] = [];
  const errors: Record<string, string> = {};
  for (const source of sources) {
    const res = loadPendingFromSource(source, exec);
    if (res.error) {
      errors[source.id] = res.error;
    }
    items.push(...res.items);
  }
  return { items, errors };
}

// --- Explicit action bridge ---------------------------------------------------
//
// The pending read command and an effect command deliberately have separate
// configuration. A source can never acquire provider-write behavior merely
// because someone sets dryRun=false: it must opt in with a reviewed argv.

export type AuthoritativeActionRequest = {
  action: "select_option" | "reject" | "change";
  interactionId: string;
  stateVersion: string;
  userMessageId: string;
  optionId?: string;
  reason?: string;
  requestedWindow?: string;
  // These are host-derived boundaries, not LLM arguments. The runner bridge
  // can independently reject them if its state no longer matches.
  authorization: {
    senderId: string;
    sessionKey: string;
    messageId: string;
  };
};

export type AuthoritativeActionExecution =
  | { ok: true; outcome: Record<string, unknown> }
  | { ok: false; error: ToolError };

function actionError(error: string, message: string): AuthoritativeActionExecution {
  return { ok: false, error: { ok: false, error, message } };
}

function actionRecordFromOutput(stdout: string | undefined): Record<string, unknown> | undefined {
  if (!stdout) {
    return undefined;
  }
  const parsed = parsePendingEnvelope(stdout);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const direct = parsed as Record<string, unknown>;
  const facts = Array.isArray(direct.facts) ? direct.facts : [];
  const fact = facts.find((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }
    const kind = (entry as { kind?: unknown }).kind;
    return kind === "action" || kind === "transaction" || kind === "result";
  }) as { payload?: unknown } | undefined;
  if (fact?.payload && typeof fact.payload === "object" && !Array.isArray(fact.payload)) {
    return fact.payload as Record<string, unknown>;
  }
  return direct;
}

function runnerErrorFromRecord(record: Record<string, unknown>): ToolError | undefined {
  if (record.ok !== false) {
    return undefined;
  }
  const error =
    typeof record.error === "string"
      ? record.error
      : typeof record.code === "string"
        ? record.code
        : "transaction_failed";
  const message =
    typeof record.message === "string" && record.message.trim()
      ? record.message.trim()
      : "The responsibility runner rejected this transaction before any success could be confirmed.";
  return { ok: false, error, message };
}

export function executeAuthoritativeAction(
  source: ResponsibilitySource,
  request: AuthoritativeActionRequest,
  exec: RunnerExec,
): AuthoritativeActionExecution {
  if (!source.actionCommand || source.actionCommand.length === 0) {
    return actionError(
      "source_unavailable",
      "This responsibility has no reviewed action bridge. No scheduling transaction was started.",
    );
  }

  let result: RunnerExecResult;
  try {
    result = exec({
      command: source.actionCommand,
      cwd: source.workspacePath,
      timeoutMs: source.actionTimeoutMs ?? source.timeoutMs,
      maxOutputBytes: source.maxOutputBytes,
      stdin: JSON.stringify(request),
    });
  } catch (err) {
    return actionError(
      "source_unavailable",
      `The responsibility action bridge could not start: ${(err as Error).message}`,
    );
  }

  if (result.truncated) {
    return actionError(
      "source_unavailable",
      "The responsibility action bridge returned truncated output; no success can be claimed.",
    );
  }

  const outcome = actionRecordFromOutput(result.stdout);
  if (outcome) {
    const runnerError = runnerErrorFromRecord(outcome);
    if (runnerError) {
      return { ok: false, error: runnerError };
    }
    return { ok: true, outcome };
  }

  return actionError(
    "source_unavailable",
    result.error
      ? `The responsibility action bridge failed: ${result.error}`
      : "The responsibility action bridge returned no typed transaction receipt.",
  );
}
