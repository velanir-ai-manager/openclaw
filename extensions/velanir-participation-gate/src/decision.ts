import { classifyParticipation } from "./classifier.js";
import type { ParticipationContextProvider } from "./context.js";
import type { ParticipationHistoryStore } from "./history.js";
import { messageText, threadHistoryText } from "./message.js";
import type {
  BeforeDispatchContext,
  BeforeDispatchEvent,
  ClassifierInput,
  ConversationHistoryMessage,
  CoworkerParticipationIdentity,
  ParticipationContext,
  ParticipationDecision,
  ParticipationGateConfig,
  RuntimeApi,
} from "./types.js";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Slack does not deliver "@Scott"; it delivers the encoded mention `<@U0B4ENP8GAF>`
// and the runtime appends the resolved display name as `(Scott Harper)`, or uses the
// inline label form `<@U0B4ENP8GAF|scott>`. None of those match the plain-text direct
// address patterns, so decode them to a readable `@Display Name` token first. A bare
// `<@ID>` with no resolvable name carries nothing matchable, so it is dropped.
export function decodeSlackMentions(content: string): string {
  return content
    .replace(/<@[A-Z0-9]+>\s*\(([^)]+)\)/gi, (_match, displayName: string) => `@${displayName}`)
    .replace(/<@[A-Z0-9]+\|([^>]+)>/gi, (_match, label: string) => `@${label}`)
    .replace(/<@[A-Z0-9]+>/gi, " ");
}

function namePattern(name: string): string | undefined {
  const trimmed = name.trim();
  if (trimmed.length < 2) {
    return undefined;
  }
  return escapeRegExp(trimmed).replace(/\s+/g, "\\s+");
}

function matchesAnyPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function buildDirectAddressPatterns(name: string): RegExp[] {
  const pattern = namePattern(name);
  if (!pattern) {
    return [];
  }
  const left = "(^|[^A-Za-z0-9_])";
  const right = "(?=$|[^A-Za-z0-9_])";
  const sentenceStart = "(^|[.!?][\\s\\n]+)";
  const requestAfterName = "(I\\s+(need|want|would\\s+like)\\s+you|we\\s+(need|want)\\s+you)";
  return [
    new RegExp(`${left}@${pattern}${right}`, "i"),
    new RegExp(`(^|[\\s\\n])${pattern}\\s*[:,]`, "i"),
    new RegExp(`${left}(hey|hi|hello|yo)\\s+${pattern}${right}`, "i"),
    new RegExp(`${sentenceStart}${pattern}\\s+${requestAfterName}${right}`, "i"),
    new RegExp(
      `${left}${pattern}\\s+(can|could|would|will|please|do|take|help|look|check|own|handle|review|summarize|find|send|create|update)${right}`,
      "i",
    ),
    new RegExp(`${left}(can|could|would|will)\\s+${pattern}\\s+`, "i"),
  ];
}

export function messageClearlyAddressesIdentity(
  content: string,
  identity: CoworkerParticipationIdentity,
): boolean {
  if (!content.trim()) {
    return false;
  }
  return identity.names.some((name) =>
    matchesAnyPattern(content, buildDirectAddressPatterns(name)),
  );
}

function messageClearlyAddressesAnotherCoworker(
  content: string,
  context: ParticipationContext,
): boolean {
  return context.coworkers.some((coworker) => messageClearlyAddressesIdentity(content, coworker));
}

function decision(
  shouldRespond: boolean,
  reason: ParticipationDecision["reason"],
  source: ParticipationDecision["source"],
  startedAt: number,
  error?: unknown,
  metadata?: Omit<
    ParticipationDecision,
    "shouldRespond" | "reason" | "source" | "latencyMs" | "error"
  >,
): ParticipationDecision {
  const message = error instanceof Error ? error.message : error ? String(error) : undefined;
  return {
    shouldRespond,
    reason,
    source,
    latencyMs: Date.now() - startedAt,
    ...(message ? { error: message } : {}),
    ...metadata,
  };
}

function messageIsThread(event: BeforeDispatchEvent, ctx: BeforeDispatchContext): boolean {
  const sessionKey = ctx.sessionKey ?? event.sessionKey ?? "";
  return Boolean(
    event.messageThreadId ||
    ctx.messageThreadId ||
    event.parentSessionKey ||
    ctx.parentSessionKey ||
    event.threadStarterBody ||
    threadHistoryText(event) ||
    sessionKey.includes(":thread:") ||
    sessionKey.includes("thread"),
  );
}

