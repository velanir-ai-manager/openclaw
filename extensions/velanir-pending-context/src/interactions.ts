// Pending-interaction index + binding + stage/action legality.

import type {
  InteractionAction,
  InteractionStage,
  PendingInteraction,
  ToolError,
} from "./types.js";

export type PendingIndex = {
  order: string[];
  byId: Map<string, PendingInteraction>;
};

export function buildIndex(items: PendingInteraction[]): PendingIndex {
  const byId = new Map<string, PendingInteraction>();
  const order: string[] = [];
  for (const item of items) {
    if (!byId.has(item.interactionId)) {
      order.push(item.interactionId);
    }
    // Last write wins if a duplicate id is seen across sources.
    byId.set(item.interactionId, item);
  }
  return { order, byId };
}

export function listInteractions(index: PendingIndex): PendingInteraction[] {
  return index.order.map((id) => index.byId.get(id)!).filter(Boolean);
}

// Stages in which reject/change are meaningful (the interaction is still open).
const RESPONDABLE_STAGES = new Set<InteractionStage>([
  "awaiting_confirmation",
  "awaiting_manager_selection",
  "needs_info",
  "needs_information",
  "proposed",
]);
// Stages in which selecting an offered option is meaningful.
const CONFIRMABLE_STAGES = new Set<InteractionStage>([
  "awaiting_confirmation",
  "awaiting_manager_selection",
  "proposed",
]);

export function isActionAllowed(
  interaction: PendingInteraction,
  action: InteractionAction,
): boolean {
  switch (action) {
    case "status":
      return true;
    case "select_option":
      // Selection requires a slot-bearing, confirmable stage. A needs_info
      // interaction (no slots offered) or a terminal stage cannot be confirmed.
      return CONFIRMABLE_STAGES.has(interaction.stage) && interaction.offeredSlots.length > 0;
    case "reject":
    case "change":
      return RESPONDABLE_STAGES.has(interaction.stage);
    default:
      return false;
  }
}

// Bind a (possibly absent) interactionId to exactly one pending interaction.
// AMBIGUITY RULE (#7): with more than one candidate and no explicit id, refuse
// and force the caller to name an interactionId — never guess a thread.
export function selectInteraction(
  index: PendingIndex,
  interactionId: string | undefined,
): { ok: true; interaction: PendingInteraction; autobound: boolean } | ToolError {
  const id = (interactionId ?? "").trim();
  if (id) {
    const interaction = index.byId.get(id);
    if (!interaction) {
      return {
        ok: false,
        error: "unknown_interaction",
        message: `No pending interaction with id "${id}". Call responsibility_pending to list current ids.`,
      };
    }
    return { ok: true, interaction, autobound: false };
  }
  const candidates = index.order;
  if (candidates.length === 0) {
    return {
      ok: false,
      error: "no_pending_interactions",
      message: "There are no pending interactions to act on. Check with the user before acting.",
    };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      error: "ambiguous_requires_interaction_id",
      message:
        "More than one interaction is pending. Re-issue with an explicit interactionId; do not guess which thread the reply refers to.",
      candidates: [...candidates],
    };
  }
  return { ok: true, interaction: index.byId.get(candidates[0])!, autobound: true };
}
