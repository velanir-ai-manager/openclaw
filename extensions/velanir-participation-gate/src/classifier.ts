import { createHash } from "node:crypto";
import { runEmbeddedClassifierModel } from "./embedded-model.js";
import type {
  ClassifierAttemptResult,
  ClassifierDecisionResult,
  ClassifierInput,
  ClassifierParseStatus,
  ConversationHistoryMessage,
  CoworkerParticipationIdentity,
  ParticipationContext,
  ParticipationGateConfig,
  RuntimeApi,
} from "./types.js";

export const CLASSIFIER_PROMPT_VERSION = "participation-score-v2";

function stripCodeFences(value: string): string {
  const trimmed = value.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return (match?.[1] ?? trimmed).trim();
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function trimForPrompt(value: string, maxLength = 1_200): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function formatIdentity(identity: CoworkerParticipationIdentity): string {
  const role = identity.roleSummary ? ` Role: ${identity.roleSummary}` : "";
  return `- ${identity.names.join(", ")}.${role}`;
}

function buildContextSection(context: ParticipationContext): string {
  const coworkers = context.coworkers.length
    ? context.coworkers.map(formatIdentity).join("\n")
    : "- None known.";
  return [
    "This digital coworker:",
    formatIdentity(context.self),
    "",
    "Other digital coworkers in this organization:",
    coworkers,
  ].join("\n");
}

function formatFact(name: string, value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const text =
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
      ? String(value)
      : JSON.stringify(value);
  return text === undefined ? undefined : `- ${name}: ${text}`;
}

function buildConversationSection(input: ClassifierInput): string {
  const facts = [
    formatFact("provider", input.conversation.provider),
    formatFact("surface", input.conversation.surface),
    formatFact("chatType", input.conversation.chatType),
    formatFact("channelId", input.conversation.channelId),
    formatFact("conversationId", input.conversation.conversationId),
    formatFact("conversationLabel", input.conversation.conversationLabel),
    formatFact("groupSubject", input.conversation.groupSubject),
    formatFact("sessionKey", input.conversation.sessionKey),
    formatFact("senderName", input.conversation.senderName),
    formatFact("senderId", input.conversation.senderId),
    formatFact("wasMentioned", input.conversation.wasMentioned),
    formatFact("isThread", input.conversation.isThread),
    formatFact("messageThreadId", input.conversation.messageThreadId),
    formatFact("parentSessionKey", input.conversation.parentSessionKey),
    formatFact("threadLabel", input.conversation.threadLabel),
    formatFact("isFirstThreadTurn", input.conversation.isFirstThreadTurn),
  ].filter((entry): entry is string => Boolean(entry));
  return `Conversation facts:\n${facts.length ? facts.join("\n") : "- None available."}`;
}

function buildThreadSection(input: ClassifierInput): string {
  const starter = input.thread?.starterBody ? trimForPrompt(input.thread.starterBody) : undefined;
  const history = input.thread?.historyBody
    ? trimForPrompt(input.thread.historyBody, 1_800)
    : undefined;
  if (!starter && !history) {
    return "Thread context:\n- No thread context available.";
  }
  return [
    "Thread context:",
    starter ? `- Starter: ${starter}` : undefined,
    history ? `- Recent thread history: ${history}` : undefined,
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join("\n");
}

function formatHistoryMessage(message: ConversationHistoryMessage): string {
  const sender = message.senderName ?? message.senderId ?? "unknown";
  const role = message.role === "assistant" ? "assistant" : "user";
  const timestamp = message.timestamp ? ` at ${message.timestamp}` : "";
  return `- ${role} ${sender}${timestamp}: ${trimForPrompt(message.content, 700)}`;
}

function buildRecentMessagesSection(input: ClassifierInput): string {
  if (input.recentMessages.length === 0) {
    return "Recent conversation:\n- No recent messages available.";
  }
  return `Recent conversation:\n${input.recentMessages.map(formatHistoryMessage).join("\n")}`;
}

function buildCurrentMessageSection(input: ClassifierInput): string {
  const sender = input.currentMessage.senderName ?? input.currentMessage.senderId;
  return [
    "Current message:",
    sender
      ? `${sender}: ${trimForPrompt(input.currentMessage.content, 1_200)}`
      : trimForPrompt(input.currentMessage.content, 1_200),
  ].join("\n");
}

export function buildClassifierPrompt(input: ClassifierInput): string {
  return [
    "You decide whether this digital coworker should participate in the current shared group, channel, room, or thread turn.",
    "The goal is useful participation, not name matching. Decide from the conversation context, current request, thread ownership, prior replies, and the coworker's role.",
    "Direct messages are admitted before this classifier; this classifier handles shared rooms, channels, groups, and threads.",
    "",
    buildContextSection(input.context),
    "",
    buildConversationSection(input),
    "",
    buildThreadSection(input),
    "",
    buildRecentMessagesSection(input),
    "",
    buildCurrentMessageSection(input),
    "",
    "Return exactly one complete minified JSON object with this exact shape:",
    '{"participationScore":0.0}',
    "",
    "Score guidance:",
    "- 1.0 means this coworker clearly should reply now.",
    "- 0.7 or higher means this coworker should participate.",
    "- Below 0.7 means this coworker should stay silent.",
    "- Use 0.9 or higher for direct requests to this coworker, clear follow-ups after this coworker replied, or requests where this coworker is the responsible participant.",
    "- Use 0.7 or higher for open channel asks such as 'can someone', 'does anyone know', or 'could the digital coworker in this channel' when this coworker can help.",
    "- Use 0.8 or higher when the message is in a thread where this coworker already answered or owns the thread context.",
    "- Use below 0.7 for ambient chat, messages clearly meant for another person, acknowledgements that do not need a reply, or interruptions.",
    "",
    "Do not include markdown, code fences, prose outside JSON, or extra keys.",
  ].join("\n");
}

function buildClassifierRetryPrompt(params: {
  input: ClassifierInput;
  parseError?: string;
}): string {
  return [
    buildClassifierPrompt(params.input),
    "",
    "The previous classifier response was invalid JSON.",
    params.parseError
      ? `Previous parse error: ${trimForPrompt(params.parseError, 240)}`
      : undefined,
    "Repair the response now. Return exactly one complete minified JSON object and nothing else.",
    '{"participationScore":0.0}',
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

type ParsedClassifierDecision = {
  participationScore: number;
  parseStatus: ClassifierParseStatus;
  parseError?: string;
};

function normalizeScore(value: unknown): number | undefined {
  const score =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    return undefined;
  }
  return score;
}

function failOpen(parseError: string): ParsedClassifierDecision {
  return {
    participationScore: 1,
    parseStatus: "malformed",
    parseError,
  };
}

function recoverParticipationScore(output: string): number | undefined {
  const stripped = stripCodeFences(output);
  const match = /["']?participationScore["']?\s*:\s*["']?(-?(?:\d+(?:\.\d+)?|\.\d+))["']?/i.exec(
    stripped,
  );
  return match ? normalizeScore(match[1]) : undefined;
}

function extractFirstJsonObject(value: string): string | undefined {
  const start = value.indexOf("{");
  if (start < 0) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return value.slice(start, index + 1);
      }
    }
  }
  return undefined;
}

