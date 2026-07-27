import { definePluginEntry } from "./api.js";
import { normalizeConfig } from "./config.js";
import { LlmUsageReporter } from "./reporter.js";
import type { AgentHookContext, LlmOutputEvent, ModelCallEndedEvent } from "./types.js";

export const PLUGIN_ID = "velanir-llm-usage-reporter";

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Velanir LLM Usage Reporter",
  description:
    "Reports normalized OpenClaw llm_output token usage to the Velanir runtime observability API using runtime DPoP authentication.",
  register(api) {
    const reporter = new LlmUsageReporter(normalizeConfig(api.pluginConfig), {
      logger: api.logger,
    });

    api.registerService({
      id: "llm-usage-reporter",
      start() {
        reporter.start();
      },
      async stop() {
        await reporter.stop();
      },
    });

    api.on("model_call_ended", (event) => {
      reporter.observeModelCallEnded(event as ModelCallEndedEvent);
    });
    api.on("llm_output", (event, ctx) => {
      reporter.enqueueFromLlmOutput(event as LlmOutputEvent, ctx as AgentHookContext);
    });
  },
});
