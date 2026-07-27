// Building the injected "pending responsibility interactions" block, scoped by
// agent id, channel, and user id, with a size cap.
//
// HARD REQUIREMENT (#1): never leak one user's pending items into another
// user's chat. Filtering is fail-closed: an item is only shown when every
// scope key it declares matches the turn, and (under strictUserScope) an item
// with no userId is never shown in a user-scoped chat.

import type { PendingInteraction, TurnScope } from "./types.js";

const CONVERSATION_ROUTE_PREFIXES = new Set([
  "channel",
  "chat",
  "conversation",
  "direct",
  "dm",
  "group",
  "thread",
  "user",
]);

/**
 * OpenClaw hook contexts expose a raw chat/channel id, while tool delivery
 * context keeps route prefixes such as `user:` or `conversation:`. Reduce both
 * representations to the same case-preserving id without stripping colons that
 * are part of provider-native ids (for example a Teams `19:...` conversation).
 */
export function canonicalizeConversationId(
  value: string | undefined,
  channel?: string,
): string | undefined {
  let current = value?.trim();
  if (!current) {
    return undefined;
  }
  const normalizedChannel = channel?.trim().toLowerCase();
  // Two prefixes cover OpenClaw's provider + route form, for example
  // `msteams:conversation:19:...`.
  for (let depth = 0; depth < 2; depth += 1) {
    const separator = current.indexOf(":");
    if (separator < 0) {
      break;
    }
    const prefix = current.slice(0, separator).trim().toLowerCase();
    const suffix = current.slice(separator + 1).trim();
    if (!suffix || (!CONVERSATION_ROUTE_PREFIXES.has(prefix) && prefix !== normalizedChannel)) {
      break;
    }
    current = suffix;
  }
  return current;
}

// Matches only when the item declares no value on this dimension, OR the turn
// carries a value equal to the item's. `item=set, turn=unset` fails closed.
function scopeMatches(itemValue: string | undefined, turnValue: string | undefined): boolean {
  if (itemValue === undefined) {
    return true;
  }
  return turnValue !== undefined && itemValue === turnValue;
}

export type FilterOptions = {
  strictUserScope: boolean;
  strictSessionScope: boolean;
};

export function filterForTurn(
  items: PendingInteraction[],
  turn: TurnScope,
  options: FilterOptions,
): PendingInteraction[] {
  return items.filter((item) => {
    if (options.strictUserScope && item.userId === undefined) {
      // Unattributable to a user — do not inject into a user-scoped chat.
      return false;
    }
    if (
      options.strictSessionScope &&
      item.sessionKey === undefined &&
      item.conversationId === undefined
    ) {
      // A user can have several DMs, groups, and channel threads on the same
      // provider. User+channel alone is not an exact delivery boundary.
      return false;
    }
    const exactDestinationMatches =
      item.sessionKey !== undefined
        ? scopeMatches(item.sessionKey, turn.sessionKey)
        : scopeMatches(
            canonicalizeConversationId(item.conversationId, item.channel),
            canonicalizeConversationId(turn.conversationId, turn.channel),
          );
    return (
      scopeMatches(item.agentId, turn.agentId) &&
      scopeMatches(item.channel, turn.channel) &&
      scopeMatches(item.userId, turn.userId) &&
      scopeMatches(item.accountId, turn.accountId) &&
      exactDestinationMatches
    );
  });
}

const HEADER = "[pending responsibility interactions]";

function itemLine(index: number, item: PendingInteraction): string {
  const slots = item.offeredSlots.length
    ? ` offered: ${item.offeredSlots
        .map((s, slotIndex) => {
          const stableId = s.id ?? (s.number ? String(s.number) : `option-${slotIndex + 1}`);
          return `${stableId}=${s.display}`;
        })
        .join("; ")}`
    : item.stage === "needs_info"
      ? " awaiting a preferred time"
      : "";
  return `${index}. id=${item.interactionId} · v=${item.stateVersion} · stage=${item.stage} · "${item.summary}"${slots}`;
}

export type InjectionOptions = { maxChars: number; maxItems: number; selectionEnabled?: boolean };

// Returns the injection text, or "" when there are no in-scope items (so the
// hook can return undefined and add nothing to the turn).
export function buildInjectionBlock(
  items: PendingInteraction[],
  options: InjectionOptions,
): string {
  if (items.length === 0) {
    return "";
  }
  const intro =
    `You have ${items.length} pending responsibility interaction${items.length === 1 ? "" : "s"} awaiting ` +
    "this user's reply. Delivery transcript mirrors are best-effort; pending state is authoritative. " +
    "Before interpreting a scheduling reply, call responsibility_pending and bind it " +
    "to exactly ONE interactionId. If more than one could match, ask which — never guess a thread or " +
    "improvise provider actions. Interpret natural-language choices against the offered labels; when " +
    "exactly one option matches, pass its stable optionId. If no option or multiple options match, ask " +
    "one clarification question without invoking an action tool.";
  const footer =
    options.selectionEnabled === false
      ? "Selection writes are disabled. Use responsibility_pending or responsibility_status only; do not " +
        "invoke runner effect modes."
      : "For a uniquely matched natural-language or numeric choice, act only via " +
        "responsibility_select_option with its exact interactionId and stable optionId. Displayed numbers " +
        "are also accepted as a compatibility fallback. Authorization and current state are bound " +
        "internally; never supply a revision, time, message id, or invoke runner effect modes manually. " +
        "After any typed action returns, stop the turn and give its one result; never retry or call " +
        "another tool in the same turn.";

  const shown = Math.min(items.length, Math.max(1, options.maxItems));
  let lines = items.slice(0, shown).map((it, i) => itemLine(i + 1, it));
  const hiddenByCount = items.length - shown;

  const assemble = (bodyLines: string[], hidden: number): string => {
    const parts = [HEADER, intro, ...bodyLines];
    if (hidden > 0) {
      parts.push(`(+${hidden} more — call responsibility_pending for the full list)`);
    }
    parts.push(footer);
    return parts.join("\n");
  };

  let block = assemble(lines, hiddenByCount);
  if (block.length <= options.maxChars) {
    return block;
  }

  // Over budget: drop trailing item lines until it fits, always keeping the
  // header, intro, footer, and a "+N more" indicator so nothing is silently lost.
  let visible = lines.length;
  while (visible > 1) {
    visible -= 1;
    lines = lines.slice(0, visible);
    block = assemble(lines, items.length - visible);
    if (block.length <= options.maxChars) {
      return block;
    }
  }
  // Even a single line overflows the cap: emit a complete fixed fallback that
  // fits the schema-supported 200-character minimum. Never slice safety text:
  // an invalid lower cap fails closed instead of producing a partial command.
  const compact = [
    HEADER,
    `(+${items.length} more) responsibility_pending; bind one.`,
    "Select only via responsibility_select_option(interactionId, optionId); then stop.",
  ].join("\n");
  return compact.length <= options.maxChars ? compact : "";
}
