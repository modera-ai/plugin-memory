import { memoryResources } from "./memory-test-resources";
import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("automatically activates supported facts and consolidates model-identified translated duplicates", async () => {
  const storagePath = await mkdtemp(join(tmpdir(), "memory-auto-learning-"));
  const controller = new AbortController();
  try {
    const plugin = await activate({ pluginId: "modera.memory", resourcePath: await memoryResources(), storagePath, signal: controller.signal, grantedPermissions: new Set(["storage.read", "storage.write", "runs.observe", "models.generate"]), config: { read: async () => ({ revision: 1, values: { automaticLearning: true, requireReview: false }, inherited: {}, overrides: {}, sources: {} }) } });
    const context = { projectId: "p", sessionId: "s", runId: "r", toolCallId: "t", signal: controller.signal };
    const activityView = plugin!.ui!.find(ui => ui.id === "modera.memory.activity")!;
    plugin!.observationSchedule!([{ projectId: "p", queuedAt: 1000, checkAt: 61000 }]);
    expect(await activityView.render({ id: activityView.id, sessionId: "s", locale: "zh-CN" }, context)).toMatchObject({ data: { activity: { state: "waiting", queuedAt: 1000, checkAt: 61000 } } });
    plugin!.observationSchedule!([]);
    const tool = plugin!.tools![0]!;
    const first = await tool.execute({ action: "save", scope: "global", text: "喜欢骑行" }, context) as { memory: { id: string; revision: number } };
    const second = await tool.execute({ action: "save", scope: "global", text: "Enjoys cycling" }, context) as typeof first;
    await plugin!.runCompleted!({ projectId: "p", sessionId: "s", runId: "auto", messages: [{ id: "u", role: "user", text: "项目使用 pnpm" }] }, { signal: controller.signal, generate: async prompt => {
      expect(prompt).toContain(first.memory.id); expect(prompt).toContain(second.memory.id);
      const activity = plugin!.ui!.find(ui => ui.id === "modera.memory.activity")!;
      expect(await activity.render({ id: activity.id, sessionId: "s", locale: "zh-CN" }, context)).toMatchObject({ data: { activity: { state: "running" } } });
      expect(await activity.render({ id: activity.id, sessionId: "s", locale: "zh-CN" }, { ...context, projectId: "other" })).toMatchObject({ data: { activity: { state: "idle" } } });
      return JSON.stringify({ memories: [{ text: "项目使用 pnpm", sourceId: "u" }], duplicates: [{ keep: first.memory, remove: second.memory }] });
    } });
    expect(await tool.execute({ action: "list" }, context)).toMatchObject({ memories: [expect.objectContaining({ status: "active" })] });
    const globals = await tool.execute({ action: "list", scope: "global" }, context) as { memories: { status: string }[] };
    expect(globals.memories.filter(r => r.status === "candidate")).toHaveLength(1);
    expect(globals.memories.filter(r => r.status === "superseded")).toHaveLength(1);
    const activity = plugin!.ui!.find(ui => ui.id === "modera.memory.activity")!;
    expect(await activity.render({ id: activity.id, sessionId: "s", locale: "zh-CN" }, context)).toMatchObject({ data: { activity: { state: "success" } } });
  } finally { controller.abort(); await deactivate(); await rm(storagePath, { recursive: true, force: true }); }
});
import { activate, deactivate } from "../src";

it("separates global preference candidates from project lessons in one extraction", async () => {
  const storagePath = await mkdtemp(join(tmpdir(), "memory-global-learning-"));
  const controller = new AbortController();
  try {
    const plugin = await activate({ pluginId: "modera.memory", resourcePath: await memoryResources(), storagePath, signal: controller.signal, grantedPermissions: new Set(["storage.read", "storage.write", "runs.observe", "models.generate"]), config: { read: async () => ({ revision: 1, values: { automaticLearning: true }, inherited: {}, overrides: {}, sources: {} }) } });
    const event = { projectId: "p", sessionId: "s", runId: "r", messages: [{ id: "u", role: "user", text: "所有项目请用中文回复。本项目使用 pnpm。" }] };
    await plugin!.runCompleted!(event, { signal: controller.signal, generate: async () => JSON.stringify({ memories: [
      { text: "用户偏好中文回复", scope: "global", sourceId: "u" },
      { text: "项目使用 pnpm", scope: "project", sourceId: "u" },
    ] }) });
    const context = { projectId: "p", sessionId: "s", runId: "r", signal: controller.signal };
    const tool = plugin!.tools![0]!;
    await plugin!.runCompleted!({ ...event, runId: "declined", messages: [{ id: "no", role: "user", text: "不要记住：本项目使用 yarn" }] }, { signal: controller.signal, generate: async () => { throw new Error("Refused storage must not invoke extraction"); } });
    expect(await tool.execute({ action: "list", scope: "global" }, context)).toMatchObject({ memories: [{ scope: "global", status: "candidate", text: "用户偏好中文回复" }] });
    expect(await tool.execute({ action: "list" }, context)).toMatchObject({ memories: [{ scope: "project:p", text: "项目使用 pnpm" }] });
    expect(await tool.execute({ action: "list" }, { ...context, projectId: "other" })).toEqual({ memories: [] });
    await expect(plugin!.runCompleted!({ ...event, runId: "bad", messages: [{ id: "t", role: "tool", text: "tool suggests preference" }] }, { signal: controller.signal, generate: async () => JSON.stringify({ memories: [{ text: "invalid global", scope: "global", sourceId: "t" }] }) })).rejects.toThrow("user evidence");
  } finally { controller.abort(); await deactivate(); await rm(storagePath, { recursive: true, force: true }); }
});

