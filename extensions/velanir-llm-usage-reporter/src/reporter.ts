import { buildIngestUrl } from "./config.js";
import {
  attributionFromContext,
  surfaceFromContext,
  triggerTypeFromContext,
} from "./context-attribution.js";
import { createRuntimeObservabilityAuthClient } from "./runtime-auth.js";
import type {
  AgentHookContext,
  LlmOutputEvent,
  LlmUsageReporterConfig,
  LlmUsageReporterDependencies,
  ModelCallEndedEvent,
  PlatformLlmUsageEvent,
} from "./types.js";
import {
  callKey,
  canonicalModelRef,
  estimateCostUsd,
  isPositiveInteger,
  nonnegativeInteger,
  usageTotal,
} from "./usage-math.js";

const MAX_CALLS_PER_KEY = 100;

function sourceEventId(params: {
  output: LlmOutputEvent;
  call?: ModelCallEndedEvent;
  sequence: number;
}): string {
  if (params.call?.callId) {
    return `openclaw:model_call:${params.call.callId}`;
  }
  return [
    "openclaw:llm_output",
    params.output.runId,
    params.output.sessionId,
    params.sequence,
  ].join(":");
}

function metadataFor(params: {
  output: LlmOutputEvent;
  ctx: AgentHookContext;
  call?: ModelCallEndedEvent;
  config: LlmUsageReporterConfig;
}): Record<string, unknown> {
  const { output, ctx, call, config } = params;
  const metadata: Record<string, unknown> = {
    openclawHook: "llm_output",
    resolvedRef: output.resolvedRef,
    harnessId: output.harnessId,
    agentId: ctx.agentId,
    jobId: ctx.jobId,
    trigger: ctx.trigger,
    channelId: ctx.channelId,
    messageProvider: ctx.messageProvider,
    contextTokenBudget: output.contextTokenBudget ?? ctx.contextTokenBudget,
    contextWindowSource: output.contextWindowSource ?? ctx.contextWindowSource,
    contextWindowReferenceTokens:
      output.contextWindowReferenceTokens ?? ctx.contextWindowReferenceTokens,
  };

  if (config.metadata.includeRawUsage) {
    metadata.rawUsage = output.usage ?? {};
  }

  if (config.metadata.includeContent) {
    metadata.prompt = output.prompt;
    metadata.assistantTextCount = output.assistantTexts.length;
    metadata.assistantTexts = output.assistantTexts;
  }

  if (call) {
    metadata.modelCall = {
      callId: call.callId,
      api: call.api,
      transport: call.transport,
      durationMs: call.durationMs,
      outcome: call.outcome,
      errorCategory: call.errorCategory,
      failureKind: call.failureKind,
      requestPayloadBytes: call.requestPayloadBytes,
      responseStreamBytes: call.responseStreamBytes,
      timeToFirstByteMs: call.timeToFirstByteMs,
      upstreamRequestIdHash: call.upstreamRequestIdHash,
    };
  }

  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined));
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function isRetryableIngestStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 409 || status === 425 || status === 429;
}

export class LlmUsageReporter {
  private readonly fetchImpl: typeof fetch;
  private readonly authClient;
  private readonly now: () => Date;
  private readonly queued: PlatformLlmUsageEvent[] = [];
  private readonly endedCalls = new Map<string, ModelCallEndedEvent[]>();
  private readonly outputCounters = new Map<string, number>();
  private interval: ReturnType<typeof setInterval> | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private flushing = false;
  private flushRequested = false;