function normalizeInboundHistoryMessage(message: {
  role?: "user" | "assistant";
  senderId?: string;
  senderName?: string;
  sender?: string;
  content?: string;
  body?: string;
  timestamp?: number;
}): ConversationHistoryMessage | undefined {
  const content =
    typeof message.content === "string"
      ? message.content.trim()
      : typeof message.body === "string"
        ? message.body.trim()
        : "";
  if (!content) {
    return undefined;
  }
  const senderName = message.senderName ?? message.sender;
  return {
    ...(message.role ? { role: message.role } : {}),
    ...(message.senderId ? { senderId: message.senderId } : {}),
    ...(senderName ? { senderName } : {}),
    content,
    ...(message.timestamp !== undefined ? { timestamp: message.timestamp } : {}),
  };
}

function eventRecentMessages(
  event: BeforeDispatchEvent,
  maxMessages: number,
): ConversationHistoryMessage[] {
  if (!Array.isArray(event.inboundHistory) || maxMessages <= 0) {
    return [];
  }
  return event.inboundHistory
    .map(normalizeInboundHistoryMessage)
    .filter((message): message is ConversationHistoryMessage => Boolean(message))
    .slice(-maxMessages);
}

function mergeRecentMessages(params: {
  inboundHistory: ConversationHistoryMessage[];
  localHistory: ConversationHistoryMessage[];
  maxMessages: number;
}): ConversationHistoryMessage[] {
  if (params.inboundHistory.length === 0) {
    return params.localHistory;
  }

  const merged: ConversationHistoryMessage[] = [];
  const seen = new Set<string>();
  const messageKey = (message: ConversationHistoryMessage) =>
    [
      message.role ?? "user",
      message.senderId ?? "",
      message.senderName ?? "",
      message.timestamp ?? "",
      message.content,
    ].join("\u0000");

  for (const message of [...params.localHistory, ...params.inboundHistory]) {
    const key = messageKey(message);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(message);
  }

  const selectedKeys = new Set(merged.slice(-params.maxMessages).map(messageKey));
  const localAssistantKeys = params.localHistory
    .filter((message) => message.role === "assistant")
    .map(messageKey)
    .filter((key, index, keys) => keys.indexOf(key) === index)
    .slice(-params.maxMessages);

  for (const assistantKey of localAssistantKeys) {
    if (selectedKeys.has(assistantKey)) {
      continue;
    }
    const keyToDrop = merged
      .map(messageKey)
      .find((key) => selectedKeys.has(key) && !localAssistantKeys.includes(key));
    if (keyToDrop) {
      selectedKeys.delete(keyToDrop);
    }
    selectedKeys.add(assistantKey);
  }

  return merged.filter((message) => selectedKeys.has(messageKey(message)));
}

function buildClassifierInput(params: {
  context: ParticipationContext;
  event: BeforeDispatchEvent;
  ctx: BeforeDispatchContext;
  content: string;
  recentMessages: ConversationHistoryMessage[];
  maxMessages: number;
}): ClassifierInput {
  const inboundHistory = eventRecentMessages(params.event, params.maxMessages);
  const threadHistoryBody = threadHistoryText(params.event);
  return {
    context: params.context,
    conversation: {
      provider: params.event.provider ?? params.ctx.provider,
      surface: params.event.surface ?? params.ctx.surface,
      chatType:
        params.event.chatType ?? params.ctx.chatType ?? (params.event.isGroup ? "group" : "dm"),
      channelId: params.ctx.channelId ?? params.event.channel,
      conversationId: params.ctx.conversationId,
      conversationLabel: params.event.conversationLabel ?? params.ctx.conversationLabel,
      groupSubject: params.event.groupSubject ?? params.ctx.groupSubject,
      sessionKey: params.ctx.sessionKey ?? params.event.sessionKey,
      senderId: params.event.senderId ?? params.ctx.senderId,
      senderName: params.event.senderName ?? params.ctx.senderName,
      wasMentioned: params.event.wasMentioned ?? params.ctx.wasMentioned,
      isThread: messageIsThread(params.event, params.ctx),
      messageThreadId: params.event.messageThreadId ?? params.ctx.messageThreadId,
      parentSessionKey: params.event.parentSessionKey ?? params.ctx.parentSessionKey,
      threadLabel: params.event.threadLabel,
      isFirstThreadTurn: params.event.isFirstThreadTurn,
    },
    thread:
      params.event.threadStarterBody || threadHistoryBody
        ? {
            starterBody: params.event.threadStarterBody,
            historyBody: threadHistoryBody,
          }
        : undefined,
    recentMessages: mergeRecentMessages({
      inboundHistory,
      localHistory: params.recentMessages,
      maxMessages: params.maxMessages,
    }),
    currentMessage: {
      senderId: params.event.senderId ?? params.ctx.senderId,
      senderName: params.event.senderName ?? params.ctx.senderName,
      content: params.content,
      timestamp: params.event.timestamp,
    },
  };
}

