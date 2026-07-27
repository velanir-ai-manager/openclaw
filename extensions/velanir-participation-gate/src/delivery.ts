import type {
  BeforeDispatchContext,
  BeforeDispatchEvent,
  BeforeToolCallContext,
  DeliveryConfig,
  DeliveryDecision,
  DeliveryRoute,
  DeliverySendCandidate,
  MessageSendingContext,
  ReplyPayload,
  ReplyPayloadSendingContext,
  ReplyPayloadSendingEvent,
  TurnDeliveryState,
  TurnDeliveryStore,
} from "./types.js";

/**
 * Turn-delivery coalescer state.
 *
 * A "turn" is one tracked inbound conversation turn (keyed by exact session or
 * conversation). While a turn is active and delivery.mode is "coalesce":
 * - non-final reply payloads are suppressed,
 * - exactly one final reply payload is admitted,
 * - duplicate finals (per turn and per runId) are cancelled,
 * - same-conversation message-tool sends are blocked before execution, and
 * - direct outbound message egress for the conversation is only allowed when it
 *   corresponds to the final payload the coalescer already admitted.
 */
export function createTurnDeliveryState(): TurnDeliveryState {
  return {
    turns: new Map(),
    deliveredRuns: new Map(),
  };
}

type DeliveryStateGlobal = typeof globalThis & {
  __velanirParticipationGateDeliveryV1?: TurnDeliveryState;
};

/**
 * OpenClaw can register plugin entry points more than once in a gateway
 * lifetime (for example a config reload). Delivery state must survive that so
 * duplicate-final protection cannot be reset mid-turn.
 */
export function sharedTurnDeliveryState(): TurnDeliveryState {
  const runtime = globalThis as DeliveryStateGlobal;
  runtime.__velanirParticipationGateDeliveryV1 ??= createTurnDeliveryState();
  return runtime.__velanirParticipationGateDeliveryV1;
}

