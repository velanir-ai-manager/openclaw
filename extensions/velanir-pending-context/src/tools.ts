// Typed tool contracts + validation + dry-run.
//
// HARD REQUIREMENT: responsibility_pending is read-only and comes FIRST.
// select_option/reject/change/status validate that the interactionId exists,
// the stateVersion matches where applicable, the trusted inbound message has
// been bound internally, and the action is legal for the interaction's stage.
// Any failure -> typed error, NO effect. In shadow mode (the safe default)
// valid actions return what WOULD happen; runner effects run only in
// commit/enforce mode via index.ts.

import {
  buildIndex,
  isActionAllowed,
  listInteractions,
  selectInteraction,
} from "./interactions.js";
import type { PendingIndex } from "./interactions.js";
import { redactText } from "./redaction.js";
import type {
  DryRunOutcome,
  InteractionAction,
  PendingInteraction,
  PendingListOutcome,
  StatusOutcome,
  ToolError,
} from "./types.js";

// JSON-Schema parameter contracts. These are plain objects (structurally a
// TypeBox `TSchema`); index.ts adapts them onto the OpenClaw tool `parameters`
// field. Kept here, decoupled from OpenClaw, so they are unit-testable offline.
export type JsonSchema = {
  type: "object";
  properties: Record<string, { type: string; description: string }>;
  required: string[];
  additionalProperties: false;
};

export type ToolContract = {
  name: string;
  label: string;
  readOnly: boolean;
  description: string;
  parameters: JsonSchema;
};

// Registered FIRST — read-only listing the main agent calls BEFORE interpreting
// any user reply.
export const PENDING_CONTRACT: ToolContract = {
  name: "responsibility_pending",
  label: "List pending responsibility interactions",
  readOnly: true,
  description:
    "List the responsibility interactions currently visible to THIS authenticated user in THIS exact " +
    "channel and session. Cron transcript mirrors are best-effort, so call this authoritative " +
    "scoped-state tool before interpreting any scheduling reply. An empty result proves only that " +
    "nothing is visible in this scope; never infer that another interaction completed, closed, " +
    "expired, or timed out. If more than one could match, ask the user which — never guess.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
};

export const SELECT_OPTION_CONTRACT: ToolContract = {
  name: "responsibility_select_option",
  label: "Select an offered option",
  readOnly: false,
  description:
    "Select one stable option already offered on a pending interaction. First interpret the user's " +
    "natural-language reply against the authoritative offered labels. If exactly one option matches, " +
    "call this tool with the exact interactionId and that option's stable optionId. If no option or " +
    "multiple options match, ask one clarification question without calling this tool. A displayed " +
    "option number is also accepted and resolved to a stable optionId internally. The current " +
    "revision, selected time, sender, and inbound message are resolved from authoritative runtime " +
    "state; never supply or invent them.",
  parameters: {
    type: "object",
    properties: {
      interactionId: {
        type: "string",
        description: "The interaction to select from responsibility_pending.",
      },
      optionId: {
        type: "string",
        description:
          "The stable offered option id, or the displayed one-based option number selected by the user.",
      },
    },
    required: ["interactionId", "optionId"],
    additionalProperties: false,
  },
};

export const REJECT_CONTRACT: ToolContract = {
  name: "responsibility_reject",
  label: "Reject a pending interaction",
  readOnly: false,
  description:
    "Record that the user declined a pending interaction. Requires the exact interactionId and " +
    "current stateVersion and a short reason. Authorization is bound internally to the trusted " +
    "inbound message. Dry-run by default.",
  parameters: {
    type: "object",
    properties: {
      interactionId: {
        type: "string",
        description: "The interaction to reject (from responsibility_pending).",
      },
      stateVersion: {
        type: "string",
        description: "The interaction's current stateVersion; a stale value is rejected.",
      },
      reason: { type: "string", description: "Short user-facing reason for the rejection." },
    },
    required: ["interactionId", "stateVersion", "reason"],
    additionalProperties: false,
  },
};

export const CHANGE_CONTRACT: ToolContract = {
  name: "responsibility_change",
  label: "Request a different window for a pending interaction",
  readOnly: false,
  description:
    "Record that the user wants a different time window for a pending interaction. Requires the " +
    "exact interactionId and current stateVersion plus the requested window. Authorization is " +
    "bound internally to the trusted inbound message. Dry-run by default.",
  parameters: {
    type: "object",
    properties: {
      interactionId: {
        type: "string",
        description: "The interaction to change (from responsibility_pending).",
      },
      stateVersion: {
        type: "string",
        description: "The interaction's current stateVersion; a stale value is rejected.",
      },
      requestedWindow: {
        type: "string",
        description: "The window the user is asking for (free text or ISO range).",
      },
    },
    required: ["interactionId", "stateVersion", "requestedWindow"],
    additionalProperties: false,
  },
};

