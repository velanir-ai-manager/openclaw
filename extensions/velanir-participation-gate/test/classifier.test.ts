import { describe, expect, it, vi } from "vitest";
import {
  buildClassifierPrompt,
  classifyParticipation,
  parseClassifierDecision,
  parseClassifierShouldRespond,
} from "../src/classifier.js";
import { normalizeConfig } from "../src/config.js";
import type { ClassifierInput, RuntimeApi } from "../src/types.js";

const input: ClassifierInput = {
  context: {
    self: {
      id: "albus",
      names: ["Albus"],
      roleSummary: "Executive assistant",
    },
    coworkers: [
      {
        id: "tanya",
        names: ["Tanya"],
        roleSummary: "Executive assistant",
      },
    ],
  },
  conversation: {
    provider: "slack",
    chatType: "channel",
    conversationLabel: "exec-ops",
    groupSubject: "Executive operations",
    senderName: "Dana",
    isThread: true,
  },
  thread: {
    starterBody: "Albus answered the first question in this thread.",
    historyBody: "Dana: Albus, how are you feeling tonight?\nAlbus: Doing well.",
  },
  recentMessages: [
    { senderId: "U1", senderName: "Dana", content: "Yesterday we discussed the board deck." },
  ],
  currentMessage: {
    senderId: "U2",
    senderName: "Riley",
    content: "Albus, can you summarize the follow-ups?",
  },
};

describe("classifier prompt and parsing", () => {
  it("builds a scored participation prompt with thread and conversation context", () => {
    const prompt = buildClassifierPrompt(input);

    expect(prompt).toContain('{"participationScore":0.0}');
    expect(prompt).toContain("0.7 or higher means this coworker should participate");
    expect(prompt).toContain("can someone");
    expect(prompt).toContain("Thread context:");
    expect(prompt).toContain("Executive operations");
    expect(prompt).toContain("complete minified JSON object");
    expect(prompt).toContain(
      "Do not include markdown, code fences, prose outside JSON, or extra keys.",
    );
    expect(prompt).not.toContain("reason");
    expect(prompt).not.toContain('{ "shouldRespond": true }');
  });

  it("parses scored classifier decisions against the threshold", () => {
    expect(parseClassifierShouldRespond('{ "participationScore": 0.8 }')).toBe(true);
    expect(parseClassifierShouldRespond('{ "participationScore": 0.2 }')).toBe(false);
    expect(parseClassifierShouldRespond('{ "participationScore": 0.6 }', 0.6)).toBe(true);
  });

  it("keeps legacy boolean parser compatibility", () => {
    expect(parseClassifierShouldRespond('{ "shouldRespond": true }')).toBe(true);
    expect(parseClassifierShouldRespond('{ "shouldRespond": false }')).toBe(false);
    expect(parseClassifierDecision('{ "shouldRespond": true }')).toMatchObject({
      parseStatus: "legacy_boolean",
    });
  });

  it("parses fenced JSON", () => {
    expect(parseClassifierDecision('```json\n{ "participationScore": 0.42 }\n```')).toMatchObject({
      participationScore: 0.42,
      parseStatus: "valid_json",
    });
  });

  it("extracts a JSON object from prose-wrapped classifier output", () => {
    expect(
      parseClassifierDecision('Here is the decision:\n{ "participationScore": 0.91 }\nThanks.'),
    ).toMatchObject({
      participationScore: 0.91,
      parseStatus: "valid_json",
    });
  });

  it("fails open for invalid classifier output", () => {
    expect(parseClassifierShouldRespond("I am not sure.")).toBe(true);
    expect(parseClassifierShouldRespond('{ "confidence": 0.2 }')).toBe(true);
    expect(parseClassifierShouldRespond('{ "participationScore": -0.1 }')).toBe(true);
    expect(parseClassifierShouldRespond('{ "participationScore": 1.1 }')).toBe(true);
    expect(parseClassifierDecision('{ "participationScore": -0.1 }')).toMatchObject({
      participationScore: 1,
      parseStatus: "malformed",
      parseError: "invalid_score",
    });
  });

  it("uses recovered scores from truncated classifier output", () => {
    expect(
      parseClassifierDecision('{ "participationScore": 0.08, "reason": "addressed to Y'),
    ).toMatchObject({
      participationScore: 0.08,
      parseStatus: "recovered_score",
      parseError: expect.stringContaining("Unterminated"),
    });
    expect(parseClassifierShouldRespond('{ "participationScore": 0.08, "reason": "addressed')).toBe(
      false,
    );
    expect(parseClassifierDecision('{ "participationScore": 0.72, "reason": "open')).toMatchObject({
      participationScore: 0.72,
      parseStatus: "recovered_score",
      parseError: expect.stringContaining("Unterminated"),
    });
    expect(parseClassifierShouldRespond('{ "participationScore": 0.72, "reason": "open')).toBe(
      true,
    );
  });

  it("retries once when the first classifier output is malformed", async () => {
    const runEmbeddedAgent = vi
      .fn()
      .mockResolvedValueOnce({
        payloads: [{ text: '{ "participationScore": }' }],
      })
      .mockResolvedValueOnce({
        payloads: [{ text: '{ "participationScore": 0.88 }' }],
      });
    const config = normalizeConfig({ classifier: { provider: "test", model: "test" } }, {});
    const result = await classifyParticipation({
      api: {
        config: {},
        runtime: { agent: { runEmbeddedAgent } },
      } as unknown as RuntimeApi,
      config,
      input,
    });

    expect(runEmbeddedAgent).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      participationScore: 0.88,
      parseStatus: "valid_json",
    });
    expect(result.attempts).toEqual([
      expect.objectContaining({ attempt: 1, parseStatus: "malformed" }),
      expect.objectContaining({ attempt: 2, parseStatus: "valid_json" }),
    ]);
    expect(runEmbeddedAgent.mock.calls[1]?.[0].prompt).toContain(
      "The previous classifier response was invalid JSON.",
    );
  });

  it("does not retry when the classifier score can be recovered", async () => {
    const runEmbeddedAgent = vi.fn().mockResolvedValue({
      payloads: [{ text: '{ "participationScore": 0.08, "reason": "addressed to Y' }],
    });
    const config = normalizeConfig({ classifier: { provider: "test", model: "test" } }, {});
    const result = await classifyParticipation({
      api: {
        config: {},
        runtime: { agent: { runEmbeddedAgent } },
      } as unknown as RuntimeApi,
      config,
      input,
    });

    expect(runEmbeddedAgent).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      participationScore: 0.08,
      parseStatus: "recovered_score",
      parseError: expect.stringContaining("Unterminated"),
    });
    expect(result.attempts).toHaveLength(1);
  });

  it("returns malformed fail-open metadata when the retry is still malformed", async () => {
    const runEmbeddedAgent = vi.fn().mockResolvedValue({
      payloads: [{ text: '{ "participationScore": }' }],
    });
    const config = normalizeConfig({ classifier: { provider: "test", model: "test" } }, {});
    const result = await classifyParticipation({
      api: {
        config: {},
        runtime: { agent: { runEmbeddedAgent } },
      } as unknown as RuntimeApi,
      config,
      input,
    });

    expect(runEmbeddedAgent).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      participationScore: 1,
      parseStatus: "malformed",
      parseError: expect.stringContaining("Unexpected"),
    });
    expect(result.attempts).toHaveLength(2);
  });
});
