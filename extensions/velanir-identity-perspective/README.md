# Velanir Identity Perspective

This plugin corrects outbound identity perspective at OpenClaw delivery time.
It converts references to the speaking coworker into first person. References
to a configured relationship, such as a manager, become second person only
when the outbound target is verified against a managed provider user id or an
explicit reviewed channel target.

The live Mae prototype hard-coded a machine path, coworker names, a mailbox
session prefix, and a Microsoft Teams-only delivery contract. This version
removes those customer-specific assumptions:

- `identityFile` is required and must be an absolute reviewed path.
- names and provider user ids come from the managed Identity Links block;
- channels and supplemental immutable recipient targets are configuration;
- mailbox formatting is not part of identity perspective.

Quoted text is preserved. If the coworker still refers to itself in third
person outside a quote after rewriting, delivery is cancelled rather than
silently emitting an identity-confused message.

Example:

```json
{
  "identityFile": "/srv/openclaw/workspace/AGENTS.md",
  "recipientRole": "manager",
  "channels": ["msteams"],
  "recipientTargets": [
    {
      "channel": "msteams",
      "target": "reviewed-conversation-id"
    }
  ]
}
```

Run the focused tests with:

```sh
node scripts/run-vitest.mjs run extensions/velanir-identity-perspective/test
```
