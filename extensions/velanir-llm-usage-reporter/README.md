# Velanir LLM Usage Reporter

OpenClaw plugin that reports per-call model usage from the OpenClaw
`llm_output` hook to the Velanir runtime observability API.

The plugin requires OpenClaw `2026.7.2` or newer. That
OpenClaw version documents conversation-observation hooks for
`model_call_started`, `model_call_ended`, `llm_input`, and `llm_output`; the
`llm_output` event includes normalized usage counters.

## Runtime Contract

The plugin posts batches to:

```text
POST /v1/runtime/observability/llm-usage
```

Authentication uses the existing runtime-v2 DPoP flow with scope
`observability:write`. The platform derives organization, coworker, runtime
identity, gateway, and deployment target from the runtime token; the plugin does
not send or own those identifiers.

## Privacy

By default the plugin does not send prompts, assistant text, or raw message
content. It sends token counts plus non-content metadata such as provider,
model, run id, session id, surface, trigger, and model-call timing.

Set `metadata.includeContent: true` only for local debugging.

## Config

```json
{
  "plugins": {
    "entries": {
      "velanir-llm-usage-reporter": {
        "enabled": true,
        "config": {
          "platform": {
            "baseUrl": "${OCT8_API_URL}",
            "endpointPath": "/v1/runtime/observability/llm-usage"
          },
          "batch": {
            "maxBatchSize": 20,
            "maxQueueSize": 2000,
            "flushIntervalMs": 5000,
            "requestTimeoutMs": 10000
          }
        }
      }
    }
  }
}
```

`platform.baseUrl` defaults to `OCT8_API_URL`, which is already part of the
runtime-v2 environment. The reporter fails open: ingest failures are logged and
queued for retry, but they do not block model execution or user-visible
delivery.
