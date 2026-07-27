import type { OpenClawPluginApi, PluginLogger } from "./api.js";

export type ParticipationMode = "shadow" | "enforce";
export type ParticipationContextSource = "platform" | "static";
export type PlatformContextAuthMode = "runtime" | "static-token";

export type CoworkerParticipationIdentity = {
  id: string;
  names: string[];
  roleSummary?: string;
};

export type ParticipationContext = {
  self: CoworkerParticipationIdentity;
  coworkers: CoworkerParticipationIdentity[];
};

export type ClassifierConfig = {
  provider?: string;
  model?: string;
  authProfileId?: string;
  timeoutMs: number;
  maxOutputTokens: number;
  threshold: number;
};

export type PlatformContextConfig = {
  authMode: PlatformContextAuthMode;
  baseUrl?: string;
  coworkerId?: string;
  token?: string;
  endpointPath: string;
};

export type DeliveryMode = "passthrough" | "coalesce";

export type DeliveryConfig = {
  /** passthrough preserves OpenClaw delivery; coalesce enables the turn coalescer. */
  mode: DeliveryMode;
  /** Milliseconds an inbound turn stays silent before one progress update may deliver. */
  quietWindowMs: number;
  /** Maximum user-visible progress messages per turn. Supported values: 0 or 1. */
  maxProgressMessages: number;
  /** Generic replacement text for the single allowed progress update. */
  progressText: string;
  /** Lifetime for per-turn delivery state and duplicate-final run protection. */
  turnTtlMs: number;
};

export type ParticipationGateConfig = {
  mode: ParticipationMode;
  classifier: ClassifierConfig;
  context: {
    source: ParticipationContextSource;
    maxMessages: number;
    refreshMs: number;
  };
  platform: PlatformContextConfig;
  staticContext?: ParticipationContext;
  delivery: DeliveryConfig;
  logging: {
    decisions: boolean;
    includeContent: boolean;
    classifierDebug: boolean;
  };
};

export type ConversationHistoryMessage = {
  role?: "user" | "assistant";
  senderId?: string;
  senderName?: string;
  content: string;
  timestamp?: number;
};

export type InboundHistoryMessage = {
  role?: "user" | "assistant";
  senderId?: string;
  senderName?: string;
  sender?: string;
  content?: string;
  body?: string;
  timestamp?: number;
};

export type MessageSentEvent = {
  to?: string;
  content?: string;
  success?: boolean;
  messageId?: string;
  sessionKey?: string;
  runId?: string;
  error?: string;
};

export type MessageSentContext = {
  channelId?: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
  messageId?: string;
  senderId?: string;
  isGroup?: boolean;
  groupId?: string;
  runId?: string;
};

export type ReplyDispatchKind = "tool" | "block" | "final";

export type ReplyPayload = {
  text?: string;
  [key: string]: unknown;
};

export type ReplyPayloadSendingEvent = {
  payload?: ReplyPayload;
  kind?: ReplyDispatchKind;
  channel?: string;
  sessionKey?: string;
  runId?: string;
};

export type ReplyPayloadSendingContext = MessageSentContext & {
  runId?: string;
};

export type BeforeToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  toolCallId?: string;
  runId?: string;
  sessionKey?: string;
};

export type BeforeToolCallContext = {
  sessionKey?: string;
  runId?: string;
  toolCallId?: string;
  conversationId?: string;
  channelId?: string;
  senderId?: string;
};

export type BeforeToolCallResult = {
  block: true;
  blockReason: string;
};

export type MessageSendingEvent = {
  to?: string;
  content?: string;
  metadata?: {
    channel?: string;
    [key: string]: unknown;
  };
  sessionKey?: string;
  runId?: string;
};

export type MessageSendingContext = MessageSentContext & {
  runId?: string;
};

export type MessageSendingResult = {
  cancel: true;
  cancelReason: string;
};

/** Conversation identity captured when an inbound turn begins. */
export type DeliveryRoute = {
  provider?: string;
  conversationId?: string;
  channelId?: string;
  senderId?: string;
};

/** Outbound send candidate compared against the active turn's route. */
export type DeliverySendCandidate = {
  provider?: string;
  target?: string;
};

export type TurnDeliveryRecord = {
  startedAt: number;
  updatedAt: number;
  finalDelivered: boolean;
  /** Set when a final was admitted; consumed by the matching message egress. */
  finalEgressPending: boolean;
  progressMessages: number;
  route: DeliveryRoute;
};

export type TurnDeliveryState = {
  turns: Map<string, TurnDeliveryRecord>;
  deliveredRuns: Map<string, number>;
};

export type DeliveryDecisionAction =
  | "allow_untracked"
  | "allow_final"
  | "allow_progress"
  | "suppress_intermediate"
  | "suppress_duplicate_final";

export type DeliveryDecisionResult = {
  cancel?: true;
  reason?: string;
  payload?: ReplyPayload;
};

