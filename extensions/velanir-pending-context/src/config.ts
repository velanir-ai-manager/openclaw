// Config normalization. Mirrors the openclaw.plugin.json configSchema and, like
// participation-gate, REBUILDS the config so unknown fields are dropped and
// defaults are explicit.
//
// Rollout control (canonical 0.4.0 reconciliation of live 0.2.12/0.3.0):
// `dryRun` defaults to true. An explicit false is necessary but not sufficient
// for an effect: a source must also supply an explicit actionCommand. There is
// intentionally no default effect argv, so a config typo cannot turn a read
// path into a provider-write path.

import type { PluginConfig, ResponsibilitySource } from "./types.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 262_144; // 256 KiB
const DEFAULT_MAX_INJECTION_CHARS = 1_800;
const DEFAULT_MAX_ITEMS = 6;
const DEFAULT_COMMAND: string[] = ["node", "runner.mjs", "pending"];
const DEFAULT_ACTION_TIMEOUT_MS = 50_000;
const DEFAULT_AUTHORIZATION_TTL_MS = 2 * 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeCommand(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_COMMAND];
  }
  const parts = value.map(readString).filter((entry): entry is string => Boolean(entry));
  return parts.length > 0 ? parts : [...DEFAULT_COMMAND];
}

function normalizeActionCommand(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value.map(readString).filter((entry): entry is string => Boolean(entry));
  return parts.length > 0 ? parts : undefined;
}

function normalizeSource(value: unknown, indexHint: number): ResponsibilitySource | null {
  if (!isRecord(value)) {
    return null;
  }
  const workspacePath = readString(value.workspacePath);
  const responsibilityId = readString(value.responsibilityId);
  if (!workspacePath || !responsibilityId) {
    // A source with no workspace or no responsibility id cannot be sourced.
    return null;
  }
  const id = readString(value.id) ?? `${responsibilityId}#${indexHint}`;
  const actionCommand = normalizeActionCommand(value.actionCommand);
  return {
    id,
    responsibilityId,
    ...(readString(value.agentId) ? { agentId: readString(value.agentId) } : {}),
    workspacePath,
    command: normalizeCommand(value.command),
    ...(actionCommand ? { actionCommand } : {}),
    timeoutMs: readPositiveInteger(value.timeoutMs, DEFAULT_TIMEOUT_MS),
    ...(actionCommand
      ? { actionTimeoutMs: readPositiveInteger(value.actionTimeoutMs, DEFAULT_ACTION_TIMEOUT_MS) }
      : {}),
    maxOutputBytes: readPositiveInteger(value.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES),
    ...(readString(value.channel) ? { channel: readString(value.channel) } : {}),
    ...(readString(value.userId) ? { userId: readString(value.userId) } : {}),
    ...(readString(value.sessionKey) ? { sessionKey: readString(value.sessionKey) } : {}),
    ...(readString(value.accountId) ? { accountId: readString(value.accountId) } : {}),
    ...(readString(value.conversationId)
      ? { conversationId: readString(value.conversationId) }
      : {}),
  };
}

export function normalizeConfig(pluginConfig: unknown): PluginConfig {
  const record = isRecord(pluginConfig) ? pluginConfig : {};
  const loggingRecord = isRecord(record.logging) ? record.logging : {};
  const rawSources = Array.isArray(record.sources) ? record.sources : [];
  const sources: ResponsibilitySource[] = [];
  rawSources.forEach((entry, i) => {
    const normalized = normalizeSource(entry, i);
    if (normalized) {
      sources.push(normalized);
    }
  });

  return {
    dryRun: readBoolean(record.dryRun, true),
    maxInjectionChars: readPositiveInteger(record.maxInjectionChars, DEFAULT_MAX_INJECTION_CHARS),
    maxItemsInInjection: readPositiveInteger(record.maxItemsInInjection, DEFAULT_MAX_ITEMS),
    strictUserScope: readBoolean(record.strictUserScope, true),
    strictSessionScope: readBoolean(record.strictSessionScope, true),
    authorizationTtlMs: readPositiveInteger(
      record.authorizationTtlMs,
      DEFAULT_AUTHORIZATION_TTL_MS,
    ),
    suppressNonFinalReplies: readBoolean(record.suppressNonFinalReplies, true),
    sources,
    logging: {
      decisions: loggingRecord.decisions !== false,
      includeContent: loggingRecord.includeContent === true,
    },
  };
}

export const CONFIG_DEFAULTS = {
  timeoutMs: DEFAULT_TIMEOUT_MS,
  actionTimeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
  maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
  maxInjectionChars: DEFAULT_MAX_INJECTION_CHARS,
  maxItems: DEFAULT_MAX_ITEMS,
  command: DEFAULT_COMMAND,
  authorizationTtlMs: DEFAULT_AUTHORIZATION_TTL_MS,
} as const;