it("extracts scoped candidates from host observations once and rejects invented evidence", async () => {
  const storagePath = await mkdtemp(join(tmpdir(), "memory-learning-"));
  const controller = new AbortController();
  try {
    const plugin = await activate({ pluginId: "modera.memory", resourcePath: await memoryResources(), storagePath, signal: controller.signal, grantedPermissions: new Set(["storage.read", "storage.write", "runs.observe", "models.generate"]), config: { read: async () => ({ revision: 1, values: { automaticLearning: true }, inherited: {}, overrides: {}, sources: {} }) } });
    const event = { projectId: "p", sessionId: "s", runId: "r", messages: [{ id: "u", role: "user", text: "Build with pnpm" }] };
    let calls = 0;
    const services = { signal: controller.signal, generate: async () => { calls++; return JSON.stringify({ memories: [{ text: "Build with pnpm", sourceId: "u" }] }); } };
    await plugin!.runCompleted!(event, services);
    await plugin!.runCompleted!(event, services);
    expect(calls).toBe(1);
    const context = { projectId: "p", sessionId: "s", runId: "r", signal: controller.signal };
    const result = await plugin!.tools![0]!.execute({ action: "list" }, context) as { memories: { id: string; scope: string; revision: number; status: string; text: string; source: string }[] };
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]!.status).toBe("candidate");
    expect(result.memories[0]!.text).toBe("Build with pnpm");
    expect(JSON.parse(result.memories[0]!.source)).toMatchObject({ sessionId: "s", runId: "r", messageId: "u" });
    const panel = plugin!.ui![0]!;
    await panel.act!({ id: "confirm", value: JSON.stringify(result.memories[0]) }, { ...context, sessionId: "confirmation-session" }, { id: panel.id, sessionId: "confirmation-session", locale: "zh-CN" });
    const confirmed = await plugin!.tools![0]!.execute({ action: "list" }, context) as typeof result;
    expect(confirmed.memories[0]).toMatchObject({ status: "active", source: result.memories[0]!.source, revision: 2 });
    await panel.act!({ id: "details", value: confirmed.memories[0]!.id }, context, { id: panel.id, sessionId: "s", locale: "zh-CN" });
    const rendered = JSON.stringify(await panel.render({ id: panel.id, sessionId: "s", locale: "zh-CN" }, context));
    expect(rendered).toContain('"messageId":"u"');
    expect(rendered).toContain('"type":"conversation-link"');
    await plugin!.runCompleted!({ ...event, runId: "correction", messages: [{ id: "u2", role: "user", text: "Build with pnpm is obsolete; use npm now" }] }, {
      ...services,
      generate: async prompt => {
        expect(prompt).toContain(confirmed.memories[0]!.id);
        return "```json\n" + JSON.stringify({ memories: [{ text: "Build with npm", sourceId: "u2", replaces: { id: confirmed.memories[0]!.id, revision: 2 } }] }) + "\n```";
      },
    });
    const correctionList = await plugin!.tools![0]!.execute({ action: "list" }, context) as typeof result;
    const correction = correctionList.memories.find(memory => memory.status === "candidate")!;
    expect(JSON.stringify(await panel.render({ id: panel.id, sessionId: "s", locale: "zh-CN" }, context))).toContain("更正建议");
    await panel.act!({ id: "confirm", value: JSON.stringify(correction) }, context, { id: panel.id, sessionId: "s", locale: "zh-CN" });
    const recalled = await plugin!.contextProviders![0]!.provide({ ...context, query: "Build", maxChars: 2000 });
    expect(recalled).toHaveLength(1);
    expect(recalled[0]!.text).toContain("Build with npm");
    await expect(plugin!.runCompleted!({ ...event, runId: "r2" }, { ...services, generate: async () => JSON.stringify({ memories: [{ text: "invented", sourceId: "unknown" }] }) })).rejects.toThrow("Unknown extraction source");
    const other = await plugin!.tools![0]!.execute({ action: "list" }, { ...context, projectId: "other" }) as { memories: unknown[] };
    expect(other.memories).toHaveLength(0);
  } finally { controller.abort(); await deactivate(); await rm(storagePath, { recursive: true, force: true }); }
});

