# Velanir OpenClaw Participation Gate

OpenClaw plugin that decides whether a digital coworker should participate in a shared channel, group, room, or thread before the main agent runs.

The plugin is designed for the `requireMention: false` use case: the coworker can observe channel traffic, but should only answer when the current turn is actually for that coworker.

## Package

- Package: `@openclaw/velanir-participation-gate`
- OpenClaw plugin id: `velanir-participation-gate`
- Runtime hooks: `before_dispatch`, `before_tool_call`, `message_sending`,
  `message_sent`, `reply_payload_sending`
- Default mode: `shadow`
- Default delivery mode: `passthrough`
- Target OpenClaw plugin API: `>=2026.7.2`

The OpenClaw fork owns the source under `extensions/velanir-participation-gate`.

## Behavior

Direct messages always pass through. The gate only evaluates group and channel messages.

For group and channel messages, the plugin:

1. Records recent shared-room user and coworker messages for fallback context.
2. Loads participation context for the current coworker.
3. Applies deterministic rules:
   - respond when the message clearly addresses this coworker
   - skip when the message clearly addresses another known coworker
   - treat sentence-start requests such as `Albus I need you to...` as direct address without hardcoding coworker names
4. Calls a lightweight classifier when deterministic rules do not decide the turn.
5. Returns `{ handled: true }` only when the decision is skip and `mode` is `enforce`.

Explicit mentions still bypass classifier enforcement, but the inbound turn is
recorded before bypass so later unmentioned follow-ups have context. Successful
`message_sent` events and final `reply_payload_sending` payloads are also
recorded as coworker replies, which lets the classifier recognize follow-ups
after this coworker already answered. Duplicate outbound hook records are
deduped before they reach classifier context.

Any missing runtime dependency, missing context, invalid classifier output, classifier timeout, or classifier error fails open and lets the coworker respond. This is deliberate because false silence is worse than an occasional extra reply while the plugin is being rolled out.

## Turn Delivery Coalescer

The `delivery` config controls what the user actually sees for one inbound
turn. It is independent of the participation decision above.

- `passthrough` (default): the plugin does not alter delivery at all. This is
  the rollback value.
- `coalesce`: the plugin tracks each inbound turn by its exact session key
  (falling back to provider+conversation, then channel) and enforces
  final-only delivery for that turn:
  - Non-final reply payloads (`kind: "tool"` / `"block"`) are cancelled.
  - At most `maxProgressMessages` (0 or 1) generic progress updates may
    deliver, and only after `quietWindowMs` of silence. The progress text is
    always the configured `progressText`; model-authored narration is never
    exposed. `maxProgressMessages: 0` means fully silent until the final.
  - Exactly one final reply payload is admitted per turn. Duplicate finals for
    the same turn or the same `runId` are cancelled.
  - A `message` tool `send` call targeting the active inbound conversation is
    blocked before execution (`before_tool_call`), so the model cannot bypass
    the final-reply boundary by messaging the conversation directly. Sends to
    unrelated destinations, other providers, or from sessions with no tracked
    inbound turn (proactive and scheduled sends) are not affected.
  - Direct outbound egress (`message_sending`) to the active conversation is
    allowed only when it corresponds to the final payload the coalescer
    already admitted.
- Turn state expires after `turnTtlMs` so an abandoned turn cannot silence a
  conversation indefinitely.

Delivery state is process-shared across plugin re-registers, so a gateway
config reload does not reset duplicate-final protection for an in-flight turn.

### Rollback

Set `delivery.mode` back to `passthrough` (or remove the `delivery` block) and
refresh the runtime config. No uninstall or version change is required; every
delivery hook becomes a no-op. Anything other than an explicit
`"coalesce"` value normalizes to `passthrough`.

## Classifier Contract

The classifier returns a scored participation decision:

```json
{ "participationScore": 0.83 }
```

The plugin participates when `participationScore >= classifier.threshold`. The default threshold is `0.7`.