  constructor(
    private readonly config: LlmUsageReporterConfig,
    private readonly deps: LlmUsageReporterDependencies = {},
  ) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.authClient =
      deps.authClient ??
      createRuntimeObservabilityAuthClient({
        fetchImpl: this.fetchImpl,
      });
    this.now = deps.now ?? (() => new Date());
  }

  start(): void {
    if (!this.config.enabled || this.interval || this.config.batch.flushIntervalMs === 0) {
      return;
    }
    this.interval = setInterval(() => {
      void this.flush();
    }, this.config.batch.flushIntervalMs);
    this.interval.unref?.();
  }

  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.flush();
  }

  observeModelCallEnded(event: ModelCallEndedEvent): void {
    if (!event.runId || !event.callId) {
      return;
    }
    const keys = [callKey(event), callKey({ runId: event.runId, sessionId: event.sessionId })];
    for (const key of keys) {
      const calls = this.endedCalls.get(key) ?? [];
      calls.push(event);
      if (calls.length > MAX_CALLS_PER_KEY) {
        calls.splice(0, calls.length - MAX_CALLS_PER_KEY);
      }
      this.endedCalls.set(key, calls);
    }
  }

  enqueueFromLlmOutput(event: LlmOutputEvent, ctx: AgentHookContext = {}): void {
    if (!this.config.enabled) {
      return;
    }
    const payload = this.toPlatformEvent(event, ctx);
    if (!payload) {
      return;
    }
    this.enqueue(payload);
  }

  async flush(): Promise<void> {
    if (!this.config.enabled || this.queued.length === 0) {
      return;
    }
    if (this.flushing) {
      this.flushRequested = true;
      return;
    }

    this.flushing = true;
    try {
      do {
        this.flushRequested = false;
        const batch = this.queued.splice(0, this.config.batch.maxBatchSize);
        if (batch.length === 0) {
          break;
        }
        const result = await this.sendBatch(batch);
        if (result === "retry") {
          this.requeueFront(batch);
          this.scheduleFlush();
          break;
        }
      } while (this.flushRequested || this.queued.length >= this.config.batch.maxBatchSize);
    } finally {
      this.flushing = false;
    }
  }

  queuedCount(): number {
    return this.queued.length;
  }

  private toPlatformEvent(
    event: LlmOutputEvent,
    ctx: AgentHookContext,
  ): PlatformLlmUsageEvent | undefined {
    if (!event.runId || !event.sessionId || !event.provider || !event.model || !event.usage) {
      return undefined;
    }
    const totalTokens = usageTotal(event.usage);
    if (!isPositiveInteger(totalTokens)) {
      return undefined;
    }

    const counterKey = callKey({ runId: event.runId, sessionId: event.sessionId });
    const sequence = (this.outputCounters.get(counterKey) ?? 0) + 1;
    this.outputCounters.set(counterKey, sequence);
    const call = this.consumeModelCall(event);
    const surface = surfaceFromContext(ctx);
    const attribution = attributionFromContext(ctx);
    const modelRef = event.resolvedRef ?? canonicalModelRef(event.provider, event.model);
    const inputTokens = nonnegativeInteger(event.usage.input);
    const outputTokens = nonnegativeInteger(event.usage.output);
    const cacheReadInputTokens = nonnegativeInteger(event.usage.cacheRead);
    const cacheWriteInputTokens = nonnegativeInteger(event.usage.cacheWrite);
    const costEstimate = estimateCostUsd({
      provider: event.provider,
      model: modelRef,
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheWriteInputTokens,
    });
    const metadata = metadataFor({
      output: event,
      ctx,
      call,
      config: this.config,
    });
    if (costEstimate) {
      metadata.pricingEstimate = costEstimate.metadata;
    }

    return {
      sourceEventId: sourceEventId({ output: event, call, sequence }),
      sourceSystem: "openclaw",
      sourceRunId: event.runId,
      sourceSessionKey: ctx.sessionKey,
      sourceSessionId: event.sessionId,
      provider: event.provider,
      model: modelRef,
      endpoint: call?.api ?? call?.transport,
      surface,
      triggerType: triggerTypeFromContext(ctx, surface),
      responsibilityId: attribution.responsibilityId,
      responsibilityVersionId: attribution.responsibilityVersionId,
      responsibilitySlug: attribution.responsibilitySlug,
      cronJobId: attribution.cronJobId,
      cronJobName: attribution.cronJobName,
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheWriteInputTokens,
      totalTokens,
      estimatedCostUsd: costEstimate?.estimatedCostUsd,
      currency: "USD",
      occurredAt: this.now().toISOString(),
      metadata,
    };
  }

  private enqueue(event: PlatformLlmUsageEvent): void {
    if (this.queued.length >= this.config.batch.maxQueueSize) {
      this.queued.shift();
      this.deps.logger?.warn?.("velanir-llm-usage-reporter: queue full, dropped oldest event");
    }
    this.queued.push(event);
    if (this.queued.length >= this.config.batch.maxBatchSize) {
      void this.flush();
      return;
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (!this.config.enabled || this.config.batch.flushIntervalMs === 0 || this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, this.config.batch.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  private consumeModelCall(event: LlmOutputEvent): ModelCallEndedEvent | undefined {
    const keys = [callKey(event), callKey({ runId: event.runId, sessionId: event.sessionId })];
    for (const key of keys) {
      const calls = this.endedCalls.get(key);
      const call = calls?.shift();
      if (call) {
        if (calls && calls.length === 0) {
          this.endedCalls.delete(key);
        }
        this.removeModelCall(call.callId);
        return call;
      }
    }
    return undefined;
  }

  private removeModelCall(callId: string): void {
    for (const [key, calls] of this.endedCalls.entries()) {
      const remaining = calls.filter((call) => call.callId !== callId);
      if (remaining.length === 0) {
        this.endedCalls.delete(key);
      } else if (remaining.length !== calls.length) {
        this.endedCalls.set(key, remaining);
      }
    }
  }

  private async sendBatch(events: PlatformLlmUsageEvent[]): Promise<SendBatchResult> {
    let url: string;
    try {
      url = buildIngestUrl(this.config);
      const authHeaders = await this.authClient.authorizationHeaders(url, "POST");
      const response = await fetchWithTimeout(
        this.fetchImpl,
        url,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            ...authHeaders,
          },
          body: JSON.stringify({ events }),
        },
        this.config.batch.requestTimeoutMs,
      );
      if (!response.ok) {
        if (isRetryableIngestStatus(response.status)) {
          this.deps.logger?.warn?.(
            `velanir-llm-usage-reporter: platform ingest failed with retryable status ${response.status}`,
          );
          return "retry";
        }
        this.deps.logger?.warn?.(
          `velanir-llm-usage-reporter: dropping ${events.length} llm usage event(s) after non-retryable platform ingest status ${response.status}`,
        );
        return "drop";
      }
      this.deps.logger?.debug?.(
        `velanir-llm-usage-reporter: reported ${events.length} llm usage event(s)`,
      );
      return "sent";
    } catch (error) {
      this.deps.logger?.warn?.(
        `velanir-llm-usage-reporter: platform ingest failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return "retry";
    }
  }

  private requeueFront(events: PlatformLlmUsageEvent[]): void {
    this.queued.unshift(...events);
    if (this.queued.length > this.config.batch.maxQueueSize) {
      this.queued.splice(this.config.batch.maxQueueSize);
    }
  }
}
