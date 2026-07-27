import { describe, expect, it, vi } from "vitest";
import { normalizeConfig } from "../src/config.js";
import { LlmUsageReporter } from "../src/reporter.js";
import type { RuntimeAuthClient } from "../src/types.js";

const authClient: RuntimeAuthClient = {
  async authorizationHeaders(requestUrl, method) {
    return {
      Authorization: "DPoP runtime-token",
      DPoP: `proof:${method}:${requestUrl}`,
    };
  },
};

function requestBodyText(body: BodyInit | null | undefined): string {
  if (typeof body !== "string") {
    throw new Error("Expected a string request body.");
  }
  return body;
}

function reporter(
  fetchImpl: typeof fetch,
  now = new Date("2026-06-15T21:00:00.000Z"),
  batch: { maxBatchSize?: number } = {},
) {
  return new LlmUsageReporter(
    normalizeConfig({
      platform: { baseUrl: "https://api.velanir.test" },
      batch: { flushIntervalMs: 0, maxBatchSize: 10, ...batch },
    }),
    {
      fetchImpl,
      authClient,
      now: () => now,
    },
  );
}

describe("llm usage reporter", () => {
  it("maps OpenClaw llm_output usage into the runtime ingest payload", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ data: {} })));
    const usageReporter = reporter(fetchImpl);

    usageReporter.observeModelCallEnded({
      runId: "run-1",
      callId: "call-1",
      sessionKey: "session-key-1",
      sessionId: "session-id-1",
      provider: "aws-sdk",
      model: "anthropic.claude-sonnet-4-20250514-v1:0",
      api: "bedrock-runtime",
      transport: "aws-sdk",
      durationMs: 1234,
      outcome: "completed",
      upstreamRequestIdHash: "sha256:abc",
      timeToFirstByteMs: 500,
    });
    usageReporter.enqueueFromLlmOutput(
      {
        runId: "run-1",
        sessionId: "session-id-1",
        provider: "aws-sdk",
        model: "anthropic.claude-sonnet-4-20250514-v1:0",
        resolvedRef: "aws-sdk/anthropic.claude-sonnet-4-20250514-v1:0",
        harnessId: "openclaw-agent",
        prompt: "do not send this",
        assistantTexts: ["do not send this either"],
        usage: {
          input: 10,
          output: 5,
          cacheRead: 2,
          cacheWrite: 1,
          total: 18,
        },
      },
      {
        sessionKey: "responsibility:calendar-view:daily-calendar",
        messageProvider: "msteams",
        channelId: "teams-channel",
        trigger: "cron",
        agentId: "main",
      },
    );

    await usageReporter.flush();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://api.velanir.test/v1/runtime/observability/llm-usage");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      Authorization: "DPoP runtime-token",
      DPoP: "proof:POST:https://api.velanir.test/v1/runtime/observability/llm-usage",
    });

    const body = JSON.parse(requestBodyText(init?.body));
    expect(body.events).toEqual([
      expect.objectContaining({
        sourceEventId: "openclaw:model_call:call-1",
        sourceSystem: "openclaw",
        sourceRunId: "run-1",
        sourceSessionKey: "responsibility:calendar-view:daily-calendar",
        sourceSessionId: "session-id-1",
        provider: "aws-sdk",
        model: "aws-sdk/anthropic.claude-sonnet-4-20250514-v1:0",
        endpoint: "bedrock-runtime",
        surface: "responsibility",
        triggerType: "cron",
        responsibilitySlug: "calendar-view",
        cronJobId: "daily-calendar",
        cronJobName: "oct8:responsibility:calendar-view:daily-calendar",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 2,
        cacheWriteInputTokens: 1,
        totalTokens: 18,
        occurredAt: "2026-06-15T21:00:00.000Z",
      }),
    ]);
    expect(body.events[0].metadata).toMatchObject({
      openclawHook: "llm_output",
      resolvedRef: "aws-sdk/anthropic.claude-sonnet-4-20250514-v1:0",
      harnessId: "openclaw-agent",
      agentId: "main",
      modelCall: {
        callId: "call-1",
        durationMs: 1234,
        outcome: "completed",
        upstreamRequestIdHash: "sha256:abc",
      },
    });
    expect(body.events[0].metadata.prompt).toBeUndefined();
    expect(body.events[0].metadata.assistantTexts).toBeUndefined();
  });

  it("does not reuse consumed model call ids from the session fallback bucket", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ data: {} })));
    const usageReporter = reporter(fetchImpl);

    usageReporter.observeModelCallEnded({
      runId: "run-1",
      callId: "call-1",
      sessionId: "session-id-1",
      provider: "aws-sdk",
      model: "model-a",
      durationMs: 100,
      outcome: "completed",
    });
    usageReporter.observeModelCallEnded({
      runId: "run-1",
      callId: "call-2",
      sessionId: "session-id-1",
      provider: "aws-sdk",
      model: "model-b",
      durationMs: 200,
      outcome: "completed",
    });

    usageReporter.enqueueFromLlmOutput({
      runId: "run-1",
      sessionId: "session-id-1",
      provider: "aws-sdk",
      model: "model-a",
      assistantTexts: [],
      usage: { input: 1, output: 1 },
    });
    usageReporter.enqueueFromLlmOutput({
      runId: "run-1",
      sessionId: "session-id-1",
      provider: "openclaw-provider",
      model: "model-b",
      assistantTexts: [],
      usage: { input: 2, output: 2 },
    });

    await usageReporter.flush();

    const body = JSON.parse(requestBodyText(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.events.map((event: { sourceEventId: string }) => event.sourceEventId)).toEqual([
      "openclaw:model_call:call-1",
      "openclaw:model_call:call-2",
    ]);
    expect(
      body.events.map(
        (event: { metadata: { modelCall?: { callId?: string } } }) =>
          event.metadata.modelCall?.callId,
      ),
    ).toEqual(["call-1", "call-2"]);
  });

  it("skips outputs without token usage", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ data: {} })));
    const usageReporter = reporter(fetchImpl);

    usageReporter.enqueueFromLlmOutput({
      runId: "run-1",
      sessionId: "session-id-1",
      provider: "aws-sdk",
      model: "model",
      assistantTexts: [],
    });
    await usageReporter.flush();

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("estimates Bedrock Mantle Kimi cost from known AWS token rates", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ data: {} })));
    const usageReporter = reporter(fetchImpl);

    usageReporter.enqueueFromLlmOutput({
      runId: "run-1",
      sessionId: "session-id-1",
      provider: "amazon-bedrock-mantle",
      model: "moonshotai.kimi-k2.5",
      resolvedRef: "amazon-bedrock-mantle/moonshotai.kimi-k2.5",
      assistantTexts: [],
      usage: {
        input: 1_000,
        output: 100,
        cacheRead: 200,
        cacheWrite: 0,
      },
    });

    await usageReporter.flush();

    const body = JSON.parse(requestBodyText(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.events[0]).toMatchObject({
      estimatedCostUsd: 0.00102,
      inputTokens: 1_000,
      outputTokens: 100,
      cacheReadInputTokens: 200,
      totalTokens: 1_300,
    });
    expect(body.events[0].metadata.pricingEstimate).toMatchObject({
      pricingSource: "aws-bedrock-moonshot-ai-on-demand",
      pricingSourceUrl: "https://aws.amazon.com/bedrock/pricing/",
      pricingModelRef: "amazon-bedrock-mantle/moonshotai.kimi-k2.5",
      inputUsdPerMillionTokens: 0.6,
      outputUsdPerMillionTokens: 3,
      cacheInputPricingPolicy: "charged_as_input_tokens",
      billableInputTokens: 1_200,
    });
  });

  it("estimates DeepInfra Kimi cost from known DeepInfra token rates", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ data: {} })));
    const usageReporter = reporter(fetchImpl);

    usageReporter.enqueueFromLlmOutput({
      runId: "run-1",
      sessionId: "session-id-1",
      provider: "deepinfra",
      model: "moonshotai/Kimi-K2.5",
      assistantTexts: [],
      usage: {
        input: 1_000,
        output: 100,
        cacheRead: 200,
        cacheWrite: 300,
      },
    });

    await usageReporter.flush();

    const body = JSON.parse(requestBodyText(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.events[0]).toMatchObject({
      estimatedCostUsd: 0.000824,
      inputTokens: 1_000,
      outputTokens: 100,
      cacheReadInputTokens: 200,
      cacheWriteInputTokens: 300,
      totalTokens: 1_600,
    });
    expect(body.events[0].metadata.pricingEstimate).toMatchObject({
      pricingSource: "deepinfra-kimi-k2.5-public-pricing",
      pricingSourceUrl: "https://deepinfra.com/moonshotai/Kimi-K2.5/api",
      pricingModelRef: "deepinfra/moonshotai/Kimi-K2.5",
      inputUsdPerMillionTokens: 0.45,
      outputUsdPerMillionTokens: 2.25,
      cachedInputUsdPerMillionTokens: 0.07,
      cacheInputPricingPolicy: "cached_read_discounted_cache_write_charged_as_input",
      regularInputTokens: 1_300,
    });
  });

  it("schedules a flush after enqueue even if the service interval has not started", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify({ data: {} })));
      const usageReporter = new LlmUsageReporter(
        normalizeConfig({
          platform: { baseUrl: "https://api.velanir.test" },
          batch: { flushIntervalMs: 1_000, maxBatchSize: 10 },
        }),
        {
          fetchImpl,
          authClient,
          now: () => new Date("2026-06-15T21:00:00.000Z"),
        },
      );

      usageReporter.enqueueFromLlmOutput({
        runId: "run-1",
        sessionId: "session-id-1",
        provider: "aws-sdk",
        model: "model",
        assistantTexts: [],
        usage: { input: 1, output: 1 },
      });

      expect(fetchImpl).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(usageReporter.queuedCount()).toBe(0);
      await usageReporter.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("requeues failed batches without throwing into the OpenClaw hook path", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("nope", { status: 503 }));
    const usageReporter = reporter(fetchImpl);

    usageReporter.enqueueFromLlmOutput({
      runId: "run-1",
      sessionId: "session-id-1",
      provider: "aws-sdk",
      model: "model",
      assistantTexts: [],
      usage: { input: 1, output: 1 },
    });

    await expect(usageReporter.flush()).resolves.toBeUndefined();
    expect(usageReporter.queuedCount()).toBe(1);
  });

  it("drops non-retryable ingest batches so later usage can flush", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("validation error", { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: {} })));
    const usageReporter = reporter(fetchImpl, new Date("2026-06-15T21:00:00.000Z"), {
      maxBatchSize: 1,
    });

    usageReporter.enqueueFromLlmOutput({
      runId: "poisoned-run",
      sessionId: "session-id-1",
      provider: "aws-sdk",
      model: "model",
      assistantTexts: [],
      usage: { input: 1, output: 1 },
    });
    usageReporter.enqueueFromLlmOutput({
      runId: "valid-run",
      sessionId: "session-id-1",
      provider: "aws-sdk",
      model: "model",
      assistantTexts: [],
      usage: { input: 2, output: 3 },
    });

    await expect(usageReporter.flush()).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(usageReporter.queuedCount()).toBe(0);
    const secondBody = JSON.parse(requestBodyText(fetchImpl.mock.calls[1]?.[1]?.body));
    expect(secondBody.events).toEqual([
      expect.objectContaining({
        sourceRunId: "valid-run",
        inputTokens: 2,
        outputTokens: 3,
        totalTokens: 5,
      }),
    ]);
  });
});
