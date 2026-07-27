import { describe, expect, it, vi } from "vitest";
import { normalizeConfig } from "../src/config.js";
import type { ParticipationContextProvider } from "../src/context.js";
import { decideParticipation, decodeSlackMentions } from "../src/decision.js";
import { createParticipationHistoryStore } from "../src/history.js";
import type {
  BeforeDispatchContext,
  BeforeDispatchEvent,
  ParticipationContext,
  ParticipationGateConfig,
  RuntimeApi,
} from "../src/types.js";

type DecisionParams = Parameters<typeof decideParticipation>[0];
type ClassifyFn = NonNullable<DecisionParams["classify"]>;

const context: ParticipationContext = {
  self: {
    id: "albus",
    names: ["Albus", "Albus Dumbledore"],
    roleSummary: "Executive assistant",
  },
  coworkers: [
    {
      id: "tanya",
      names: ["Tanya", "Tanya Dean"],
      roleSummary: "Executive assistant",
    },
  ],
};

function config(): ParticipationGateConfig {
  return normalizeConfig(
    {
      context: { source: "static", maxMessages: 2 },
      classifier: { provider: "test", model: "test" },
      staticContext: context,
    },
    {},
  );
}

function provider(value: ParticipationContext = context): ParticipationContextProvider {
  return {
    load: vi.fn().mockResolvedValue(value),
  };
}

function mockClassify(result: boolean | number) {
  const participationScore = typeof result === "boolean" ? (result ? 1 : 0) : result;
  const rawOutput = JSON.stringify({ participationScore });
  return vi.fn<ClassifyFn>(async () => ({
    participationScore,
    rawOutput,
    prompt: "test prompt",
    promptVersion: "test-prompt-v1",
    promptHash: "prompt-hash",
    inputHash: "input-hash",
    parseStatus: "valid_json",
    outputHash: "output-hash",
    outputLength: rawOutput.length,
    attempts: [
      {
        attempt: 1,
        prompt: "test prompt",
        promptHash: "prompt-hash",
        rawOutput,
        outputHash: "output-hash",
        outputLength: rawOutput.length,
        parseStatus: "valid_json",
      },
    ],
  }));
}

function params(
  overrides: {
    event?: BeforeDispatchEvent;
    ctx?: BeforeDispatchContext;
    contextProvider?: ParticipationContextProvider;
    classify?: DecisionParams["classify"];
  } = {},
): DecisionParams {
  return {
    api: {} as RuntimeApi,
    config: config(),
    event: {
      isGroup: true,
      body: "What should we do next?",
      senderId: "U1",
      ...overrides.event,
    },
    ctx: { conversationId: "C1", ...overrides.ctx },
    contextProvider: overrides.contextProvider ?? provider(),
    history: createParticipationHistoryStore(),
    classify: overrides.classify ?? mockClassify(true),
  };
}

describe("decodeSlackMentions", () => {
  it("rewrites a mention with an appended display name to an @ address", () => {
    expect(decodeSlackMentions("Hey <@U0B4ENP8GAF> (Scott Harper) how are you?")).toBe(
      "Hey @Scott Harper how are you?",
    );
  });

  it("rewrites the inline-label mention form to an @ address", () => {
    expect(decodeSlackMentions("<@U0B4ENP8GAF|scott>, can you help?")).toBe(
      "@scott, can you help?",
    );
  });

  it("drops a bare mention with no resolvable name", () => {
    expect(decodeSlackMentions("ping <@U0B4ENP8GAF> please").replace(/\s+/g, " ").trim()).toBe(
      "ping please",
    );
  });

  it("leaves plain text untouched", () => {
    expect(decodeSlackMentions("Hey Scott, how are you?")).toBe("Hey Scott, how are you?");
  });
});

