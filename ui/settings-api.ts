import { frontend } from "@modera/plugin-sdk/react";
import type { PluginConfigValues } from "@modera/contracts";

// The host permits one request per surface. Serialize configuration and library work.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work);
  queue = result.catch(() => {});
  return result;
}
export const memorySettings = {
  read: (scope: "global" | "project") => serial(() => frontend().settings.read(scope)),
  save: (revision: number, values: PluginConfigValues, scope: "global" | "project") => serial(() => frontend().settings.save(revision, values, scope)),
  action: (id: string, value: string) => serial(() => frontend().settings.action(id, value)),
};
