// Trusted inbound authorization. Binds each responsibility action tool call to
// exactly one fresh, trusted inbound message for the same user and session.
//
// The host records the trusted inbound identity from the `message_received`
// hook (never from model-controlled params). An action tool call may consume
// one authorization exactly once; a replayed message id, a session mismatch,
// or a user mismatch fails closed with a typed error.
//
// This module has NO OpenClaw imports so it runs under `node --test`.

import type { TurnScope } from "./types.js";

// Tools that require a trusted inbound authorization binding.
export const ACTION_TOOLS: ReadonlySet<string> = new Set([
  "responsibility_select_option",
  "responsibility_reject",
  "responsibility_change",
]);

export type TrustedInboundAuthorization = {
  messageId: string;
  senderId: string;
  sessionKey: string;
  runId?: string;
  channel?: string;
  accountId?: string;
  conversationId?: string;
  receivedAt: number;
};

export type InboundHookEvent = {
  messageId?: string;
  senderId?: string;
  from?: string;
  sessionKey?: string;
  runId?: string;
  channel?: string;
};

export type InboundHookContext = {
  messageId?: string;
  senderId?: string;
  sessionKey?: string;
  runId?: string;
  channelId?: string;
  accountId?: string;
  conversationId?: string;
};

export type ToolBindEvent = {
  toolName?: string;
  toolCallId?: string;
  runId?: string;
};

export type ToolBindContext = {
  toolName?: string;
  toolCallId?: string;
  runId?: string;
  sessionKey?: string;
};

export type AuthorizationConsumeError =
  | "missing_binding"
  | "message_replayed"
  | "session_mismatch"
  | "user_mismatch";

export type AuthorizationConsumeResult = {
  authorization: TrustedInboundAuthorization | null;
  error?: AuthorizationConsumeError;
};

function clean(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// Identity values arrive with provider route prefixes in some hooks
// ("user:yash@…", "msteams:user:yash@…") and bare in others. Strip known
// prefixes repeatedly and lowercase so the SAME person always compares equal.
export function cleanIdentity(value: unknown): string | undefined {
  const cleaned = clean(value);
  if (!cleaned) return undefined;
  let normalized = cleaned;
  for (;;) {
    const next = normalized.replace(/^(?:user|chat|channel|msteams):/i, "");
    if (next === normalized) return normalized.toLowerCase();
    normalized = next;
  }
}

export function trustedInboundFromHook(
  event: InboundHookEvent,
  ctx: InboundHookContext,
  receivedAt: number = Date.now(),
): TrustedInboundAuthorization | null {
  const messageId = clean(event.messageId) ?? clean(ctx.messageId);
  const senderId =
    cleanIdentity(event.senderId) ?? cleanIdentity(ctx.senderId) ?? cleanIdentity(event.from);
  const sessionKey = clean(event.sessionKey) ?? clean(ctx.sessionKey);
  const runId = clean(event.runId) ?? clean(ctx.runId);
  if (!messageId || !senderId || !sessionKey) return null;
  return {
    messageId,
    senderId,
    sessionKey,
    ...(runId ? { runId } : {}),
    ...((clean(event.channel) ?? clean(ctx.channelId))
      ? { channel: clean(event.channel) ?? clean(ctx.channelId) }
      : {}),
    ...(clean(ctx.accountId) ? { accountId: clean(ctx.accountId) } : {}),
    ...(clean(ctx.conversationId) ? { conversationId: clean(ctx.conversationId) } : {}),
    receivedAt,
  };
}

// Parse an authorization projected back from host-owned run/session state.
export function parseTrustedInboundAuthorization(
  value: unknown,
): TrustedInboundAuthorization | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const messageId = clean(record.messageId);
  const senderId = cleanIdentity(record.senderId);
  const sessionKey = clean(record.sessionKey);
  const receivedAt =
    typeof record.receivedAt === "number" && Number.isFinite(record.receivedAt)
      ? record.receivedAt
      : undefined;
  if (!messageId || !senderId || !sessionKey || receivedAt === undefined) return null;
  return {
    messageId,
    senderId,
    sessionKey,
    ...(clean(record.runId) ? { runId: clean(record.runId) } : {}),
    ...(clean(record.channel) ? { channel: clean(record.channel) } : {}),
    ...(clean(record.accountId) ? { accountId: clean(record.accountId) } : {}),
    ...(clean(record.conversationId) ? { conversationId: clean(record.conversationId) } : {}),
    receivedAt,
  };
}

export type InboundAuthorizationState = {
  byRun: Map<string, TrustedInboundAuthorization>;
  bySession: Map<string, TrustedInboundAuthorization>;
  byToolCall: Map<string, TrustedInboundAuthorization>;
  usedMessageIds: Map<string, number>;
};

