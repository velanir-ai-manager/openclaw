import type { OpenClawUsage } from "./types.js";

const TOKENS_PER_MILLION = 1_000_000;
const BEDROCK_MANTLE_KIMI_K2_5_MODEL_REF = "amazon-bedrock-mantle/moonshotai.kimi-k2.5";
const BEDROCK_MANTLE_KIMI_K2_5_PRICING = {
  inputUsdPerMillionTokens: 0.6,
  outputUsdPerMillionTokens: 3,
  source: "aws-bedrock-moonshot-ai-on-demand",
  sourceUrl: "https://aws.amazon.com/bedrock/pricing/",
  verifiedAt: "2026-06-16",
} as const;
const DEEPINFRA_KIMI_K2_5_MODEL_REF = "deepinfra/moonshotai/Kimi-K2.5";
const DEEPINFRA_KIMI_K2_5_PRICING = {
  inputUsdPerMillionTokens: 0.45,
  outputUsdPerMillionTokens: 2.25,
  cachedInputUsdPerMillionTokens: 0.07,
  source: "deepinfra-kimi-k2.5-public-pricing",
  sourceUrl: "https://deepinfra.com/moonshotai/Kimi-K2.5/api",
  verifiedAt: "2026-06-30",
} as const;

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function nonnegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function usageTotal(usage: OpenClawUsage): number {
  const componentTotal =
    nonnegativeInteger(usage.input) +
    nonnegativeInteger(usage.output) +
    nonnegativeInteger(usage.cacheRead) +
    nonnegativeInteger(usage.cacheWrite);
  return Math.max(componentTotal, nonnegativeInteger(usage.total));
}

export function callKey(parts: {
  runId?: string;
  sessionId?: string;
  provider?: string;
  model?: string;
}): string {
  return [parts.runId ?? "", parts.sessionId ?? "", parts.provider ?? "", parts.model ?? ""].join(
    "|",
  );
}

export function canonicalModelRef(provider: string, model: string): string {
  return model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
}

function roundUsd(value: number): number {
  return Number(value.toFixed(6));
}

export function estimateCostUsd(params: {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
}):
  | {
      estimatedCostUsd: number;
      metadata: Record<string, unknown>;
    }
  | undefined {
  const modelRef = canonicalModelRef(params.provider, params.model);
  if (modelRef === BEDROCK_MANTLE_KIMI_K2_5_MODEL_REF) {
    const billableInputTokens =
      params.inputTokens + params.cacheReadInputTokens + params.cacheWriteInputTokens;
    const estimatedCostUsd = roundUsd(
      (billableInputTokens * BEDROCK_MANTLE_KIMI_K2_5_PRICING.inputUsdPerMillionTokens +
        params.outputTokens * BEDROCK_MANTLE_KIMI_K2_5_PRICING.outputUsdPerMillionTokens) /
        TOKENS_PER_MILLION,
    );

    return {
      estimatedCostUsd,
      metadata: {
        pricingSource: BEDROCK_MANTLE_KIMI_K2_5_PRICING.source,
        pricingSourceUrl: BEDROCK_MANTLE_KIMI_K2_5_PRICING.sourceUrl,
        pricingVerifiedAt: BEDROCK_MANTLE_KIMI_K2_5_PRICING.verifiedAt,
        pricingModelRef: modelRef,
        inputUsdPerMillionTokens: BEDROCK_MANTLE_KIMI_K2_5_PRICING.inputUsdPerMillionTokens,
        outputUsdPerMillionTokens: BEDROCK_MANTLE_KIMI_K2_5_PRICING.outputUsdPerMillionTokens,
        cacheInputPricingPolicy: "charged_as_input_tokens",
        billableInputTokens,
      },
    };
  }

  if (modelRef === DEEPINFRA_KIMI_K2_5_MODEL_REF) {
    const regularInputTokens = params.inputTokens + params.cacheWriteInputTokens;
    const estimatedCostUsd = roundUsd(
      (regularInputTokens * DEEPINFRA_KIMI_K2_5_PRICING.inputUsdPerMillionTokens +
        params.cacheReadInputTokens * DEEPINFRA_KIMI_K2_5_PRICING.cachedInputUsdPerMillionTokens +
        params.outputTokens * DEEPINFRA_KIMI_K2_5_PRICING.outputUsdPerMillionTokens) /
        TOKENS_PER_MILLION,
    );

    return {
      estimatedCostUsd,
      metadata: {
        pricingSource: DEEPINFRA_KIMI_K2_5_PRICING.source,
        pricingSourceUrl: DEEPINFRA_KIMI_K2_5_PRICING.sourceUrl,
        pricingVerifiedAt: DEEPINFRA_KIMI_K2_5_PRICING.verifiedAt,
        pricingModelRef: modelRef,
        inputUsdPerMillionTokens: DEEPINFRA_KIMI_K2_5_PRICING.inputUsdPerMillionTokens,
        outputUsdPerMillionTokens: DEEPINFRA_KIMI_K2_5_PRICING.outputUsdPerMillionTokens,
        cachedInputUsdPerMillionTokens: DEEPINFRA_KIMI_K2_5_PRICING.cachedInputUsdPerMillionTokens,
        cacheInputPricingPolicy: "cached_read_discounted_cache_write_charged_as_input",
        regularInputTokens,
      },
    };
  }
  return undefined;
}