export const STATUS_CONTRACT: ToolContract = {
  name: "responsibility_status",
  label: "Read a pending interaction's status",
  readOnly: true,
  description: "Read the current stage and offered slots of one pending interaction. Read-only.",
  parameters: {
    type: "object",
    properties: {
      interactionId: {
        type: "string",
        description: "The interaction to inspect (from responsibility_pending).",
      },
    },
    required: ["interactionId"],
    additionalProperties: false,
  },
};

// responsibility_pending first, then the typed action tools.
export const TOOL_CONTRACTS: ToolContract[] = [
  PENDING_CONTRACT,
  SELECT_OPTION_CONTRACT,
  REJECT_CONTRACT,
  CHANGE_CONTRACT,
  STATUS_CONTRACT,
];

export type ToolParams = Record<string, unknown>;

function readParam(params: ToolParams, key: string): string {
  const value = params[key];
  return typeof value === "string" ? value.trim() : "";
}

// --- responsibility_pending ---------------------------------------------------

// The exact final text an agent must return after an empty scoped read. The
// wording states that absence is scope-local; it is also enforced at
// finalize/write/send time by index.ts, so a model cannot spin an empty list
// into a lifecycle claim ("that meeting was already booked/expired").
export const SCOPED_EMPTY_PENDING_TEXT =
  "No pending scheduling interactions are visible in this authenticated session. This scoped result " +
  "does not prove that an interaction was completed, closed, expired, or timed out in another " +
  "session. Check from the intended manager's authenticated channel.";

export function runPendingTool(index: PendingIndex): PendingListOutcome {
  const items = listInteractions(index);
  const empty = items.length === 0;
  return {
    ok: true,
    pendingCount: items.length,
    pending: items.map((it) => {
      const pending: PendingListOutcome["pending"][number] = {
        interactionId: it.interactionId,
        stateVersion: it.stateVersion,
        stage: it.stage,
        summary: it.summary,
        offeredSlots: it.offeredSlots,
      };
      if (it.requestedWindowHint) {
        pending.requestedWindowHint = it.requestedWindowHint;
      }
      if (it.lastAskedToUser) {
        pending.lastAskedToUser = it.lastAskedToUser;
      }
      if (it.note) {
        pending.note = it.note;
      }
      return pending;
    }),
    ...(empty
      ? {
          visibility: "authenticated_session" as const,
          absenceProof: "scoped_only" as const,
          stopAfterThisTool: true,
          userVisibleText: SCOPED_EMPTY_PENDING_TEXT,
        }
      : {}),
    hint: empty
      ? "Return userVisibleText exactly. Do not call another tool, consult session history, or infer completion, closure, expiry, booking, resolution, or timeout."
      : "Bind the user's reply to exactly one interactionId. If more than one could match, ask which — do not guess.",
  };
}

// --- responsibility_status ----------------------------------------------------

export function runStatusTool(index: PendingIndex, params: ToolParams): StatusOutcome | ToolError {
  const selected = selectInteraction(index, readParam(params, "interactionId"));
  if (selected.ok === false) {
    return selected;
  }
  const it = selected.interaction;
  return {
    ok: true,
    interactionId: it.interactionId,
    stateVersion: it.stateVersion,
    stage: it.stage,
    summary: it.summary,
    offeredSlots: it.offeredSlots,
    ...(it.requestedWindowHint ? { requestedWindowHint: it.requestedWindowHint } : {}),
    ...(it.lastAskedToUser ? { lastAskedToUser: it.lastAskedToUser } : {}),
    ...(it.note ? { note: it.note } : {}),
  };
}

// --- shared validation for confirm/reject/change -----------------------------

function validateAction(
  index: PendingIndex,
  action: InteractionAction,
  params: ToolParams,
): { interaction: PendingInteraction } | ToolError {
  const selected = selectInteraction(index, readParam(params, "interactionId"));
  if (selected.ok === false) {
    return selected; // unknown_interaction / ambiguous / no_pending
  }
  const interaction = selected.interaction;

  // `userMessageId` is not part of the model-facing schema. index.ts inserts
  // it only after consuming a host-trusted inbound authorization binding.
  const userMessageId = readParam(params, "userMessageId");
  if (!userMessageId) {
    return {
      ok: false,
      error: "missing_user_message_id",
      message:
        "userMessageId is required so the action is bound to the message that authorized it.",
    };
  }

  const stateVersion = readParam(params, "stateVersion");
  if (stateVersion !== interaction.stateVersion) {
    return {
      ok: false,
      error: "state_version_mismatch",
      message:
        `stateVersion "${stateVersion || "(missing)"}" does not match the interaction's current ` +
        `"${interaction.stateVersion}". Re-read responsibility_pending and retry with the current value.`,
    };
  }

  if (!isActionAllowed(interaction, action)) {
    return {
      ok: false,
      error: "action_not_allowed_for_stage",
      message:
        `Action "${action}" is not allowed while interaction "${interaction.interactionId}" is in stage ` +
        `"${interaction.stage}"${action === "select_option" && interaction.offeredSlots.length === 0 ? " (no slots offered yet)" : ""}.`,
    };
  }

  return { interaction };
}