function parseJsonObject(output: string): { parsed?: unknown; parseError?: string } {
  const stripped = stripCodeFences(output);
  try {
    return { parsed: JSON.parse(stripped) };
  } catch (error) {
    const primaryError = error instanceof Error ? error.message : String(error);
    const extracted = extractFirstJsonObject(stripped);
    if (extracted && extracted !== stripped) {
      try {
        return { parsed: JSON.parse(extracted) };
      } catch (extractError) {
        return {
          parseError: extractError instanceof Error ? extractError.message : String(extractError),
        };
      }
    }
    return { parseError: primaryError };
  }
}

export function parseClassifierDecision(output: string): ParsedClassifierDecision {
  const { parsed, parseError } = parseJsonObject(output);
  if (parseError) {
    const recoveredScore = recoverParticipationScore(output);
    if (recoveredScore !== undefined) {
      return {
        participationScore: recoveredScore,
        parseStatus: "recovered_score",
        parseError,
      };
    }
    return failOpen(parseError);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return failOpen("not_object");
  }

  const record = parsed as {
    participationScore?: unknown;
    reason?: unknown;
    shouldRespond?: unknown;
  };

  if (typeof record.shouldRespond === "boolean" && record.participationScore === undefined) {
    return {
      participationScore: record.shouldRespond ? 1 : 0,
      parseStatus: "legacy_boolean",
    };
  }

  const participationScore = normalizeScore(record.participationScore);
  if (participationScore === undefined) {
    return failOpen("invalid_score");
  }

  return {
    participationScore,
    parseStatus: "valid_json",
  };
}

export function parseClassifierShouldRespond(output: string, threshold = 0.7): boolean {
  return parseClassifierDecision(output).participationScore >= threshold;
}

export async function classifyParticipation(params: {
  api: RuntimeApi;
  config: ParticipationGateConfig;
  input: ClassifierInput;
}): Promise<ClassifierDecisionResult> {
  const inputHash = hashValue(stableStringify(params.input));
  const firstPrompt = buildClassifierPrompt(params.input);
  const firstAttempt = await runClassifierAttempt({
    api: params.api,
    config: params.config,
    prompt: firstPrompt,
    attempt: 1,
  });
  const attempts = [firstAttempt];
  let finalAttempt = firstAttempt;

  if (firstAttempt.parseStatus === "malformed") {
    const retryPrompt = buildClassifierRetryPrompt({
      input: params.input,
      parseError: firstAttempt.parseError,
    });
    finalAttempt = await runClassifierAttempt({
      api: params.api,
      config: params.config,
      prompt: retryPrompt,
      attempt: 2,
    });
    attempts.push(finalAttempt);
  }

  return {
    participationScore: finalAttempt.participationScore,
    parseStatus: finalAttempt.parseStatus,
    parseError: finalAttempt.parseError,
    rawOutput: finalAttempt.rawOutput,
    prompt: finalAttempt.prompt,
    promptVersion: CLASSIFIER_PROMPT_VERSION,
    promptHash: finalAttempt.promptHash,
    inputHash,
    outputHash: finalAttempt.outputHash,
    outputLength: finalAttempt.outputLength,
    attempts,
  };
}

async function runClassifierAttempt(params: {
  api: RuntimeApi;
  config: ParticipationGateConfig;
  prompt: string;
  attempt: number;
}): Promise<ClassifierAttemptResult & ParsedClassifierDecision> {
  const output = await runEmbeddedClassifierModel({
    api: params.api,
    config: params.config,
    prompt: params.prompt,
  });
  const parsed = parseClassifierDecision(output);
  return {
    attempt: params.attempt,
    prompt: params.prompt,
    promptHash: hashValue(params.prompt),
    rawOutput: output,
    outputHash: hashValue(output),
    outputLength: output.length,
    ...parsed,
  };
}

export async function classifyShouldRespond(params: {
  api: RuntimeApi;
  config: ParticipationGateConfig;
  input: ClassifierInput;
}): Promise<boolean> {
  const decision = await classifyParticipation(params);
  return decision.participationScore >= params.config.classifier.threshold;
}
