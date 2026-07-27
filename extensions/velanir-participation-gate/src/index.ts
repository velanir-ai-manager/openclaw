import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { normalizeConfig } from "./config.js";
import { createParticipationContextProvider } from "./context.js";
import { decideParticipation } from "./decision.js";
import {
  createTurnDeliveryStore,
  deliveryRouteForInbound,
  deliveryScopeForInbound,
  deliveryScopeForMessage,
  deliveryScopeForTool,
  sharedTurnDeliveryState,
} from "./delivery.js";
import { createParticipationHistoryStore } from "./history.js";
import { logParticipationDecision, logParticipationHistoryEvent } from "./logging.js";
import { messageText } from "./message.js";
import type {
  BeforeDispatchContext,
  BeforeDispatchEvent,
  BeforeToolCallContext,
  BeforeToolCallEvent,
  DeliverySendCandidate,
  MessageSendingContext,
  MessageSendingEvent,
  MessageSentContext,
  MessageSentEvent,
  ReplyPayloadSendingContext,
  ReplyPayloadSendingEvent,
  RuntimeApi,
} from "./types.js";

export const PLUGIN_ID = "velanir-participation-gate";
// Egress guard uses -100000 as the final outbound boundary; capture after it.
const POST_EGRESS_REPLY_CAPTURE_PRIORITY = -100_001;
// Delivery decisions must run before the egress guard and any default handlers.
const PRE_EGRESS_DELIVERY_PRIORITY = 100_000;
const SAME_CONVERSATION_MESSAGE_BLOCK_REASON =
  "Use the normal final reply for this conversation. Direct message sends to the active conversation are blocked.";

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Extract the send candidate from a `message` tool call, if it is one. */
function messageToolSend(event: BeforeToolCallEvent): DeliverySendCandidate | undefined {
  if (event.toolName.trim().toLowerCase() !== "message") return undefined;
  const action = stringValue(event.params.action)?.toLowerCase();
  if (action !== "send") return undefined;
  return {
    provider: stringValue(event.params.provider) ?? stringValue(event.params.channel),
    target:
      stringValue(event.params.to) ??
      stringValue(event.params.target) ??
      stringValue(event.params.recipient) ??
      stringValue(event.params.conversationId),
  };
}

function replyPayloadContent(event: ReplyPayloadSendingEvent): string | undefined {
  const text = event.payload?.text;
  if (typeof text !== "string") {
    return undefined;
  }
  const trimmed = text.trim();
  return trimmed || undefined;
}

function messageSentEventFromReplyPayload(
  event: ReplyPayloadSendingEvent,
  ctx: ReplyPayloadSendingContext,
  content: string,
): MessageSentEvent {
  return {
    to: ctx.conversationId ?? ctx.channelId ?? event.channel,
    content,
    success: true,
    sessionKey: event.sessionKey ?? ctx.sessionKey,
    runId: event.runId ?? ctx.runId,
  };
}

