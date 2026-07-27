# Velanir Egress Guard

OpenClaw-native final-output shaping and outbound protection for Velanir
coworkers. The plugin keeps policy inside OpenClaw and uses generic Plugin SDK
hooks instead of Platform-owned install or delivery plumbing.

The two-stage design is intentional:

1. `before_agent_finalize` can ask the active coworker model for one bounded,
   context-aware wording pass. Because the original model still owns the final
   answer, verified outcomes and conversation context stay available.
2. `message_sending` runs a deterministic last-mile check over every protected
   outbound message, including message-tool and scheduled sends. It strips
   known runtime payloads, preserves safe user-facing text, and suppresses
   internal-only output without emitting canned fallback copy.

## Recommended `openclaw.json`

```json5
{
  plugins: {
    entries: {
      "velanir-egress-guard": {
        enabled: true,
        hooks: {
          timeouts: {
            before_agent_finalize: 15000,
            message_sending: 15000,
          },
        },
        config: {
          mode: "enforce",
          channels: ["slack", "msteams"],
          finalOutput: {
            mode: "always",
            style: "friendly",
            maxEmojis: 1,
            forbidEmDash: true,
          },
        },
      },
    },
  },
}
```

If `plugins.allow` is present, add `"velanir-egress-guard"` to that list. A
Gateway restart is required after plugin config changes.

## Rollout modes

- `off`: no revision, rewrite, or suppression. This is the package default.
- `shadow`: logs metadata-only decisions without changing delivery.
- `enforce`: applies final revision, deterministic cleanup, and suppression.

Use `finalOutput.mode: "when_needed"` to request an extra model pass only when
the deterministic evaluation detects protected or presentation content. Use
`"always"` when consistent business-facing output is more important than the
latency and token cost of one extra model pass. Each revision request is capped
at one attempt by an idempotency key.

The plugin logs only decision metadata, reason categories, channel, and text
lengths. It does not log message content.
