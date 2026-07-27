import { readFileSync } from "node:fs";
import path from "node:path";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  matchesManagedRecipient,
  parseIdentityLinks,
  type ManagedIdentityLinks,
} from "./identity.js";
import { sanitizeIdentityPerspective } from "./perspective.js";

export const PLUGIN_ID = "velanir-identity-perspective";

type IdentityPerspectiveConfig = {
  identityFile: string;
  recipientRole: string;
  channels: string[];
  recipientTargets: Array<{ channel: string; target: string }>;
};

type MessageContext = {
  channelId?: string;
  conversationId?: string;
  sessionKey?: string;
};

type MessageSendingEvent = {
  to?: string;
  content?: string;
  metadata?: Record<string, unknown>;
};

type ReplyPayloadEvent = {
  payload?: { text?: string; [key: string]: unknown };
  channel?: string;
};

function normalizeConfig(value: unknown): IdentityPerspectiveConfig {
  const config =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const identityFile = typeof config.identityFile === "string" ? config.identityFile.trim() : "";
  if (!identityFile || !path.isAbsolute(identityFile)) {
    throw new Error("identityFile must be an absolute path");
  }
  const channels = Array.isArray(config.channels)
    ? config.channels
        .filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
        .map((entry) => entry.trim().toLowerCase())
    : ["msteams"];
  const recipientTargets = Array.isArray(config.recipientTargets)
    ? config.recipientTargets.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
          return [];
        }
        const candidate = entry as Record<string, unknown>;
        if (typeof candidate.channel !== "string" || typeof candidate.target !== "string") {
          return [];
        }
        return [{ channel: candidate.channel, target: candidate.target }];
      })
    : [];
  return {
    identityFile,
    recipientRole:
      typeof config.recipientRole === "string" && config.recipientRole.trim()
        ? config.recipientRole.trim()
        : "manager",
    channels,
    recipientTargets,
  };
}

function channelFor(event: MessageSendingEvent | ReplyPayloadEvent, ctx: MessageContext): string {
  const metadataChannel =
    "metadata" in event && typeof event.metadata?.channel === "string"
      ? event.metadata.channel
      : undefined;
  const eventChannel = "channel" in event ? event.channel : undefined;
  return (metadataChannel ?? eventChannel ?? ctx.channelId ?? "").trim().toLowerCase();
}

function perspectiveResult(
  content: string,
  identity: ManagedIdentityLinks,
  config: IdentityPerspectiveConfig,
  channel: string,
  targets: Array<string | undefined>,
  api: OpenClawPluginApi,
): { content?: string; cancel?: boolean; reason?: string } | undefined {
  const addressRecipient = matchesManagedRecipient(
    identity,
    channel,
    targets,
    config.recipientTargets,
  );
  const result = sanitizeIdentityPerspective(content, identity, addressRecipient);
  if (result.violation) {
    api.logger.warn("identity perspective blocked unresolved third-person outbound text");
    return { cancel: true, reason: "identity_perspective_violation" };
  }
  if (!result.changed) {
    return undefined;
  }
  api.logger.info("identity perspective corrected outbound text");
  return { content: result.content };
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Velanir Identity Perspective",
  description:
    "Applies managed identity links to first-person and verified-recipient second-person delivery.",
  register(api) {
    const config = normalizeConfig(api.pluginConfig);
    const identity = parseIdentityLinks(
      readFileSync(config.identityFile, "utf8"),
      config.recipientRole,
    );

    api.on("message_sending", (rawEvent, rawContext) => {
      const event = rawEvent as MessageSendingEvent;
      const ctx = rawContext as MessageContext;
      const channel = channelFor(event, ctx);
      if (!config.channels.includes(channel) || typeof event.content !== "string") {
        return undefined;
      }
      const result = perspectiveResult(
        event.content,
        identity,
        config,
        channel,
        [event.to, ctx.conversationId],
        api,
      );
      if (result?.cancel) {
        return { cancel: true, cancelReason: result.reason };
      }
      return result?.content ? { content: result.content } : undefined;
    });

    api.on("reply_payload_sending", (rawEvent, rawContext) => {
      const event = rawEvent as ReplyPayloadEvent;
      const ctx = rawContext as MessageContext;
      const channel = channelFor(event, ctx);
      const text = event.payload?.text;
      if (!config.channels.includes(channel) || typeof text !== "string") {
        return undefined;
      }
      const result = perspectiveResult(text, identity, config, channel, [ctx.conversationId], api);
      if (result?.cancel) {
        return { cancel: true, reason: result.reason };
      }
      return result?.content ? { payload: { ...event.payload, text: result.content } } : undefined;
    });
  },
});
