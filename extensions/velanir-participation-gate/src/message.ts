import type { BeforeDispatchEvent } from "./types.js";

const THREAD_HISTORY_ENVELOPE_RE =
  /^\s*\[Thread history\]\s*([\s\S]*?)\s*\[\/Thread history\]\s*([\s\S]*)$/i;

function nonBlank(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

export function threadHistoryText(event: BeforeDispatchEvent): string | undefined {
  const explicit = nonBlank(event.threadHistoryBody);
  if (explicit) {
    return explicit;
  }

  const body = event.body;
  if (!body) {
    return undefined;
  }
  const match = THREAD_HISTORY_ENVELOPE_RE.exec(body);
  return nonBlank(match?.[1]);
}

export function stripThreadHistoryEnvelope(body: string | undefined): string {
  if (!body) {
    return "";
  }
  const match = THREAD_HISTORY_ENVELOPE_RE.exec(body);
  return (match?.[2] ?? body).trim();
}

export function messageText(event: BeforeDispatchEvent): string {
  for (const value of [event.rawBody, event.content]) {
    const text = nonBlank(value);
    if (text) {
      return text;
    }
  }
  return stripThreadHistoryEnvelope(event.body);
}