describe("decideParticipation", () => {
  it("passes through direct messages without loading context", async () => {
    const contextProvider = { load: vi.fn() };
    const result = await decideParticipation(
      params({
        event: { isGroup: false, body: "hello" },
        contextProvider,
      }),
    );

    expect(result).toMatchObject({
      shouldRespond: true,
      reason: "dm",
      source: "rule",
    });
    expect(contextProvider.load).not.toHaveBeenCalled();
  });

  it("passes through empty group messages", async () => {
    const result = await decideParticipation(params({ event: { isGroup: true, body: "  " } }));

    expect(result).toMatchObject({
      shouldRespond: true,
      reason: "empty_message",
      source: "rule",
    });
  });

  it("responds when directly addressed", async () => {
    const classify = mockClassify(false);
    const result = await decideParticipation(
      params({
        event: { isGroup: true, body: "Albus, can you summarize this?", senderId: "U1" },
        classify,
      }),
    );

    expect(result).toMatchObject({
      shouldRespond: true,
      reason: "direct_address_self",
      source: "rule",
    });
    expect(classify).not.toHaveBeenCalled();
  });

  it("responds when a sentence starts with the coworker name and a request", async () => {
    const classify = mockClassify(false);
    const result = await decideParticipation(
      params({
        event: { isGroup: true, body: "Albus I need you to summarize this.", senderId: "U1" },
        classify,
      }),
    );

    expect(result).toMatchObject({
      shouldRespond: true,
      reason: "direct_address_self",
      source: "rule",
    });
    expect(classify).not.toHaveBeenCalled();
  });

  it("responds when a later sentence starts with the coworker name and a request", async () => {
    const classify = mockClassify(false);
    const result = await decideParticipation(
      params({
        event: {
          isGroup: true,
          body: "One more thing. Albus I would like you to review this.",
          senderId: "U1",
        },
        classify,
      }),
    );

    expect(result).toMatchObject({
      shouldRespond: true,
      reason: "direct_address_self",
      source: "rule",
    });
    expect(classify).not.toHaveBeenCalled();
  });

  it("does not treat bare name-start statements as direct address", async () => {
    const classify = mockClassify(false);
    const result = await decideParticipation(
      params({
        event: { isGroup: true, body: "Albus mentioned this yesterday.", senderId: "U1" },
        classify,
      }),
    );

    expect(result).toMatchObject({
      shouldRespond: false,
      reason: "classifier_false",
      source: "classifier",
    });
    expect(classify).toHaveBeenCalledOnce();
  });

  it("does not treat name-start status statements as direct address", async () => {
    const classify = mockClassify(false);
    const result = await decideParticipation(
      params({
        event: { isGroup: true, body: "Albus is out today.", senderId: "U1" },
        classify,
      }),
    );

    expect(result).toMatchObject({
      shouldRespond: false,
      reason: "classifier_false",
      source: "classifier",
    });
    expect(classify).toHaveBeenCalledOnce();
  });

  it("skips when another known coworker is directly addressed", async () => {
    const classify = mockClassify(true);
    const result = await decideParticipation(
      params({
        event: { isGroup: true, body: "Tanya, can you handle the deck?", senderId: "U1" },
        classify,
      }),
    );

    expect(result).toMatchObject({
      shouldRespond: false,
      reason: "direct_address_other_coworker",
      source: "rule",
    });
    expect(classify).not.toHaveBeenCalled();
  });

  it("skips when another known coworker receives a sentence-start request", async () => {
    const classify = mockClassify(true);
    const result = await decideParticipation(
      params({
        event: { isGroup: true, body: "Tanya I need you to handle the deck.", senderId: "U1" },
        classify,
      }),
    );

    expect(result).toMatchObject({
      shouldRespond: false,
      reason: "direct_address_other_coworker",
      source: "rule",
    });
    expect(classify).not.toHaveBeenCalled();
  });

  it("skips when a Slack-encoded mention addresses another coworker", async () => {
    const classify = mockClassify(true);
    const result = await decideParticipation(
      params({
        event: {
          isGroup: true,
          body: "Hey <@U0TANYA> (Tanya Dean) can you handle the deck today?",
          senderId: "U1",
        },
        classify,
      }),
    );

    expect(result).toMatchObject({
      shouldRespond: false,
      reason: "direct_address_other_coworker",
      source: "rule",
    });
    expect(classify).not.toHaveBeenCalled();
  });

  it("skips when an inline-label Slack mention addresses another coworker", async () => {
    const classify = mockClassify(true);
    const result = await decideParticipation(
      params({
        event: {
          isGroup: true,
          body: "<@U0TANYA|tanya>, can you take the deck?",
          senderId: "U1",
        },
        classify,
      }),
    );

    expect(result).toMatchObject({
      shouldRespond: false,
      reason: "direct_address_other_coworker",
      source: "rule",
    });
    expect(classify).not.toHaveBeenCalled();
  });

  it("responds when a Slack-encoded mention addresses this coworker", async () => {
    const classify = mockClassify(false);
    const result = await decideParticipation(
      params({
        event: {
          isGroup: true,
          body: "Hey <@U0ALBUS> (Albus Dumbledore) what is on the calendar today?",
          senderId: "U1",
        },
        classify,
      }),
    );

    expect(result).toMatchObject({
      shouldRespond: true,
      reason: "direct_address_self",
      source: "rule",
    });
    expect(classify).not.toHaveBeenCalled();
  });

  it("uses the classifier for ambiguous group messages", async () => {
    const classify = mockClassify(false);
    const result = await decideParticipation(params({ classify }));

    expect(result).toMatchObject({
      shouldRespond: false,
      reason: "classifier_false",
      source: "classifier",
    });
    expect(classify).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          context,
          currentMessage: expect.objectContaining({
            senderId: "U1",
            content: "What should we do next?",
          }),
        }),
      }),
    );
  });

  it("responds when the classifier score meets the participation threshold", async () => {
    const classify = mockClassify(0.7);
    const result = await decideParticipation(
      params({
        event: {
          isGroup: true,
          body: "Can someone tell me the weather in San Francisco?",
          senderId: "U1",
        },
        classify,
      }),
    );

    expect(result).toMatchObject({
      shouldRespond: true,
      reason: "classifier_true",
      source: "classifier",
      participationScore: 0.7,
      threshold: 0.7,
      classifierPromptHash: "prompt-hash",
      classifierInputHash: "input-hash",
    });
  });

  it("skips from a recovered classifier score below the threshold", async () => {
    const rawOutput = '{ "participationScore": 0.08, "reason": "addressed to Y';
    const result = await decideParticipation(
      params({
        classify: vi.fn<ClassifyFn>(async () => ({
          participationScore: 0.08,
          rawOutput,
          prompt: "test prompt",
          promptVersion: "test-prompt-v2",
          promptHash: "prompt-hash",
          inputHash: "input-hash",
          parseStatus: "recovered_score",
          outputHash: "output-hash",
          outputLength: rawOutput.length,
          parseError: "Unterminated string in JSON at position 52",
          attempts: [
            {
              attempt: 1,
              prompt: "test prompt",
              promptHash: "prompt-hash",
              rawOutput,
              outputHash: "output-hash",
              outputLength: rawOutput.length,
              parseStatus: "recovered_score",
              parseError: "Unterminated string in JSON at position 52",
            },
          ],
        })),
      }),
    );

    expect(result).toMatchObject({
      shouldRespond: false,
      reason: "classifier_false",
      source: "classifier",
      participationScore: 0.08,
      threshold: 0.7,
      classifierParseStatus: "recovered_score",
      classifierAttemptCount: 1,
      classifierOutputHash: "output-hash",
      classifierParseError: "Unterminated string in JSON at position 52",
    });
  });

  it("passes Slack conversation, thread, and inbound history into the classifier", async () => {
    const classify = mockClassify(0.9);
    await decideParticipation(
      params({
        event: {
          isGroup: true,
          provider: "slack",
          surface: "message",
          chatType: "channel",
          channel: "C123",
          conversationLabel: "martina-test-channel",
          groupSubject: "Martina test channel",
          sessionKey: "slack:C123:thread:1710000000.000100",
          messageThreadId: "1710000000.000100",
          threadStarterBody: "Martina, how are you feeling tonight?",
          threadHistoryBody:
            "Dan: Martina, how are you feeling tonight?\nMartina Reyes: Doing well.",
          senderId: "U1",
          senderName: "Dan",
          inboundHistory: [
            {
              senderId: "U1",
              senderName: "Dan",
              content: "Martina, how are you feeling tonight?",
            },
            {
              senderId: "U1",
              senderName: "Dan",
              content: "What was your favorite part about today?",
            },
          ],
          body: "Could the digital coworker in this channel check the weather in San Francisco and reply here?",
        },
        ctx: {
          channelId: "C123",
          conversationId: "conversation_123",
          senderName: "Dan",
        },
        classify,
      }),
    );

    const classifierInput = classify.mock.calls[0]?.[0].input;
    expect(classifierInput).toBeDefined();
    if (!classifierInput) {
      throw new Error("missing classifier input");
    }
    expect(classifierInput.conversation).toMatchObject({
      provider: "slack",
      surface: "message",
      chatType: "channel",
      channelId: "C123",
      conversationId: "conversation_123",
      conversationLabel: "martina-test-channel",
      groupSubject: "Martina test channel",
      senderName: "Dan",
      isThread: true,
      messageThreadId: "1710000000.000100",
    });
    expect(classifierInput.thread).toMatchObject({
      starterBody: "Martina, how are you feeling tonight?",
      historyBody: expect.stringContaining("Martina Reyes: Doing well."),
    });
    expect(classifierInput.recentMessages).toEqual([
      expect.objectContaining({
        senderName: "Dan",
        content: "Martina, how are you feeling tonight?",
      }),
      expect.objectContaining({
        senderName: "Dan",
        content: "What was your favorite part about today?",
      }),
    ]);
  });

  it("uses Teams rawBody as the current message while preserving thread context", async () => {
    const classify = mockClassify(0.85);
    const result = await decideParticipation(
      params({
        event: {
          isGroup: true,
          provider: "msteams",
          surface: "msteams",
          chatType: "channel",
          channel: "19:random@thread.tacv2",
          conversationLabel: "Default Directory / random",
          groupSubject: "Default Directory / random",
          sessionKey: "agent:main:msteams:channel:19:random@thread.tacv2:thread:1779762397111",
          parentSessionKey: "agent:main:msteams:channel:19:random@thread.tacv2",
          messageThreadId: "1779762397111",
          threadLabel: "Teams thread Default Directory / random: Bill, please reply",
          threadStarterBody: "Dan: Bill, please reply with exactly: THIS_IS_WORKING",
          threadHistoryBody:
            "Dan: Bill, please reply with exactly: THIS_IS_WORKING\nBill Gates: THIS_IS_WORKING",
          senderId: "teams-user-1",
          senderName: "Dan",
          rawBody: "What the weather in San Francisco?",
          body: "[Thread history]\nDan: Bill, please reply with exactly: THIS_IS_WORKING\nBill Gates: THIS_IS_WORKING\n[/Thread history]\n\nWhat the weather in San Francisco?",
        },
        ctx: {
          channelId: "19:random@thread.tacv2",
          conversationId: "conversation:19:random@thread.tacv2",
          senderName: "Dan",
        },
        classify,
      }),
    );

    expect(result).toMatchObject({
      shouldRespond: true,
      reason: "classifier_true",
      source: "classifier",
    });
    expect(classify).toHaveBeenCalledOnce();
    const classifierInput = classify.mock.calls[0]?.[0].input;
    expect(classifierInput?.currentMessage).toMatchObject({
      senderName: "Dan",
      content: "What the weather in San Francisco?",
    });
    expect(classifierInput?.conversation).toMatchObject({
      provider: "msteams",
      chatType: "channel",
      isThread: true,
      messageThreadId: "1779762397111",
      parentSessionKey: "agent:main:msteams:channel:19:random@thread.tacv2",
      threadLabel: "Teams thread Default Directory / random: Bill, please reply",
    });
    expect(classifierInput?.thread).toMatchObject({
      starterBody: expect.stringContaining("Bill, please reply"),
      historyBody: expect.stringContaining("Bill Gates: THIS_IS_WORKING"),
    });
  });

  it("extracts Teams thread context from the body envelope when structured fields are missing", async () => {
    const classify = mockClassify(0.85);
    await decideParticipation(
      params({
        event: {
          isGroup: true,
          provider: "msteams",
          chatType: "channel",
          channel: "19:random@thread.tacv2",
          messageThreadId: "1779762397111",
          senderName: "Dan",
          content: "What about Palo Alto?",
          body: "[Thread history]\nDan: Bill, weather in San Francisco?\nBill Gates: San Francisco is 61F.\n[/Thread history]\n\nWhat about Palo Alto?",
        },
        ctx: { conversationId: "conversation:19:random@thread.tacv2" },
        classify,
      }),
    );

    const classifierInput = classify.mock.calls[0]?.[0].input;
    expect(classifierInput?.currentMessage.content).toBe("What about Palo Alto?");
    expect(classifierInput?.thread?.historyBody).toContain("Bill Gates: San Francisco is 61F.");
  });

  it("merges Teams inbound history with local assistant replies for follow-up scoring", async () => {
    const history = createParticipationHistoryStore();
    history.recordOutbound(
      {
        to: "conversation:19:random@thread.tacv2;messageid=1779762397111",
        content: "Palo Alto is sunny.",
        success: true,
      },
      {},
      2,
    );
    const classify = mockClassify(0.85);
    const decisionParams = params({
      event: {
        isGroup: true,
        provider: "msteams",
        chatType: "channel",
        channel: "19:random@thread.tacv2",
        messageThreadId: "1779762397111",
        senderName: "Dan",
        rawBody: "Which one is your favorite?",
        inboundHistory: [
          {
            senderName: "Dan",
            content: "What about Palo Alto?",
          },
        ],
      },
      ctx: { conversationId: "conversation:19:random@thread.tacv2" },
      classify,
    });
    decisionParams.history = history;

    await decideParticipation(decisionParams);

    expect(classify.mock.calls[0]?.[0].input.recentMessages).toEqual([
      {
        role: "assistant",
        senderId: "self",
        senderName: "This coworker",
        content: "Palo Alto is sunny.",
      },
      {
        senderName: "Dan",
        content: "What about Palo Alto?",
      },
    ]);
  });

  it("merges Slack inbound history with local assistant replies for follow-up scoring", async () => {
    const history = createParticipationHistoryStore();
    history.recordOutbound({ to: "C123", content: "Palo Alto is sunny.", success: true }, {}, 2);
    const classify = mockClassify(0.85);
    const decisionParams = params({
      event: {
        isGroup: true,
        provider: "slack",
        chatType: "channel",
        channel: "C123",
        senderName: "Dan",
        rawBody: "Which one is your favorite?",
        inboundHistory: [
          {
            senderName: "Dan",
            content: "What about Palo Alto?",
          },
        ],
      },
      ctx: { conversationId: "C123" },
      classify,
    });
    decisionParams.history = history;

    await decideParticipation(decisionParams);

    expect(classify.mock.calls[0]?.[0].input.recentMessages).toEqual([
      {
        role: "assistant",
        senderId: "self",
        senderName: "This coworker",
        content: "Palo Alto is sunny.",
      },
      {
        senderName: "Dan",
        content: "What about Palo Alto?",
      },
    ]);
  });

  it("preserves local Slack assistant replies when inbound history fills the recent-message window", async () => {
    const history = createParticipationHistoryStore();
    history.recordOutbound(
      { to: "C123", content: "Found 4 customers with contracts expiring in July.", success: true },
      {},
      2,
    );
    const classify = mockClassify(0.85);
    const decisionParams = params({
      event: {
        isGroup: true,
        provider: "slack",
        chatType: "channel",
        channel: "C123",
        senderName: "Dan",
        rawBody: "Lets go with July 15",
        inboundHistory: [
          {
            senderName: "Dan",
            content: "We need to schedule a renewal meeting with all three.",
          },
          {
            senderName: "Dan",
            content: "This looks good. can we modify the date?",
          },
        ],
      },
      ctx: { conversationId: "C123" },
      classify,
    });
    decisionParams.history = history;

    await decideParticipation(decisionParams);

    expect(classify.mock.calls[0]?.[0].input.recentMessages).toEqual([
      {
        role: "assistant",
        senderId: "self",
        senderName: "This coworker",
        content: "Found 4 customers with contracts expiring in July.",
      },
      {
        senderName: "Dan",
        content: "This looks good. can we modify the date?",
      },
    ]);
  });

  it("normalizes OpenClaw raw inbound history entries into classifier history", async () => {
    const classify = mockClassify(0.85);
    await decideParticipation(
      params({
        event: {
          isGroup: true,
          provider: "slack",
          chatType: "channel",
          channel: "C123",
          senderName: "Dan",
          rawBody: "Lets go with July 15",
          inboundHistory: [
            {
              sender: "Dan",
              body: "This looks good. can we modify the date?",
              timestamp: 1782137456,
            },
          ],
        },
        ctx: { conversationId: "C123" },
        classify,
      }),
    );

    expect(classify.mock.calls[0]?.[0].input.recentMessages).toEqual([
      {
        senderName: "Dan",
        content: "This looks good. can we modify the date?",
        timestamp: 1782137456,
      },
    ]);
  });

  it("fails open when context is unavailable", async () => {
    const result = await decideParticipation(
      params({
        contextProvider: {
          load: vi.fn().mockRejectedValue(new Error("offline")),
        },
      }),
    );

    expect(result).toMatchObject({
      shouldRespond: true,
      reason: "context_unavailable",
      source: "fallback",
      error: "offline",
    });
  });

  it("fails open when the classifier errors", async () => {
    const result = await decideParticipation(
      params({
        classify: vi.fn<ClassifyFn>(async () => {
          throw new Error("timeout");
        }),
      }),
    );

    expect(result).toMatchObject({
      shouldRespond: true,
      reason: "classifier_error",
      source: "fallback",
      error: "timeout",
    });
  });

  it("fails open as classifier_malformed when classifier output remains malformed", async () => {
    const result = await decideParticipation(
      params({
        classify: vi.fn<ClassifyFn>(async () => ({
          participationScore: 1,
          rawOutput: '{ "participationScore": }',
          prompt: "test prompt",
          promptVersion: "test-prompt-v2",
          promptHash: "prompt-hash",
          inputHash: "input-hash",
          parseStatus: "malformed",
          outputHash: "output-hash",
          outputLength: 25,
          parseError: "Unexpected token } in JSON at position 24",
          attempts: [
            {
              attempt: 1,
              prompt: "test prompt",
              promptHash: "prompt-hash",
              rawOutput: '{ "participationScore": }',
              outputHash: "output-hash",
              outputLength: 25,
              parseStatus: "malformed",
              parseError: "Unexpected token } in JSON at position 24",
            },
          ],
        })),
      }),
    );

    expect(result).toMatchObject({
      shouldRespond: true,
      reason: "classifier_malformed",
      source: "fallback",
      participationScore: 1,
      classifierParseStatus: "malformed",
      classifierAttemptCount: 1,
      classifierOutputHash: "output-hash",
      classifierParseError: "Unexpected token } in JSON at position 24",
    });
  });

  it("passes recent messages into the classifier", async () => {
    const history = createParticipationHistoryStore();
    const classify = mockClassify(true);
    const first = params({
      event: { isGroup: true, body: "First message", senderId: "U1" },
      classify,
    });
    first.history = history;
    const second = params({
      event: { isGroup: true, body: "Second message", senderId: "U2" },
      classify,
    });
    second.history = history;

    await decideParticipation(first);
    await decideParticipation(second);

    expect(classify.mock.calls[1]?.[0].input.recentMessages).toEqual([
      expect.objectContaining({ senderId: "U1", content: "First message" }),
    ]);
  });
});