export type DeliveryDecision = {
  action: DeliveryDecisionAction;
  result?: DeliveryDecisionResult;
};

export type TurnDeliveryStore = {
  beginTurn(scope: string | undefined, route?: DeliveryRoute): boolean;
  abandonTurn(scope: string | undefined): boolean;
  decide(event: ReplyPayloadSendingEvent, ctx: ReplyPayloadSendingContext): DeliveryDecision;
  isSameConversationSend(scope: string | undefined, send: DeliverySendCandidate): boolean;
  consumeFinalEgress(scope: string | undefined): boolean;
  activeTurnCount(): number;
};

export type BeforeDispatchEvent = {
  content?: string;
  body?: string;
  rawBody?: string;
  channel?: string;
  chatType?: string;
  provider?: string;
  surface?: string;
  conversationLabel?: string;
  groupSubject?: string;
  sessionKey?: string;
  parentSessionKey?: string;
  messageThreadId?: string;
  threadStarterBody?: string;
  threadHistoryBody?: string;
  threadLabel?: string;
  isFirstThreadTurn?: boolean;
  senderId?: string;
  senderName?: string;
  isGroup?: boolean;
  wasMentioned?: boolean;
  inboundHistory?: InboundHistoryMessage[];
  timestamp?: number;
};

export type BeforeDispatchContext = {
  channelId?: string;
  accountId?: string;
  conversationId?: string;
  conversationLabel?: string;
  sessionKey?: string;
  parentSessionKey?: string;
  messageThreadId?: string;
  senderId?: string;
  senderName?: string;
  chatType?: string;
  provider?: string;
  surface?: string;
  groupSubject?: string;
  wasMentioned?: boolean;
};

export type ParticipationDecisionReason =
  | "dm"
  | "out_of_scope"
  | "empty_message"
  | "context_unavailable"
  | "direct_address_self"
  | "direct_address_other_coworker"
  | "classifier_true"
  | "classifier_false"
  | "classifier_malformed"
  | "classifier_error";

export type ClassifierParseStatus =
  | "valid_json"
  | "legacy_boolean"
  | "recovered_score"
  | "malformed";

export type ClassifierAttemptResult = {
  attempt: number;
  prompt: string;
  promptHash: string;
  rawOutput: string;
  outputHash: string;
  outputLength: number;
  parseStatus: ClassifierParseStatus;
  parseError?: string;
};

export type ParticipationDecision = {
  shouldRespond: boolean;
  reason: ParticipationDecisionReason;
  source: "rule" | "classifier" | "fallback";
  latencyMs?: number;
  error?: string;
  participationScore?: number;
  threshold?: number;
  classifierPromptVersion?: string;
  classifierPromptHash?: string;
  classifierInputHash?: string;
  classifierParseStatus?: ClassifierParseStatus;
  classifierAttemptCount?: number;
  classifierOutputHash?: string;
  classifierOutputLength?: number;
  classifierRecentMessageCount?: number;
  classifierRecentUserMessageCount?: number;
  classifierRecentAssistantMessageCount?: number;
  classifierThreadContext?: boolean;
  classifierCurrentMessageLength?: number;
  classifierRawOutput?: string;
  classifierPrompt?: string;
  classifierInput?: ClassifierInput;
  classifierParseError?: string;
  classifierAttempts?: ClassifierAttemptResult[];
};

export type ClassifierInput = {
  context: ParticipationContext;
  conversation: {
    provider?: string;
    surface?: string;
    chatType?: string;
    channelId?: string;
    conversationId?: string;
    sessionKey?: string;
    conversationLabel?: string;
    groupSubject?: string;
    senderId?: string;
    senderName?: string;
    wasMentioned?: boolean;
    isThread?: boolean;
    messageThreadId?: string;
    parentSessionKey?: string;
    threadLabel?: string;
    isFirstThreadTurn?: boolean;
  };
  thread?: {
    starterBody?: string;
    historyBody?: string;
  };
  recentMessages: ConversationHistoryMessage[];
  currentMessage: {
    senderId?: string;
    senderName?: string;
    content: string;
    timestamp?: number;
  };
};

export type ClassifierDecisionResult = {
  participationScore: number;
  rawOutput: string;
  prompt: string;
  promptVersion: string;
  promptHash: string;
  inputHash: string;
  parseStatus: ClassifierParseStatus;
  outputHash: string;
  outputLength: number;
  attempts: ClassifierAttemptResult[];
  parseError?: string;
};

export type RuntimeApi = OpenClawPluginApi & {
  config?: unknown;
  pluginConfig?: unknown;
  logger?: PluginLogger;
  runtime?: {
    agent?: {
      runEmbeddedAgent?: (params: Record<string, unknown>) => Promise<unknown>;
      runEmbeddedPiAgent?: (params: Record<string, unknown>) => Promise<unknown>;
      resolveAgentWorkspaceDir?: (config: unknown) => string;
    };
  };
};
