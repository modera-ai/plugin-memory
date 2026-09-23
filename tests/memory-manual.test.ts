import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activate, deactivate } from "../src";
import { memoryResources } from "./memory-test-resources";

it("manually extracts with automatic learning off, scopes feedback and releases failed requests", async () => {
  const storagePath = await mkdtemp(join(tmpdir(), "memory-manual-"));
  const controller = new AbortController();
  const context = { projectId: "p", sessionId: "s", runId: "ui", signal: controller.signal };
  let background: Promise<void> | undefined;
  let finish!: () => void;
  let fail = false;
  try {
    const plugin = (await activate({
      pluginId: "modera.memory", resourcePath: await memoryResources(), storagePath,
      signal: controller.signal, grantedPermissions: new Set(["storage.read", "storage.write", "runs.observe", "models.generate"]),
      config: { read: async () => ({ revision: 1, values: { automaticLearning: false }, inherited: {}, overrides: {}, sources: {} }) },
      runBackground: (_task, run) => { background = run(controller.signal); },
      requestObservation: async () => {
        await new Promise<void>(resolve => { finish = resolve; });
        if (fail) throw new Error("offline");
        await plugin.runCompleted!({ ...context, runId: "manual", trigger: "manual", messages: [{ id: "u", role: "user", text: "Use pnpm" }] }, {
          signal: controller.signal, generate: async () => JSON.stringify({ memories: [{ text: "Use pnpm", sourceId: "u" }] }),
        });
      },
    }))!;
    const lever = plugin.ui!.find(ui => ui.slot === "conversation.composer")!;
    expect(plugin.contextProviders).toHaveLength(1);
    const activity = plugin.ui!.find(ui => ui.id.endsWith(".activity"))!;
    const request = { id: lever.id, sessionId: "s", locale: "zh-CN" };
    const action = { id: "extract", value: JSON.stringify({ profileId: "p", model: "m", reasoningEffort: "none" }) };
    await expect(lever.act!({ ...action, value: "{}" }, context, request)).rejects.toThrow();
    await lever.act!(action, context, request);
    expect(await activity.render(request, context)).toMatchObject({ data: { activity: { state: "running" } } });
    expect(await activity.render(request, { ...context, sessionId: "other" })).toMatchObject({ data: { activity: { state: "idle" } } });
    await expect(lever.act!(action, context, request)).rejects.toThrow("already running");
    finish(); await background;
    expect(await activity.render(request, context)).toMatchObject({ data: { activity: { state: "success" } } });
    expect(await plugin.tools![0]!.execute({ action: "list" }, context)).toMatchObject({ memories: [{ text: "Use pnpm" }] });
    fail = true;
    await lever.act!(action, context, request);
    finish(); await background;
    expect(await activity.render(request, context)).toMatchObject({ data: { activity: { state: "error" } } });
    expect(await lever.render(request, context)).toMatchObject({ badge: "idle" });
  } finally { controller.abort(); await deactivate(); await rm(storagePath, { recursive: true, force: true }); }
});
