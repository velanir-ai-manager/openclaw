import type { PluginLogger } from "./api.js";
import { messageText } from "./message.js";
import type {
  BeforeDispatchContext,
  BeforeDispatchEvent,
  ParticipationDecision,
  ParticipationGateConfig,
} from "./types.js";

function eventContent(event: BeforeDispatchEvent): string {
  return messageText(event);
}

function field(name: string, value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return `${name}=${String(value)}`;
}

function scoreField(value: number | undefined): string | undefined {
  return typeof value === "number" ? value.toFixed(3) : undefined;
}

function contentLoggingEnabled(config: ParticipationGateConfig): boolean {
  return config.logging.includeContent === true;
}

export function logParticipationDecision(params: {
  logger?: PluginLogger;
  config: ParticipationGateConfig;
  decision: ParticipationDecision;
  event: BeforeDispatchEvent;
  ctx: BeforeDispatchContext;
}): void {
  if (!params.config.logging.decisions) {
    return;
  }
  const outcome = params.decision.shouldRespond
    ? "respond"
    : params.config.mode === "enforce"
      ? "skip"
      : "would_skip";
  const parts = [
    "velanir-participation-gate:",
    field("mode", params.config.mode),
    field("outcome", outcome),
    field("reason", params.decision.reason),
    field("source", params.decision.source),
    field("channel", params.ctx.channelId ?? params.event.channel),
    field("conversation", params.ctx.conversationId),
    field("session", params.ctx.sessionKey ?? params.event.sessionKey),
    field("sender", params.event.senderId ?? params.ctx.senderId),
    field("latencyMs", params.decision.latencyMs),
    field("provider", params.config.classifier.provider),
    field("model", params.config.classifier.model),
    field("score", scoreField(params.decision.participationScore)),
    field("threshold", scoreField(params.decision.threshold)),
    field("promptVersion", params.decision.classifierPromptVersion),
    field("promptHash", params.decision.classifierPromptHash),
    field("inputHash", params.decision.classifierInputHash),
    field("parseStatus", params.decision.classifierParseStatus),
    field("attemptCount", params.decision.classifierAttemptCount),
    field("outputHash", params.decision.classifierOutputHash),
    field("outputLength", params.decision.classifierOutputLength),
    field("recentMessages", params.decision.classifierRecentMessageCount),
    field("recentUserMessages", params.decision.classifierRecentUserMessageCount),
    field("recentAssistantMessages", params.decision.classifierRecentAssistantMessageCount),
    field("threadContext", params.decision.classifierThreadContext),
    field("currentLength", params.decision.classifierCurrentMessageLength),
    contentLoggingEnabled(params.config)
      ? field("parseError", params.decision.classifierParseError)
      : undefined,
    field("error", params.decision.error),
    contentLoggingEnabled(params.config)
      ? field("content", JSON.stringify(eventContent(params.event)))
      : undefined,
  ].filter((entry): entry is string => Boolean(entry));

  params.logger?.info?.(parts.join(" "));

  if (
    params.config.logging.classifierDebug &&
    (params.decision.source === "classifier" || params.decision.classifierAttempts)
  ) {
    const record: Record<string, unknown> = {
      promptVersion: params.decision.classifierPromptVersion,
      promptHash: params.decision.classifierPromptHash,
      inputHash: params.decision.classifierInputHash,
      provider: params.config.classifier.provider,
      model: params.config.classifier.model,
      score: params.decision.participationScore,
      threshold: params.decision.threshold,
      parseStatus: params.decision.classifierParseStatus,
      attemptCount: params.decision.classifierAttemptCount,
      outputHash: params.decision.classifierOutputHash,
      outputLength: params.decision.classifierOutputLength,
      recentMessages: params.decision.classifierRecentMessageCount,
      recentUserMessages: params.decision.classifierRecentUserMessageCount,
      recentAssistantMessages: params.decision.classifierRecentAssistantMessageCount,
      threadContext: params.decision.classifierThreadContext,
      currentMessageLength: params.decision.classifierCurrentMessageLength,
      outcome,
    };
    if (params.decision.classifierAttempts) {
      record.attempts = params.decision.classifierAttempts.map((attempt) => ({
        attempt: attempt.attempt,
        promptHash: attempt.promptHash,
        outputHash: attempt.outputHash,
        outputLength: attempt.outputLength,
        parseStatus: attempt.parseStatus,
        ...(contentLoggingEnabled(params.config)
          ? {
              parseError: attempt.parseError,
              prompt: attempt.prompt,
              rawOutput: attempt.rawOutput,
            }
          : {}),
      }));
    }
    if (contentLoggingEnabled(params.config)) {
      record.parseError = params.decision.classifierParseError;
      record.prompt = params.decision.classifierPrompt;
      record.input = params.decision.classifierInput;
      record.rawOutput = params.decision.classifierRawOutput;
    }
    params.logger?.info?.(`velanir-participation-gate-classifier-debug: ${JSON.stringify(record)}`);
  }
}

export function logParticipationHistoryEvent(params: {
  logger?: PluginLogger;
  config: ParticipationGateConfig;
  event: string;
  fields: Record<string, unknown>;
  content?: string;
}): void {
  if (!params.config.logging.decisions) {
    return;
  }
  const parts = [
    "velanir-participation-gate-history:",
    field("event", params.event),
    ...Object.entries(params.fields).map(([name, value]) => field(name, value)),
    contentLoggingEnabled(params.config)
      ? field("content", JSON.stringify(params.content ?? ""))
      : undefined,
  ].filter((entry): entry is string => Boolean(entry));

  params.logger?.info?.(parts.join(" "));
}