function messageSentContextFromReplyPayload(
  event: ReplyPayloadSendingEvent,
  ctx: ReplyPayloadSendingContext,
): MessageSentContext {
  return {
    ...ctx,
    ...(event.channel && !ctx.channelId ? { channelId: event.channel } : {}),
    ...(event.sessionKey && !ctx.sessionKey ? { sessionKey: event.sessionKey } : {}),
    ...(event.runId && !ctx.runId ? { runId: event.runId } : {}),
  };
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Velanir Participation Gate",
  description:
    "Decides whether a digital coworker should respond in group and channel conversations before the main agent runs.",
  register(api: OpenClawPluginApi) {
    const runtimeApi = api as RuntimeApi;
    const config = normalizeConfig(runtimeApi.pluginConfig);
    const contextProvider = createParticipationContextProvider(config);
    const history = createParticipationHistoryStore();
    const deliveries = createTurnDeliveryStore(
      config.delivery,
      Date.now,
      sharedTurnDeliveryState(),
    );

    const beginDeliveryTurn = (event: BeforeDispatchEvent, ctx: BeforeDispatchContext) => {
      if (config.delivery.mode !== "coalesce") return;
      const tracked = deliveries.beginTurn(
        deliveryScopeForInbound(event, ctx),
        deliveryRouteForInbound(event, ctx),
      );
      runtimeApi.logger?.info?.(
        `[${PLUGIN_ID}-delivery] action=begin_turn tracked=${tracked} active=${deliveries.activeTurnCount()}`,
      );
    };

    api.on(
      "before_dispatch",
      async (event, ctx) => {
        const beforeDispatchEvent = event as BeforeDispatchEvent;
        const beforeDispatchContext = ctx as BeforeDispatchContext;
        if (
          beforeDispatchEvent.wasMentioned === true ||
          beforeDispatchContext.wasMentioned === true
        ) {
          beginDeliveryTurn(beforeDispatchEvent, beforeDispatchContext);
          const recorded = history.recordInbound(
            beforeDispatchEvent,
            beforeDispatchContext,
            config.context.maxMessages,
          );
          logParticipationHistoryEvent({
            logger: runtimeApi.logger,
            config,
            event: "mention_bypass_inbound",
            fields: {
              recorded,
              provider: beforeDispatchEvent.provider ?? beforeDispatchContext.provider,
              channel: beforeDispatchContext.channelId ?? beforeDispatchEvent.channel,
              conversation: beforeDispatchContext.conversationId,
              session: beforeDispatchContext.sessionKey ?? beforeDispatchEvent.sessionKey,
              thread: beforeDispatchEvent.messageThreadId ?? beforeDispatchContext.messageThreadId,
              sender: beforeDispatchEvent.senderId ?? beforeDispatchContext.senderId,
            },
            content: messageText(beforeDispatchEvent),
          });
          return undefined;
        }

        const decision = await decideParticipation({
          api: runtimeApi,
          config,
          event: beforeDispatchEvent,
          ctx: beforeDispatchContext,
          contextProvider,
          history,
        });

        logParticipationDecision({
          logger: runtimeApi.logger,
          config,
          decision,
          event: beforeDispatchEvent,
          ctx: beforeDispatchContext,
        });

        if (!decision.shouldRespond && config.mode === "enforce") {
          return { handled: true };
        }
        beginDeliveryTurn(beforeDispatchEvent, beforeDispatchContext);
        return undefined;
      },
      { timeoutMs: config.classifier.timeoutMs + 2_000 },
    );

    api.on(
      "before_tool_call",
      (event, ctx) => {
        if (config.delivery.mode !== "coalesce") return undefined;
        const beforeToolCallEvent = event as BeforeToolCallEvent;
        const send = messageToolSend(beforeToolCallEvent);
        if (!send) return undefined;
        const beforeToolCallContext = ctx as BeforeToolCallContext;
        const blocked = deliveries.isSameConversationSend(
          deliveryScopeForTool(beforeToolCallContext),
          send,
        );
        if (!blocked) return undefined;
        runtimeApi.logger?.info?.(
          `[${PLUGIN_ID}-delivery] action=block_same_conversation_message_tool run=${
            beforeToolCallEvent.runId ?? beforeToolCallContext.runId ?? "unknown"
          } toolCall=${beforeToolCallEvent.toolCallId ?? beforeToolCallContext.toolCallId ?? "unknown"}`,
        );
        return {
          block: true,
          blockReason: SAME_CONVERSATION_MESSAGE_BLOCK_REASON,
        };
      },
      { priority: PRE_EGRESS_DELIVERY_PRIORITY },
    );

    api.on(
      "message_sending",
      (event, ctx) => {
        if (config.delivery.mode !== "coalesce") return undefined;
        const messageSendingEvent = event as MessageSendingEvent;
        const messageSendingContext = ctx as MessageSendingContext;
        const scope = deliveryScopeForMessage(messageSendingContext);
        const sameConversation = deliveries.isSameConversationSend(scope, {
          provider: messageSendingEvent.metadata?.channel,
          target: messageSendingContext.conversationId ?? messageSendingEvent.to,
        });
        if (!sameConversation) return undefined;
        if (deliveries.consumeFinalEgress(scope)) {
          runtimeApi.logger?.info?.(`[${PLUGIN_ID}-delivery] action=allow_final_message_egress`);
          return undefined;
        }
        runtimeApi.logger?.info?.(
          `[${PLUGIN_ID}-delivery] action=suppress_same_conversation_message_egress`,
        );
        return {
          cancel: true,
          cancelReason: "participation_gate_suppressed_same_conversation_message",
        };
      },
      { priority: PRE_EGRESS_DELIVERY_PRIORITY },
    );

    api.on("message_sent", (event, ctx) => {
      const messageSentEvent = event as MessageSentEvent;
      const messageSentContext = ctx as MessageSentContext;
      const recorded = history.recordOutbound(
        messageSentEvent,
        messageSentContext,
        config.context.maxMessages,
      );
      logParticipationHistoryEvent({
        logger: runtimeApi.logger,
        config,
        event: "message_sent_outbound",
        fields: {
          recorded,
          success: messageSentEvent.success,
          channel: messageSentContext.channelId,
          conversation: messageSentContext.conversationId ?? messageSentEvent.to,
          session: messageSentContext.sessionKey ?? messageSentEvent.sessionKey,
          messageId: messageSentEvent.messageId ?? messageSentContext.messageId,
        },
        content: messageSentEvent.content,
      });
      return undefined;
    });

    api.on(
      "reply_payload_sending",
      (event, ctx) => {
        if (config.delivery.mode !== "coalesce") return undefined;
        const decision = deliveries.decide(
          event as ReplyPayloadSendingEvent,
          ctx as ReplyPayloadSendingContext,
        );
        runtimeApi.logger?.info?.(
          `[${PLUGIN_ID}-delivery] action=${decision.action} kind=${
            (event as ReplyPayloadSendingEvent).kind ?? "legacy_final"
          }`,
        );
        return decision.result;
      },
      { priority: PRE_EGRESS_DELIVERY_PRIORITY },
    );

    api.on(
      "reply_payload_sending",
      (event, ctx) => {
        const replyEvent = event as ReplyPayloadSendingEvent;
        if (replyEvent.kind !== undefined && replyEvent.kind !== "final") {
          return undefined;
        }

        const content = replyPayloadContent(replyEvent);
        if (!content) {
          return undefined;
        }

        const replyContext = ctx as ReplyPayloadSendingContext;
        const messageSentEvent = messageSentEventFromReplyPayload(
          replyEvent,
          replyContext,
          content,
        );
        const messageSentContext = messageSentContextFromReplyPayload(replyEvent, replyContext);
        const recorded = history.recordOutbound(
          messageSentEvent,
          messageSentContext,
          config.context.maxMessages,
        );
        logParticipationHistoryEvent({
          logger: runtimeApi.logger,
          config,
          event: "reply_payload_outbound",
          fields: {
            recorded,
            kind: replyEvent.kind,
            channel: messageSentContext.channelId,
            conversation: messageSentContext.conversationId ?? messageSentEvent.to,
            session: messageSentContext.sessionKey ?? messageSentEvent.sessionKey,
            runId: messageSentEvent.runId,
          },
          content,
        });
        return undefined;
      },
      { priority: POST_EGRESS_REPLY_CAPTURE_PRIORITY },
    );
  },
});