Legacy `{ "shouldRespond": true|false }` output is still accepted for
compatibility, but the prompt asks for `participationScore` only.
If the classifier output is malformed, the plugin retries once with a strict
JSON repair prompt. If the score can still be recovered from truncated output,
the recovered score is used for the skip/respond decision. If the retry is still
malformed with no recoverable score, the plugin fails open with score `1.0` and
logs `classifier_malformed` instead of treating it as a clean `classifier_true`.

`classifier.maxOutputTokens` limits the classifier response only. It does not cap input context.

Normal decision logs include the participation score, threshold, classifier
prompt version, prompt hash, input hash, parse status, attempt count, output
hash, output length, recent message count, and recent user/assistant role
counts. Exact rendered prompt/input/raw classifier output and parse errors are
logged only when `logging.classifierDebug` and `logging.includeContent` are
both enabled.

## Context Contract

Production context should come from the platform:

```http
GET /v1/runtime/coworkers/{coworkerId}/participation-context
Authorization: DPoP <scoped runtime token>
DPoP: <proof for this GET request>
Accept: application/json
```

Expected response:

```json
{
  "data": {
    "self": {
      "id": "coworker_albus",
      "names": ["Albus", "Albus Dumbledore"],
      "roleSummary": "Executive assistant for Diagon leadership"
    },
    "coworkers": [
      {
        "id": "coworker_tanya",
        "names": ["Tanya", "Tanya Dean", "Tanya Morales"],
        "roleSummary": "Executive assistant"
      }
    ]
  }
}
```

The Platform endpoint must use the runtime identity protocol. The provider defaults to `platform.authMode: "runtime"`, requests `scope=participation-context:read` from `/v1/runtime/token`, and signs a DPoP proof for each context read.

The endpoint must be derived from platform-owned coworker and organization data. Adding or removing a digital coworker should not require editing plugin configuration on customer machines.

`names` should include display names, short names, and channel-specific aliases or mention tokens when the platform knows them. The deterministic direct-address rules depend on these aliases, and the classifier receives the same identity set.

Static context exists only for tests and local development.

## Security

The platform provider intentionally does not fall back to a broad `OCT8_API_SECRET`.

The production credential is a short-lived, DPoP-bound runtime token that can only read the current coworker's participation context. Static `platform.token` / `OCT8_PARTICIPATION_CONTEXT_TOKEN` is only read when `platform.authMode` is explicitly set to `static-token`; that mode remains prototype-only and must not be used to bypass runtime identity in live customer deployments.

Runtime mode expects the same runtime identity environment used by `oct8-secrets-runtime-v2`: `OCT8_API_URL`, `OCT8_RUNTIME_IDENTITY_ID`, `OCT8_RUNTIME_STATE_DIR`, and optionally `OCT8_RUNTIME_TOKEN_ISSUER` / `OCT8_RUNTIME_KEY_ID`. It does not read `OCT8_API_SECRET`.

## Example Config

```json
{
  "mode": "shadow",
  "classifier": {
    "provider": "openai-codex",
    "model": "gpt-5.5",
    "timeoutMs": 5000,
    "maxOutputTokens": 32,
    "threshold": 0.7
  },
  "context": {
    "source": "platform",
    "maxMessages": 5,
    "refreshMs": 300000
  },
  "platform": {
    "authMode": "runtime",
    "baseUrl": "https://api.velanir.ai",
    "coworkerId": "coworker_albus"
  },
  "delivery": {
    "mode": "passthrough",
    "quietWindowMs": 45000,
    "maxProgressMessages": 1,
    "turnTtlMs": 600000
  },
  "logging": {
    "decisions": true,
    "includeContent": false,
    "classifierDebug": false
  }
}
```

Use `shadow` first to validate decisions in logs. Move to `enforce` only after the classifier and context source are behaving as expected. Platform-rendered configs should choose the coworker's configured OpenClaw model/provider unless an explicit classifier override is present.

## Development

```sh
node scripts/run-vitest.mjs run extensions/velanir-participation-gate/test
```