export async function decideParticipation(params: {
  api: RuntimeApi;
  config: ParticipationGateConfig;
  event: BeforeDispatchEvent;
  ctx: BeforeDispatchContext;
  contextProvider: ParticipationContextProvider;
  history: ParticipationHistoryStore;
  classify?: typeof classifyParticipation;
}): Promise<ParticipationDecision> {
  const startedAt = Date.now();
  const classify = params.classify ?? classifyParticipation;

  if (params.event.isGroup !== true) {
    return decision(true, "dm", "rule", startedAt);
  }

  const content = decodeSlackMentions(messageText(params.event));
  if (!content.trim()) {
    return decision(true, "empty_message", "rule", startedAt);
  }

  const recentMessages = params.history.recent(
    params.event,
    params.ctx,
    params.config.context.maxMessages,
  );

  let context: ParticipationContext;
  try {
    context = await params.contextProvider.load();
  } catch (error) {
    params.history.recordInbound(params.event, params.ctx, params.config.context.maxMessages);
    return decision(true, "context_unavailable", "fallback", startedAt, error);
  }

  try {
    if (messageClearlyAddressesIdentity(content, context.self)) {
      return decision(true, "direct_address_self", "rule", startedAt);
    }

    if (messageClearlyAddressesAnotherCoworker(content, context)) {
      return decision(false, "direct_address_other_coworker", "rule", startedAt);
    }

    const classifierInput = buildClassifierInput({
      context,
      event: params.event,
      ctx: params.ctx,
      content,
      recentMessages,
      maxMessages: params.config.context.maxMessages,
    });

    const classifierDecision = await classify({
      api: params.api,
      config: params.config,
      input: classifierInput,
    });
    const classifierFields = {
      participationScore: classifierDecision.participationScore,
      threshold: params.config.classifier.threshold,
      classifierPromptVersion: classifierDecision.promptVersion,
      classifierPromptHash: classifierDecision.promptHash,
      classifierInputHash: classifierDecision.inputHash,
      classifierParseStatus: classifierDecision.parseStatus,
      classifierAttemptCount: classifierDecision.attempts.length,
      classifierOutputHash: classifierDecision.outputHash,
      classifierOutputLength: classifierDecision.outputLength,
      classifierParseError: classifierDecision.parseError,
      classifierRecentMessageCount: classifierInput.recentMessages.length,
      classifierRecentUserMessageCount: classifierInput.recentMessages.filter(
        (message) => message.role !== "assistant",
      ).length,
      classifierRecentAssistantMessageCount: classifierInput.recentMessages.filter(
        (message) => message.role === "assistant",
      ).length,
      classifierThreadContext: Boolean(
        classifierInput.thread?.starterBody || classifierInput.thread?.historyBody,
      ),
      classifierCurrentMessageLength: classifierInput.currentMessage.content.length,
      ...(params.config.logging.classifierDebug
        ? {
            classifierRawOutput: classifierDecision.rawOutput,
            classifierPrompt: classifierDecision.prompt,
            classifierInput,
            classifierAttempts: classifierDecision.attempts,
          }
        : {}),
    };

    if (classifierDecision.parseStatus === "malformed") {
      return decision(
        true,
        "classifier_malformed",
        "fallback",
        startedAt,
        undefined,
        classifierFields,
      );
    }

    const shouldRespond =
      classifierDecision.participationScore >= params.config.classifier.threshold;

    return decision(
      shouldRespond,
      shouldRespond ? "classifier_true" : "classifier_false",
      "classifier",
      startedAt,
      undefined,
      classifierFields,
    );
  } catch (error) {
    return decision(true, "classifier_error", "fallback", startedAt, error);
  } finally {
    params.history.recordInbound(params.event, params.ctx, params.config.context.maxMessages);
  }
}
