import { describe, expect, it, vi } from "vitest";
import { normalizeConfig } from "../src/config.js";
import { logParticipationDecision, logParticipationHistoryEvent } from "../src/logging.js";
import type { ParticipationDecision } from "../src/types.js";

const classifierDecision: ParticipationDecision = {
  shouldRespond: true,
  reason: "classifier_malformed",
  source: "fallback",
  participationScore: 1,
  threshold: 0.7,
  classifierPromptVersion: "participation-score-v2",
  classifierPromptHash: "prompt-hash",
  classifierInputHash: "input-hash",
  classifierParseStatus: "malformed",
  classifierAttemptCount: 2,
  classifierOutputHash: "output-hash",
  classifierOutputLength: 52,
  classifierRecentMessageCount: 2,
  classifierRecentUserMessageCount: 1,
  classifierRecentAssistantMessageCount: 1,
  classifierParseError: "Unterminated string in JSON at position 52",
  classifierRawOutput: '{ "participationScore": 1, "extra": "unterminated',
  classifierPrompt: "test prompt",
  classifierInput: {
    context: { self: { id: "albus", names: ["Albus"] }, coworkers: [] },
    conversation: { provider: "slack" },
    recentMessages: [],
    currentMessage: { content: "secret current message" },
  },
  classifierAttempts: [
    {
      attempt: 1,
      prompt: "test prompt",
      promptHash: "prompt-hash",
      rawOutput: '{ "participationScore": 1, "extra": "unterminated',
      outputHash: "output-hash",
      outputLength: 52,
      parseStatus: "malformed",
      parseError: "Unterminated string in JSON at position 52",
    },
  ],
};

describe("participation decision logging", () => {
  it("logs classifier hashes and parse status without exact content by default", () => {
    const logger = { info: vi.fn() };
    const config = normalizeConfig({ classifier: { provider: "test", model: "test" } }, {});

    logParticipationDecision({
      logger,
      config,
      decision: classifierDecision,
      event: { body: "secret event body", isGroup: true },
      ctx: { conversationId: "C1" },
    });

    expect(logger.info).toHaveBeenCalledTimes(1);
    const line = logger.info.mock.calls[0]?.[0] as string;
    expect(line).toContain("parseStatus=malformed");
    expect(line).toContain("attemptCount=2");
    expect(line).toContain("outputHash=output-hash");
    expect(line).toContain("recentUserMessages=1");
    expect(line).toContain("recentAssistantMessages=1");
    expect(line).not.toContain("classifierReason=");
    expect(line).not.toContain("secret current message");
    expect(line).not.toContain("secret event body");
    expect(line).not.toContain("Unterminated");
    expect(line).not.toContain("test prompt");
  });

  it("keeps classifier debug logs hashed unless content logging is enabled", () => {
    const logger = { info: vi.fn() };
    const config = normalizeConfig(
      {
        classifier: { provider: "test", model: "test" },
        logging: { classifierDebug: true },
      },
      {},
    );

    logParticipationDecision({
      logger,
      config,
      decision: classifierDecision,
      event: { body: "secret event body", isGroup: true },
      ctx: { conversationId: "C1" },
    });

    expect(logger.info).toHaveBeenCalledTimes(2);
    const debugLine = logger.info.mock.calls[1]?.[0] as string;
    const payload = JSON.parse(
      debugLine.replace("velanir-participation-gate-classifier-debug: ", ""),
    ) as Record<string, unknown>;

    expect(payload.reason).toBeUndefined();
    expect(payload.parseError).toBeUndefined();
    expect(payload.input).toBeUndefined();
    expect(payload.rawOutput).toBeUndefined();
    expect(payload.attempts).toEqual([
      expect.not.objectContaining({
        prompt: "test prompt",
        rawOutput: classifierDecision.classifierRawOutput,
      }),
    ]);
    expect(debugLine).not.toContain("secret current message");
    expect(debugLine).not.toContain("secret event body");
    expect(debugLine).not.toContain("unterminated");
  });

  it("logs exact prompt input and raw attempts only when debug content is enabled", () => {
    const logger = { info: vi.fn() };
    const config = normalizeConfig(
      {
        classifier: { provider: "test", model: "test" },
        logging: { classifierDebug: true, includeContent: true },
      },
      {},
    );

    logParticipationDecision({
      logger,
      config,
      decision: classifierDecision,
      event: { body: "secret event body", isGroup: true },
      ctx: { conversationId: "C1" },
    });

    expect(logger.info).toHaveBeenCalledTimes(2);
    const debugLine = logger.info.mock.calls[1]?.[0] as string;
    const payload = JSON.parse(
      debugLine.replace("velanir-participation-gate-classifier-debug: ", ""),
    ) as Record<string, unknown>;

    expect(payload.input).toBeDefined();
    expect(payload.reason).toBeUndefined();
    expect(payload.parseError).toBe(classifierDecision.classifierParseError);
    expect(payload.rawOutput).toBe(classifierDecision.classifierRawOutput);
    expect(payload.attempts).toEqual([
      expect.objectContaining({
        prompt: "test prompt",
        rawOutput: classifierDecision.classifierRawOutput,
      }),
    ]);
  });

  it("logs history capture metadata without content by default", () => {
    const logger = { info: vi.fn() };
    const config = normalizeConfig({ classifier: { provider: "test", model: "test" } }, {});

    logParticipationHistoryEvent({
      logger,
      config,
      event: "message_sent_outbound",
      fields: {
        recorded: true,
        conversation: "conversation:19:random@thread.tacv2",
      },
      content: "secret weather reply",
    });

    const line = logger.info.mock.calls[0]?.[0] as string;
    expect(line).toContain("velanir-participation-gate-history:");
    expect(line).toContain("event=message_sent_outbound");
    expect(line).toContain("recorded=true");
    expect(line).not.toContain("secret weather reply");
  });
});