function clean(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalized(value: unknown): string | undefined {
  return clean(value)?.toLowerCase();
}

function scopedKey(prefix: string, ...values: unknown[]): string | undefined {
  const parts = values.map(clean);
  return parts.every(Boolean) ? `${prefix}:${parts.join(":")}` : undefined;
}

/**
 * Reduce a send target to a comparable conversation identity. Strips provider
 * target prefixes (`msteams:conversation:`, `conversation:`, `user:`,
 * `channel:`) and a trailing Teams `;messageid=` thread suffix.
 */
function normalizedTarget(value: unknown): string | undefined {
  const target = normalized(value);
  if (!target) return undefined;
  return target
    .replace(/^msteams:conversation:/, "")
    .replace(/^(?:conversation|user|channel):/, "")
    .split(";messageid=", 1)[0];
}

function routeProvider(route: DeliveryRoute): string | undefined {
  return normalized(route.provider);
}

function targetMatchesRoute(target: string | undefined, route: DeliveryRoute): boolean {
  const candidate = normalizedTarget(target);
  // A send without a resolvable target cannot be proven unrelated to the
  // active conversation, so it is treated as same-conversation.
  if (!candidate) return true;
  return [route.conversationId, route.channelId, route.senderId].some(
    (value) => normalizedTarget(value) === candidate,
  );
}

export function deliveryRouteForInbound(
  event: BeforeDispatchEvent,
  ctx: BeforeDispatchContext,
): DeliveryRoute {
  return {
    provider:
      clean(ctx.provider) ?? clean(event.provider) ?? clean(event.surface) ?? clean(event.channel),
    conversationId: clean(ctx.conversationId),
    channelId: clean(ctx.channelId) ?? clean(event.channel),
    senderId: clean(ctx.senderId) ?? clean(event.senderId),
  };
}

export function deliveryScopeForInbound(
  event: BeforeDispatchEvent,
  ctx: BeforeDispatchContext,
): string | undefined {
  const sessionKey = clean(ctx.sessionKey) ?? clean(event.sessionKey);
  if (sessionKey) return `session:${sessionKey}`;
  const provider = clean(ctx.provider) ?? clean(event.provider) ?? clean(event.surface);
  const conversationId = clean(ctx.conversationId);
  if (provider && conversationId) {
    return scopedKey("conversation", provider, conversationId);
  }
  const channelId = clean(ctx.channelId) ?? clean(event.channel);
  return scopedKey("channel", provider, channelId);
}

function deliveryScopeForReply(
  event: ReplyPayloadSendingEvent,
  ctx: ReplyPayloadSendingContext,
): string | undefined {
  const sessionKey = clean(ctx.sessionKey) ?? clean(event.sessionKey);
  if (sessionKey) return `session:${sessionKey}`;
  const provider = clean(event.channel);
  const conversationId = clean(ctx.conversationId);
  if (provider && conversationId) {
    return scopedKey("conversation", provider, conversationId);
  }
  return scopedKey("channel", provider, ctx.channelId);
}

export function deliveryScopeForTool(ctx: BeforeToolCallContext): string | undefined {
  const sessionKey = clean(ctx.sessionKey);
  return sessionKey ? `session:${sessionKey}` : undefined;
}

export function deliveryScopeForMessage(ctx: MessageSendingContext): string | undefined {
  const sessionKey = clean(ctx.sessionKey);
  if (sessionKey) return `session:${sessionKey}`;
  return scopedKey("channel", ctx.channelId, ctx.conversationId);
}

export function createTurnDeliveryStore(
  config: DeliveryConfig,
  now: () => number = Date.now,
  state: TurnDeliveryState = createTurnDeliveryState(),
): TurnDeliveryStore {
  const { turns, deliveredRuns } = state;

  const prune = () => {
    const current = now();
    for (const [scope, turn] of turns) {
      if (current - turn.updatedAt > config.turnTtlMs) {
        turns.delete(scope);
      }
    }
    for (const [runId, deliveredAt] of deliveredRuns) {
      if (current - deliveredAt > config.turnTtlMs) {
        deliveredRuns.delete(runId);
      }
    }
  };

  return {
    beginTurn(scope: string | undefined, route: DeliveryRoute = {}): boolean {
      prune();
      if (!scope) return false;
      const timestamp = now();
      turns.set(scope, {
        startedAt: timestamp,
        updatedAt: timestamp,
        finalDelivered: false,
        finalEgressPending: false,
        progressMessages: 0,
        route,
      });
      return true;
    },
    abandonTurn(scope: string | undefined): boolean {
      prune();
      return scope ? turns.delete(scope) : false;
    },
    decide(event: ReplyPayloadSendingEvent, ctx: ReplyPayloadSendingContext): DeliveryDecision {
      prune();
      const scope = deliveryScopeForReply(event, ctx);
      const turn = scope ? turns.get(scope) : undefined;
      const runId = clean(event.runId) ?? clean(ctx.runId);
      if (runId && deliveredRuns.has(runId)) {
        return {
          action: "suppress_duplicate_final",
          result: {
            cancel: true,
            reason: "participation_gate_duplicate_final",
          },
        };
      }
      if (!turn) {
        return { action: "allow_untracked" };
      }
      const timestamp = now();
      turn.updatedAt = timestamp;
      const isFinal = event.kind === undefined || event.kind === "final";
      if (isFinal) {
        if (turn.finalDelivered) {
          return {
            action: "suppress_duplicate_final",
            result: {
              cancel: true,
              reason: "participation_gate_duplicate_final",
            },
          };
        }
        turn.finalDelivered = true;
        turn.finalEgressPending = true;
        if (runId) deliveredRuns.set(runId, timestamp);
        return { action: "allow_final" };
      }
      const canSendProgress =
        !turn.finalDelivered &&
        timestamp - turn.startedAt >= config.quietWindowMs &&
        turn.progressMessages < config.maxProgressMessages;
      if (canSendProgress) {
        turn.progressMessages += 1;
        const sourcePayload = event.payload as ReplyPayload | undefined;
        return {
          action: "allow_progress",
          result: {
            payload: {
              text: config.progressText,
              isStatusNotice: true,
              ...(sourcePayload?.replyToId ? { replyToId: sourcePayload.replyToId } : {}),
              ...(sourcePayload?.replyToTag === true ? { replyToTag: true } : {}),
              ...(sourcePayload?.replyToCurrent === true ? { replyToCurrent: true } : {}),
            },
          },
        };
      }
      return {
        action: "suppress_intermediate",
        result: {
          cancel: true,
          reason: "participation_gate_suppressed_intermediate",
        },
      };
    },
    isSameConversationSend(scope: string | undefined, send: DeliverySendCandidate): boolean {
      prune();
      if (!scope) return false;
      const turn = turns.get(scope);
      if (!turn) return false;
      const expectedProvider = routeProvider(turn.route);
      const actualProvider = normalized(send.provider);
      if (expectedProvider && actualProvider && expectedProvider !== actualProvider) {
        return false;
      }
      return targetMatchesRoute(send.target, turn.route);
    },
    consumeFinalEgress(scope: string | undefined): boolean {
      prune();
      if (!scope) return false;
      const turn = turns.get(scope);
      if (!turn?.finalEgressPending) return false;
      turn.finalEgressPending = false;
      turn.updatedAt = now();
      return true;
    },
    activeTurnCount(): number {
      prune();
      return turns.size;
    },
  };
}
