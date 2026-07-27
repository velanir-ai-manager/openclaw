// Credential / internal-residue redaction.
//
// HARD REQUIREMENT (#5): no provider credentials, connection keys, action ids,
// bearer tokens, or raw provider output may ever leave this plugin through an
// injection block or a tool result. Everything that becomes user/model-visible
// is passed through `redactText` first, and tool results only ever carry
// whitelisted, mapped fields (never raw runner stdout).

const SENSITIVE_PATTERNS: RegExp[] = [
  // Composio / One action + connection ids seen in the reference runner CONFIG.
  /conn_mod_def::[A-Za-z0-9_::-]+/g,
  /live::[A-Za-z0-9_-]+/g,
  // API-key-ish tokens (ak_..., sk_..., pk_..., ghp_..., xoxb-..., Bearer ...).
  /\bak_[A-Za-z0-9]{6,}/g,
  /\b[sp]k_[A-Za-z0-9]{6,}/g,
  /\bghp_[A-Za-z0-9]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{8,}/gi,
  // JWT-shaped triples.
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
  // Reasoning-tag residue (MiniMax mm:think etc.) must never surface.
  /<\/?think[^>]*>/gi,
  /\bmm:think\b/gi,
];

const REDACTED = "[redacted]";

export function redactText(input: unknown): string {
  if (input === undefined || input === null) {
    return "";
  }
  let text = String(input);
  for (const pattern of SENSITIVE_PATTERNS) {
    text = text.replace(pattern, REDACTED);
  }
  // Collapse whitespace/newlines so a single summary line stays one line.
  return text.replace(/\s+/g, " ").trim();
}

// True when a string still contains an obvious secret marker AFTER redaction
// would have run — used only in tests / defensive assertions.
export function containsSensitive(input: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(input);
  });
}
