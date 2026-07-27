export type ReplyPayloadEvent = {
  payload?: { text?: string; [key: string]: unknown };
  kind?: "tool" | "block" | "final";
  channel?: string;
  sessionKey?: string;
  runId?: string;
};

export function replyPayloadText(event: ReplyPayloadEvent): string | undefined {
  const text = event.payload?.text;
  return typeof text === "string" && text.trim() ? text : undefined;
}

export function replaceReplyPayloadText(
  event: ReplyPayloadEvent,
  text: string,
): { payload: Record<string, unknown> } | undefined {
  if (!event.payload) return undefined;
  return { payload: { ...event.payload, text } };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assistantMessageText(message: Record<string, unknown>): string | undefined {
  if (message.role !== "assistant") return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  return message.content
    .filter(
      (part): part is Record<string, unknown> =>
        isRecord(part) && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text as string)
    .join("\n");
}

export function withAssistantMessageText(
  message: Record<string, unknown>,
  text: string,
): Record<string, unknown> {
  if (typeof message.content === "string") return { ...message, content: text };
  if (!Array.isArray(message.content)) return message;
  let replaced = false;
  const content = message.content.flatMap((part) => {
    if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
      if (replaced) return [];
      replaced = true;
      return [{ ...part, text }];
    }
    return [part];
  });
  return replaced ? { ...message, content } : message;
}