export function createInboundAuthorizationState(): InboundAuthorizationState {
  return {
    byRun: new Map(),
    bySession: new Map(),
    byToolCall: new Map(),
    usedMessageIds: new Map(),
  };
}

// The gateway can load the plugin in more than one module realm; a
// globalThis-keyed state keeps one-use message semantics across realms.
export function sharedInboundAuthorizationState(): InboundAuthorizationState {
  const runtime = globalThis as {
    __velanirPendingContextAuthorizationV1?: InboundAuthorizationState;
  };
  runtime.__velanirPendingContextAuthorizationV1 ??= createInboundAuthorizationState();
  return runtime.__velanirPendingContextAuthorizationV1;
}

export type InboundAuthorizationStore = {
  recordTrusted(record: TrustedInboundAuthorization): boolean;
  recordInbound(event: InboundHookEvent, ctx: InboundHookContext): boolean;
  bindTool(event: ToolBindEvent, ctx: ToolBindContext): boolean;
  hasFreshBinding(scope: TurnScope, runId?: string): boolean;
  consumeDetailed(toolCallId: string, scope: TurnScope): AuthorizationConsumeResult;
  consume(toolCallId: string, scope: TurnScope): TrustedInboundAuthorization | null;
};

export function createInboundAuthorizationStore(
  ttlMs: number,
  now: () => number = Date.now,
  state: InboundAuthorizationState = createInboundAuthorizationState(),
): InboundAuthorizationStore {
  const { byRun, bySession, byToolCall, usedMessageIds } = state;

  const fresh = (
    record: TrustedInboundAuthorization | undefined,
  ): TrustedInboundAuthorization | undefined =>
    record && now() - record.receivedAt <= ttlMs ? record : undefined;

  const prune = (): void => {
    for (const [key, record] of byRun) if (!fresh(record)) byRun.delete(key);
    for (const [key, record] of bySession) if (!fresh(record)) bySession.delete(key);
    for (const [key, record] of byToolCall) if (!fresh(record)) byToolCall.delete(key);
    for (const [key, usedAt] of usedMessageIds)
      if (now() - usedAt > ttlMs) usedMessageIds.delete(key);
  };

  return {
    recordTrusted(record: TrustedInboundAuthorization): boolean {
      prune();
      if (!fresh(record)) return false;
      if (record.runId) byRun.set(record.runId, record);
      bySession.set(record.sessionKey, record);
      return true;
    },
    recordInbound(event: InboundHookEvent, ctx: InboundHookContext): boolean {
      prune();
      const record = trustedInboundFromHook(event, ctx, now());
      return record ? this.recordTrusted(record) : false;
    },
    bindTool(event: ToolBindEvent, ctx: ToolBindContext): boolean {
      prune();
      const toolName = clean(event.toolName) ?? clean(ctx.toolName);
      const toolCallId = clean(event.toolCallId) ?? clean(ctx.toolCallId);
      if (!toolName || !ACTION_TOOLS.has(toolName) || !toolCallId) return false;
      const runId = clean(event.runId) ?? clean(ctx.runId);
      const sessionKey = clean(ctx.sessionKey);
      const record =
        fresh(runId ? byRun.get(runId) : undefined) ??
        fresh(sessionKey ? bySession.get(sessionKey) : undefined);
      if (!record || (sessionKey && record.sessionKey !== sessionKey)) return false;
      byToolCall.set(toolCallId, record);
      return true;
    },
    hasFreshBinding(scope: TurnScope, runId?: string): boolean {
      prune();
      const record =
        fresh(runId ? byRun.get(runId) : undefined) ??
        fresh(scope.sessionKey ? bySession.get(scope.sessionKey) : undefined);
      if (!record || !scope.sessionKey || record.sessionKey !== scope.sessionKey) return false;
      if (!scope.userId || cleanIdentity(record.senderId) !== cleanIdentity(scope.userId))
        return false;
      return true;
    },
    consumeDetailed(toolCallId: string, scope: TurnScope): AuthorizationConsumeResult {
      prune();
      const record = fresh(byToolCall.get(toolCallId));
      byToolCall.delete(toolCallId);
      if (!record) {
        return { authorization: null, error: "missing_binding" };
      }
      if (usedMessageIds.has(record.messageId)) {
        return { authorization: null, error: "message_replayed" };
      }
      if (!scope.sessionKey || record.sessionKey !== scope.sessionKey) {
        return { authorization: null, error: "session_mismatch" };
      }
      if (!scope.userId || cleanIdentity(record.senderId) !== cleanIdentity(scope.userId)) {
        return { authorization: null, error: "user_mismatch" };
      }
      usedMessageIds.set(record.messageId, now());
      return { authorization: record };
    },
    consume(toolCallId: string, scope: TurnScope): TrustedInboundAuthorization | null {
      return this.consumeDetailed(toolCallId, scope).authorization;
    },
  };
}
