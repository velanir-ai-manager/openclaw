import type { ManagedIdentityLinks } from "./identity.js";

type Replacement = [RegExp, string | ((substring: string, ...args: string[]) => string)];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^$()|[\]{}\\]/gu, "\\$&");
}

function mapOutsideDoubleQuotes(text: string, transform: (segment: string) => string): string {
  let result = "";
  let segment = "";
  let quoted = false;
  const flush = () => {
    result += quoted ? segment : transform(segment);
    segment = "";
  };
  for (const char of text) {
    if (char === '"' || char === "“") {
      flush();
      quoted = !quoted;
      result += char;
      continue;
    }
    if (char === "”") {
      flush();
      quoted = false;
      result += char;
      continue;
    }
    segment += char;
  }
  flush();
  return result;
}

function collectOutsideDoubleQuotes(text: string): string {
  let result = "";
  let quoted = false;
  for (const char of text) {
    if (char === '"' || char === "“") {
      quoted = !quoted;
      continue;
    }
    if (char === "”") {
      quoted = false;
      continue;
    }
    if (!quoted) {
      result += char;
    }
  }
  return result;
}

function nameParts(name: string): { full: string; first: string } {
  return {
    full: escapeRegExp(name),
    first: escapeRegExp(name.split(/\s+/u)[0] ?? name),
  };
}

function selfReplacements(identity: ManagedIdentityLinks): Replacement[] {
  const self = nameParts(identity.selfName);
  return [
    [new RegExp(`\\b${self.full}(?:'s|’s) Email Inbox\\b`, "giu"), "my Outlook inbox"],
    [
      new RegExp(`\\b${self.full}(?:'s|’s) Outlook (?:Inbox|inbox|mailbox)\\b`, "giu"),
      "my Outlook inbox",
    ],
    [new RegExp(`\\b${self.full}(?:'s|’s) (?:Inbox|inbox|mailbox)\\b`, "giu"), "my inbox"],
    [new RegExp(`\\b${self.first}(?:'s|’s) Email Inbox\\b`, "giu"), "my Outlook inbox"],
    [
      new RegExp(`\\b${self.first}(?:'s|’s) Outlook (?:Inbox|inbox|mailbox)\\b`, "giu"),
      "my Outlook inbox",
    ],
    [new RegExp(`\\b${self.first}(?:'s|’s) (?:Inbox|inbox|mailbox)\\b`, "giu"), "my inbox"],
    [new RegExp(`\\b${self.full}\\s+was copied\\b`, "giu"), "I was copied"],
    [new RegExp(`\\b${self.first}\\s+was copied\\b`, "giu"), "I was copied"],
    [new RegExp(`\\b${self.full}\\s+has\\b`, "giu"), "I have"],
    [new RegExp(`\\b${self.first}\\s+has\\b`, "giu"), "I have"],
    [new RegExp(`\\b${self.full}\\s+needs\\b`, "giu"), "I need"],
    [new RegExp(`\\b${self.first}\\s+needs\\b`, "giu"), "I need"],
  ];
}

function recipientReplacements(identity: ManagedIdentityLinks): Replacement[] {
  const recipient = nameParts(identity.recipientName);
  return [
    [
      new RegExp(`\\b${recipient.full}(?:'s|’s) (?:calendar|inbox|mailbox)\\b`, "giu"),
      (match) => `your ${match.split(/\s+/u).at(-1)?.toLowerCase() ?? "calendar"}`,
    ],
    [
      new RegExp(`\\b${recipient.first}(?:'s|’s) (?:calendar|inbox|mailbox)\\b`, "giu"),
      (match) => `your ${match.split(/\s+/u).at(-1)?.toLowerCase() ?? "calendar"}`,
    ],
    [new RegExp(`\\b${recipient.full}\\s+has\\b`, "giu"), "You have"],
    [new RegExp(`\\b${recipient.first}\\s+has\\b`, "giu"), "You have"],
    [
      new RegExp(`\\b${recipient.full}\\s+(requested|asked|approved|selected|confirmed)\\b`, "giu"),
      (_match, verb) => `You ${verb.toLowerCase()}`,
    ],
    [
      new RegExp(
        `\\b${recipient.first}\\s+(requested|asked|approved|selected|confirmed)\\b`,
        "giu",
      ),
      (_match, verb) => `You ${verb.toLowerCase()}`,
    ],
  ];
}

export function sanitizeIdentityPerspective(
  content: string,
  identity: ManagedIdentityLinks,
  addressRecipient: boolean,
): { content: string; changed: boolean; violation: boolean } {
  const replacements = [
    ...selfReplacements(identity),
    ...(addressRecipient ? recipientReplacements(identity) : []),
  ];
  const rewritten = mapOutsideDoubleQuotes(content, (outside) => {
    let current = outside;
    for (const [pattern, replacement] of replacements) {
      current =
        typeof replacement === "string"
          ? current.replace(pattern, replacement)
          : current.replace(pattern, replacement);
    }
    return current;
  });
  const outsideOnly = collectOutsideDoubleQuotes(rewritten);
  const self = nameParts(identity.selfName);
  const selfViolation = new RegExp(`\\b(?:${self.full}|${self.first})(?:'s|’s)?\\b`, "iu");
  const recipient = nameParts(identity.recipientName);
  const recipientViolation = new RegExp(
    `\\b(?:${recipient.full}|${recipient.first})(?:'s|’s)?\\s+(?:calendar|inbox|mailbox|availability|approval|choice|reply|requested|asked|approved|selected|confirmed|has|needs)\\b`,
    "iu",
  );
  return {
    content: rewritten,
    changed: rewritten !== content,
    violation:
      selfViolation.test(outsideOnly) || (addressRecipient && recipientViolation.test(outsideOnly)),
  };
}
