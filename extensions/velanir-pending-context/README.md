# @openclaw/velanir-pending-context

`@openclaw/velanir-pending-context` makes an interactive scheduling reply safe
to interpret without treating an old transcript mirror as workflow state.

## Canonical 0.4.0 behavior

1. It reads pending state only from the responsibility runner and injects it
   only when the exact agent, channel, session/conversation, account, and
   authenticated user match. Strict user and session scope both default on.
2. It registers `responsibility_pending` first, then
   `responsibility_select_option`, `responsibility_reject`,
   `responsibility_change`, and `responsibility_status`. A model never passes a
   `userMessageId`; a host-observed inbound message is bound internally through
   the manifest-declared trusted tool policy.
3. It quiets only a fresh inbound run that has matching pending context. With
   `suppressNonFinalReplies=true` (the default), tool/progress reply payloads
   for that run are cancelled. Ordinary chat and stale/unscoped sessions are
   not put into global final-only mode.
4. The first admitted action ends the run's tool budget. Later tool calls are
   blocked. The final reply and the persisted assistant message are rewritten
   from the authoritative runner receipt; a model claim that a meeting was
   scheduled without an action is replaced with a truthful failure.
5. A scheduling-success final requires a non-dry-run `select_option` receipt
   with an Outlook event id, Zoom join URL, and counterpart-reply receipt.
   Partial results, errors, and dry runs never become success claims.

The package deliberately chose the stronger Riley/Mae common behavior as the
source of truth. It does not copy live compiled bytes or make ordinary Teams
chat quiet merely because a responsibility happens to have pending work.

## Rollout and rollback

`dryRun` defaults to `true`. Set it to `false` only for a reviewed canary.
That alone still cannot execute an effect: the source must declare an explicit
`actionCommand`; there is no default effect argv. Roll back immediately by
setting `dryRun` to `true`, or set `suppressNonFinalReplies` to `false` for
diagnosis while preserving the receipt/final guard.

The plugin requires an OpenClaw runtime compatible with `2026.7.2` or
newer and declares its trusted policy in `openclaw.plugin.json`. Platform
rendering/install work owns canary selection and the exact reviewed action
bridge; this package does not deploy itself or modify runner business logic.

## Develop

```bash
node scripts/run-vitest.mjs run extensions/velanir-pending-context/test
```

`DESIGN.md` documents the original phase-one pending-state contract. This README
and the source/tests are the canonical 0.4.0 finalization contract.
