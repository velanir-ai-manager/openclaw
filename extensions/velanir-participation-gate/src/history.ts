import { messageText } from "./message.js";
import type {
  BeforeDispatchContext,
  BeforeDispatchEvent,
  ConversationHistoryMessage,
  MessageSentContext,
  MessageSentEvent,
} from "./types.js";

export type ParticipationHistoryStore = {
  recent: (
    event: BeforeDispatchEvent,
    ctx: BeforeDispatchContext,
    maxMessages: number,
  ) => ConversationHistoryMessage[];
  recordInbound: (
    event: BeforeDispatchEvent,
    ctx: BeforeDispatchContext,
    maxMessages: number,
  ) => boolean;
  recordOutbound: (
    event: MessageSentEvent,
    ctx: MessageSentContext,
    maxMessages: number,
  ) => boolean;
  record: (event: BeforeDispatchEvent, ctx: BeforeDispatchContext, maxMessages: number) => boolean;
};

type StoredMessage = ConversationHistoryMessage & { sequence: number };
type StoredMessageWithDedupe = StoredMessage & { dedupeKey?: string };

function normalizeKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  for (const prefix of ["conversation:", "channel:", "chat:", "user:"]) {
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length);
    }
  }
  return trimmed;
}

function stripTeamsMessageId(value: string): string {
  return value.replace(/;messageid=[^;]+/i, "");
}

function teamsThreadKey(
  conversationId: string | undefined,
  threadId: string | undefined,
): string | undefined {
  const normalizedConversationId = normalizeKey(conversationId);
  const normalizedThreadId = normalizeKey(threadId);
  if (!normalizedConversationId || !normalizedThreadId) {
    return undefined;
  }
  return `${stripTeamsMessageId(normalizedConversationId)};messageid=${normalizedThreadId}`;
}

function addKey(keys: string[], value: string | undefined) {
  const key = normalizeKey(value);
  if (key && !keys.includes(key)) {
    keys.push(key);
  }
}

function addTargetKeys(keys: string[], value: string | undefined) {
  const key = normalizeKey(value);
  if (!key) {
    return;
  }
  addKey(keys, key);
  const baseKey = stripTeamsMessageId(key);
  if (baseKey !== key) {
    addKey(keys, baseKey);
  }
}

function inboundKeys(event: BeforeDispatchEvent, ctx: BeforeDispatchContext): string[] {
  const keys: string[] = [];
  const conversationId = ctx.conversationId ?? event.channel ?? ctx.channelId;
  const threadId = event.messageThreadId ?? ctx.messageThreadId;

  addKey(keys, ctx.sessionKey);
  addKey(keys, event.sessionKey);
  addKey(keys, teamsThreadKey(conversationId, threadId));
  addKey(keys, ctx.parentSessionKey);
  addKey(keys, event.parentSessionKey);
  addTargetKeys(keys, conversationId);
  addTargetKeys(keys, event.channel);
  addTargetKeys(keys, ctx.channelId);

  return keys.length > 0 ? keys : ["unknown"];
}

function outboundKeys(event: MessageSentEvent, ctx: MessageSentContext): string[] {
  const keys: string[] = [];
  addKey(keys, ctx.sessionKey);
  addKey(keys, event.sessionKey);
  addTargetKeys(keys, event.to);
  addTargetKeys(keys, ctx.conversationId);
  addTargetKeys(keys, ctx.channelId);
  return keys.length > 0 ? keys : ["unknown"];
}

function publicMessages(
  messages: StoredMessageWithDedupe[],
  maxMessages: number,
): ConversationHistoryMessage[] {
  return messages
    .toSorted((left, right) => left.sequence - right.sequence)
    .slice(-maxMessages)
    .map(({ sequence: _sequence, dedupeKey: _dedupeKey, ...message }) => message);
}

function outboundDedupeKey(
  event: MessageSentEvent,
  ctx: MessageSentContext,
  content: string,
): string {
  const primaryKey = outboundKeys(event, ctx)[0];
  if (primaryKey && primaryKey !== "unknown") {
    return ["conversation", primaryKey, content].join("\u0000");
  }
  if (event.runId) {
    return ["run", event.runId, content].join("\u0000");
  }
  return ["message", event.messageId ?? "", event.to ?? "", content].join("\u0000");
}

export function createParticipationHistoryStore(): ParticipationHistoryStore {
  const messagesByConversation = new Map<string, StoredMessageWithDedupe[]>();
  let nextSequence = 1;

  function recordForKeys(
    keys: string[],
    message: Omit<ConversationHistoryMessage, "content"> & { content: string },
    maxMessages: number,
    dedupeKey?: string,
  ): boolean {
    if (dedupeKey) {
      for (const key of keys) {
        const current = messagesByConversation.get(key) ?? [];
        if (current.some((entry) => entry.dedupeKey === dedupeKey)) {
          return false;
        }
      }
    }

    const stored: StoredMessageWithDedupe = {
      ...message,
      sequence: nextSequence,
      ...(dedupeKey ? { dedupeKey } : {}),
    };
    nextSequence += 1;

    for (const key of keys) {
      const current = messagesByConversation.get(key) ?? [];
      current.push(stored);
      if (current.length > maxMessages) {
        current.splice(0, current.length - maxMessages);
      }
      messagesByConversation.set(key, current);
    }
    return true;
  }

  function recordInbound(
    event: BeforeDispatchEvent,
    ctx: BeforeDispatchContext,
    maxMessages: number,
  ): boolean {
    if (maxMessages <= 0 || event.isGroup !== true) {
      return false;
    }
    const content = messageText(event);
    if (!content) {
      return false;
    }
    return recordForKeys(
      inboundKeys(event, ctx),
      {
        role: "user",
        senderId: event.senderId ?? ctx.senderId,
        senderName: event.senderName ?? ctx.senderName,
        content,
        timestamp: event.timestamp,
      },
      maxMessages,
    );
  }

  return {
    recent(event, ctx, maxMessages) {
      if (maxMessages <= 0) {
        return [];
      }
      const seen = new Set<StoredMessageWithDedupe>();
      const messages: StoredMessageWithDedupe[] = [];
      for (const key of inboundKeys(event, ctx)) {
        for (const message of messagesByConversation.get(key) ?? []) {
          if (!seen.has(message)) {
            seen.add(message);
            messages.push(message);
          }
        }
      }
      return publicMessages(messages, maxMessages);
    },

    recordInbound,

    recordOutbound(event, ctx, maxMessages) {
      if (maxMessages <= 0 || event.success !== true) {
        return false;
      }
      const content = event.content?.trim();
      if (!content) {
        return false;
      }
      return recordForKeys(
        outboundKeys(event, ctx),
        {
          role: "assistant",
          senderId: "self",
          senderName: "This coworker",
          content,
        },
        maxMessages,
        outboundDedupeKey(event, ctx, content),
      );
    },

    record(event, ctx, maxMessages) {
      return recordInbound(event, ctx, maxMessages);
    },
  };
}
