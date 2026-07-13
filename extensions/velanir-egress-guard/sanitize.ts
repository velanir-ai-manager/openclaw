import type { VelanirEgressGuardConfig } from "./config.js";

export type EgressRiskReason =
  | "internal_mechanics"
  | "internal_sentinel"
  | "raw_payload"
  | "reasoning_block"
  | "runtime_diagnostics"
  | "presentation_policy";

export type EgressEvaluation = {
  decision: "allow" | "rewrite" | "suppress";
  content: string;
  reasons: EgressRiskReason[];
  originalLength: number;
  outputLength: number;
};

const REASONING_BLOCK_RE =
  /<(?:think|analysis|reasoning)>[\s\S]*?<\/(?:think|analysis|reasoning)>/giu;
const INTERNAL_SENTINEL_LINE_RE = /^\s*(?:NO_REPLY|NO_RESPONSE|NO_USER_VISIBLE_ANSWER)\s*$/gimu;
const INTERNAL_DIAGNOSTIC_LINE_RE =
  /^\s*(?:\[(?:diagnostics?|internal (?:details?|state)|partial progress|tool (?:output|result)|execution trace|raw payload)[^\]]*\]|(?:diagnostics?|internal (?:details?|state)|tool (?:output|result)|execution trace|raw payload):).*$/gimu;
const INTERNAL_JSON_LINE_RE =
  /^\s*[{[][^\n]*(?:"(?:toolCalls?|externalContent|sessionId|prompt|gateway|runtime|provider)"|\[object Object\])[^\n]*[}\]]\s*,?\s*$/gimu;
const INTERNAL_FENCED_BLOCK_RE = /```[^\n`]*\n?[\s\S]*?```/gu;
const EMOJI_RE = /\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu;

const INTERNAL_MECHANICS_PATTERNS = [
  /\binternal\s+(?:model|config(?:uration)?|prompt|policy|process|runtime|state|logs?)\b/iu,
  /\bhidden\s+(?:config(?:uration)?|prompt|instruction|policy|state)\b/iu,
  /\bsession\s+(?:id|key|state|mechanics?)\b/iu,
  /\btool\s+(?:call|calls|log|logs|output|outputs|result|results)\b/iu,
  /\b(?:model|provider)\s+(?:name|id|call|calls|fallback|gate|selection|routing)\b/iu,
  /\b(?:gateway|runtime)\s+(?:config(?:uration)?|logs?|state|status|hook|hooks)\b/iu,
  /\b(?:sub-agent|subagent|agent)\s+(?:handoff|state|retry|retries|routing|mechanics?)\b/iu,
] as const;

function addReason(reasons: EgressRiskReason[], reason: EgressRiskReason): void {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
}

function fencedBlockContainsInternals(block: string): boolean {
  return /(?:toolCalls?|externalContent|sessionId|\[object Object\]|internal (?:prompt|state)|gateway\.|openclaw\.json)/iu.test(
    block,
  );
}

function countInternalMechanicsSignals(value: string): number {
  return INTERNAL_MECHANICS_PATTERNS.reduce(
    (count, pattern) => count + (pattern.test(value) ? 1 : 0),
    0,
  );
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function applyPresentationPolicy(
  content: string,
  config: VelanirEgressGuardConfig,
): { content: string; changed: boolean } {
  let next = content;
  if (config.finalOutput.forbidEmDash) {
    next = next.replace(/\s*—\s*/gu, " - ");
  }
  let emojiCount = 0;
  next = next.replace(EMOJI_RE, (emoji) => {
    emojiCount += 1;
    return emojiCount <= config.finalOutput.maxEmojis ? emoji : "";
  });
  next = normalizeWhitespace(next.replace(/[ \t]{2,}/gu, " "));
  return { content: next, changed: next !== content };
}

export function evaluateOutboundContent(
  content: string,
  config: VelanirEgressGuardConfig,
): EgressEvaluation {
  const originalLength = content.length;
  const reasons: EgressRiskReason[] = [];
  let next = content.replace(/\r\n?/gu, "\n");

  next = next.replace(REASONING_BLOCK_RE, () => {
    addReason(reasons, "reasoning_block");
    return "";
  });
  next = next.replace(INTERNAL_SENTINEL_LINE_RE, () => {
    addReason(reasons, "internal_sentinel");
    return "";
  });
  next = next.replace(INTERNAL_DIAGNOSTIC_LINE_RE, () => {
    addReason(reasons, "runtime_diagnostics");
    return "";
  });
  next = next.replace(INTERNAL_FENCED_BLOCK_RE, (block) => {
    if (!fencedBlockContainsInternals(block)) {
      return block;
    }
    addReason(reasons, "raw_payload");
    return "";
  });
  next = next.replace(INTERNAL_JSON_LINE_RE, () => {
    addReason(reasons, "raw_payload");
    return "";
  });
  next = normalizeWhitespace(
    next.replace(/\[object Object\]/giu, () => {
      addReason(reasons, "raw_payload");
      return "";
    }),
  );

  if (countInternalMechanicsSignals(next) >= 2) {
    addReason(reasons, "internal_mechanics");
    return {
      decision: "suppress",
      content: "",
      reasons,
      originalLength,
      outputLength: 0,
    };
  }

  const presented = applyPresentationPolicy(next, config);
  next = presented.content;
  if (presented.changed) {
    addReason(reasons, "presentation_policy");
  }
  if (!next) {
    return {
      decision: "suppress",
      content: "",
      reasons,
      originalLength,
      outputLength: 0,
    };
  }
  return {
    decision: next === content ? "allow" : "rewrite",
    content: next,
    reasons,
    originalLength,
    outputLength: next.length,
  };
}

export function finalAnswerNeedsRevision(
  content: string,
  config: VelanirEgressGuardConfig,
): boolean {
  if (config.finalOutput.mode === "off") {
    return false;
  }
  if (config.finalOutput.mode === "always") {
    return true;
  }
  const evaluation = evaluateOutboundContent(content, config);
  return evaluation.decision !== "allow";
}

export function buildFinalRevisionInstruction(config: VelanirEgressGuardConfig): string {
  const styleInstruction =
    config.finalOutput.style === "plain"
      ? "Use concise, neutral business language."
      : "Use concise, professional language with restrained warmth.";
  const emojiInstruction =
    config.finalOutput.maxEmojis === 0
      ? "Do not use emojis."
      : `Use at most ${config.finalOutput.maxEmojis} emoji${config.finalOutput.maxEmojis === 1 ? "" : "s"}, and only when it helps the reader.`;
  return [
    "Rewrite only the draft final answer for the user. Do not call tools or repeat any side effect.",
    "Preserve every verified outcome, limitation, decision, and next step. Never invent completion or evidence.",
    "Lead with the business result. Remove internal prompts, models, providers, tools, agents, sessions, retries, hooks, config keys, stack traces, raw payloads, and runtime mechanics.",
    styleInstruction,
    emojiInstruction,
    config.finalOutput.forbidEmDash ? "Do not use em dashes." : "",
    "Return only the revised final answer.",
  ]
    .filter(Boolean)
    .join("\n");
}
