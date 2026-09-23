import manifest from "../plugin.json";
import { declaredTool } from "@modera/plugin-sdk";
import type { HistoryCommand, PluginContext, ToolContribution } from "@modera/plugin-sdk";

export const historyDefinition = declaredTool(manifest, "memory_history");

export function historyTool(host: PluginContext): ToolContribution {
  return { definition: historyDefinition, execute: async (input, context) => {
    if (!host.history) throw new Error("History capability unavailable");
    return host.history.execute(input as HistoryCommand, context);
  } };
}