// Selection validation. `userMessageId` is populated internally from the
// trusted inbound binding (never model-supplied); the option is resolved by
// stable id first, then by an explicit displayed number, then by position only
// when no slot carries an explicit number.
export function runSelectOptionTool(
  index: PendingIndex,
  params: ToolParams,
  dryRun: boolean,
): DryRunOutcome | ToolError {
  const selected = selectInteraction(index, readParam(params, "interactionId"));
  if (selected.ok === false) {
    return selected;
  }
  const interaction = selected.interaction;
  if (!isActionAllowed(interaction, "select_option")) {
    return {
      ok: false,
      error: "action_not_allowed_for_stage",
      message:
        `Option selection is not allowed while interaction "${interaction.interactionId}" is in stage ` +
        `"${interaction.stage}"${interaction.offeredSlots.length === 0 ? " (no options offered yet)" : ""}.`,
    };
  }
  const userMessageId = readParam(params, "userMessageId");
  if (!userMessageId) {
    return {
      ok: false,
      error: "missing_user_message_id",
      message: "A trusted inbound message is required to select an option.",
    };
  }
  const optionId = readParam(params, "optionId");
  if (!optionId) {
    return {
      ok: false,
      error: "missing_option",
      message: "optionId is required to select an option.",
    };
  }
  let offered = interaction.offeredSlots.find((slot) => slot.id === optionId);
  if (!offered && /^[1-9]\d*$/.test(optionId)) {
    const displayedNumber = Number(optionId);
    if (Number.isSafeInteger(displayedNumber)) {
      const explicitlyNumbered = interaction.offeredSlots.filter(
        (slot) => slot.number === displayedNumber,
      );
      if (explicitlyNumbered.length === 1) {
        offered = explicitlyNumbered[0];
      } else if (
        explicitlyNumbered.length === 0 &&
        interaction.offeredSlots.every((slot) => slot.number === undefined)
      ) {
        offered = interaction.offeredSlots[displayedNumber - 1];
      }
    }
  }
  if (!offered) {
    return {
      ok: false,
      error: "slot_not_offered",
      message:
        `optionId "${optionId}" is not one of interaction "${interaction.interactionId}"'s offered options. ` +
        "To propose a different time, the responsibility must offer new slots first.",
    };
  }
  const canonicalOptionId = offered.id ?? offered.start;
  return {
    ok: true,
    dryRun,
    action: "select_option",
    interactionId: interaction.interactionId,
    stateVersion: interaction.stateVersion,
    wouldTransitionTo:
      interaction.stage === "awaiting_manager_selection" ? "awaiting_counterparty" : "scheduled",
    wouldPerform:
      `Would record confirmation of ${redactText(offered.display) || offered.start} for "${interaction.summary}" ` +
      "and hand off to the responsibility worker to book + reply.",
    accepted: {
      interactionId: interaction.interactionId,
      optionId: canonicalOptionId,
    },
  };
}

export function runRejectTool(
  index: PendingIndex,
  params: ToolParams,
  dryRun: boolean,
): DryRunOutcome | ToolError {
  const validated = validateAction(index, "reject", params);
  if ("ok" in validated && validated.ok === false) {
    return validated;
  }
  const { interaction } = validated as { interaction: PendingInteraction };
  const reason = readParam(params, "reason");
  if (!reason) {
    return {
      ok: false,
      error: "missing_reason",
      message: "reason is required to reject an interaction.",
    };
  }
  return {
    ok: true,
    dryRun,
    action: "reject",
    interactionId: interaction.interactionId,
    stateVersion: interaction.stateVersion,
    wouldTransitionTo: interaction.stage === "awaiting_manager_selection" ? "declined" : "closed",
    wouldPerform: `Would close "${interaction.summary}" as declined (${redactText(reason)}).`,
    accepted: { interactionId: interaction.interactionId, reason: redactText(reason) },
  };
}

export function runChangeTool(
  index: PendingIndex,
  params: ToolParams,
  dryRun: boolean,
): DryRunOutcome | ToolError {
  const validated = validateAction(index, "change", params);
  if ("ok" in validated && validated.ok === false) {
    return validated;
  }
  const { interaction } = validated as { interaction: PendingInteraction };
  const requestedWindow = readParam(params, "requestedWindow");
  if (!requestedWindow) {
    return {
      ok: false,
      error: "missing_requested_window",
      message: "requestedWindow is required to request a different time.",
    };
  }
  return {
    ok: true,
    dryRun,
    action: "change",
    interactionId: interaction.interactionId,
    stateVersion: interaction.stateVersion,
    wouldTransitionTo:
      interaction.stage === "awaiting_manager_selection" ? "needs_information" : "needs_info",
    wouldPerform:
      `Would ask the responsibility to recompute availability for "${interaction.summary}" around ` +
      `${redactText(requestedWindow)}.`,
    accepted: {
      interactionId: interaction.interactionId,
      requestedWindow: redactText(requestedWindow),
    },
  };
}

export { buildIndex };
