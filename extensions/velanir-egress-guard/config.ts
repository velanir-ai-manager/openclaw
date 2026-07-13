export type EgressGuardMode = "off" | "shadow" | "enforce";
export type FinalOutputMode = "off" | "when_needed" | "always";
export type FinalOutputStyle = "plain" | "friendly";

export type VelanirEgressGuardConfig = {
  mode: EgressGuardMode;
  channels: string[];
  finalOutput: {
    mode: FinalOutputMode;
    style: FinalOutputStyle;
    maxEmojis: number;
    forbidEmDash: boolean;
  };
};

export const DEFAULT_EGRESS_GUARD_CONFIG: VelanirEgressGuardConfig = {
  mode: "off",
  channels: ["slack", "msteams"],
  finalOutput: {
    mode: "when_needed",
    style: "friendly",
    maxEmojis: 1,
    forbidEmDash: true,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeMode(value: unknown): EgressGuardMode {
  return value === "shadow" || value === "enforce" ? value : "off";
}

function normalizeFinalOutputMode(value: unknown): FinalOutputMode {
  return value === "off" || value === "always" ? value : "when_needed";
}

function normalizeStyle(value: unknown): FinalOutputStyle {
  return value === "plain" ? "plain" : "friendly";
}

function normalizeChannels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_EGRESS_GUARD_CONFIG.channels];
  }
  const channels = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(channels)];
}

function normalizeMaxEmojis(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 3
    ? value
    : DEFAULT_EGRESS_GUARD_CONFIG.finalOutput.maxEmojis;
}

export function normalizeEgressGuardConfig(value: unknown): VelanirEgressGuardConfig {
  const config = isRecord(value) ? value : {};
  const finalOutput = isRecord(config.finalOutput) ? config.finalOutput : {};
  return {
    mode: normalizeMode(config.mode),
    channels: normalizeChannels(config.channels),
    finalOutput: {
      mode: normalizeFinalOutputMode(finalOutput.mode),
      style: normalizeStyle(finalOutput.style),
      maxEmojis: normalizeMaxEmojis(finalOutput.maxEmojis),
      forbidEmDash: finalOutput.forbidEmDash !== false,
    },
  };
}

export function channelIsProtected(config: VelanirEgressGuardConfig, channel: unknown): boolean {
  if (typeof channel !== "string") {
    return false;
  }
  return config.channels.includes(channel.trim().toLowerCase());
}
