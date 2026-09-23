import { memoryResources } from "./memory-test-resources";
import { it, expect } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activate, deactivate } from "../src";

it("honors the deletion choice for both global and project memory through the worker", async () => {
  const storagePath = await mkdtemp(join(tmpdir(), "memory-session-cleanup-"));
  const controller = new AbortController();
  try {
    const plugin = await activate({ pluginId: "modera.memory", resourcePath: await memoryResources(), storagePath, signal: controller.signal, grantedPermissions: new Set(["storage.read", "storage.write", "runs.observe"]) });
    const context = { projectId: "a", sessionId: "deleted-source", runId: "r", toolCallId: "t", signal: controller.signal, userMessage: { id: "u", text: "请记住：中文回复" } };
    const tool = plugin!.tools![0]!;
    await tool.execute({ action: "save", scope: "global", text: "中文回复" }, context);
    await tool.execute({ action: "save", text: "中文回复" }, context);
    await plugin!.sessionDeleted!({ sessionId: context.sessionId, projectId: "a", forgetDerivedData: false }, controller.signal);
    expect(await tool.execute({ action: "list" }, context)).toMatchObject({ memories: [expect.anything()] });
    await plugin!.sessionDeleted!({ sessionId: context.sessionId, projectId: "a", forgetDerivedData: true }, controller.signal);
    expect(await tool.execute({ action: "list" }, context)).toEqual({ memories: [] });
    expect(await tool.execute({ action: "list", scope: "global" }, context)).toEqual({ memories: [] });
    await expect(tool.execute({ action: "save", text: "中文回复" }, context)).rejects.toThrow("suppressed");
  } finally { controller.abort(); await deactivate(); await rm(storagePath, { recursive: true, force: true }); }
});

it("checks project dependencies during recall without leaking them into global or other projects", async () => {
  const storagePath = await mkdtemp(join(tmpdir(), "memory-validity-"));
  const controller = new AbortController();
  try {
    await writeFile(join(storagePath, "package.json"), '{"packageManager":"pnpm"}');
    const plugin = await activate({ pluginId: "modera.memory", resourcePath: await memoryResources(), storagePath, signal: controller.signal, grantedPermissions: new Set(["storage.read", "storage.write", "workspace.read"]) });
    const context = { projectId: "a", workspacePath: storagePath, sessionId: "s1", runId: "r1", toolCallId: "t1", signal: controller.signal, userMessage: { id: "u1", text: "请记住：构建使用 pnpm" } };
    const tool = plugin!.tools![0]!;
    const result = await tool.execute({ action: "save", text: "构建使用 pnpm", files: ["package.json"] }, context) as { memory: { id: string; revision: number; scope: string } };
    const provider = plugin!.contextProviders![0]!;
    const request = { ...context, sessionId: "s2", query: "pnpm", maxChars: 2000 };
    expect((await provider.provide(request))[0]!.text).not.toContain("STALE:");
    await writeFile(join(storagePath, "package.json"), '{"packageManager":"npm"}');
    expect((await provider.provide(request))[0]!.text).toContain("STALE:");
    expect(await provider.provide({ ...request, projectId: "b" })).toHaveLength(0);
    const { projectId: _projectId, ...globalRequest } = request;
    expect(await provider.provide(globalRequest)).toHaveLength(0);
    const panel = plugin!.ui![0]!;
    await expect(panel.act!({ id: "moveGlobal", value: JSON.stringify(result.memory) }, context, { id: panel.id, sessionId: "s1", locale: "zh-CN" })).rejects.toThrow();
    await expect(tool.execute({ action: "save", scope: "global", text: "构建使用 pnpm", files: ["package.json"] }, context)).rejects.toThrow("project workspace");
  } finally { controller.abort(); await deactivate(); await rm(storagePath, { recursive: true, force: true }); }
});

it("uses UI-confirmed global and project memories across sessions and stops on disable", async () => {
  const storagePath = await mkdtemp(join(tmpdir(), "memory-plugin-"));
  const controller = new AbortController();
  const context = { projectId: "a", sessionId: "s1", runId: "r1", signal: controller.signal };
  try {
    const plugin = await activate({ pluginId: "modera.memory", resourcePath: await memoryResources(), storagePath, signal: controller.signal, grantedPermissions: new Set(["storage.read", "storage.write"]) });
    const panel = plugin!.ui![0]!;
    const request = { id: panel.id, sessionId: "s1", locale: "zh-CN" };
    await panel.act!({ id: "addGlobal", value: "默认中文回复" }, context, request);
    await panel.act!({ id: "addProject", value: "项目构建使用 pnpm" }, context, request);
    const exported = await plugin!.tools![0]!.execute({ action: "export", format: "json" }, context) as { path: string; count: number };
    const snapshot = JSON.parse(await readFile(exported.path, "utf8"));
    expect(exported.count).toBe(1);
    expect(snapshot.scope).toBe("project:a");
    expect(snapshot.records.map((record: { text: string }) => record.text)).toEqual(["项目构建使用 pnpm"]);
    const imported = await plugin!.tools![0]!.execute({ action: "import", document: JSON.stringify(snapshot) }, { ...context, projectId: "b", toolCallId: "import-call" });
    expect(imported).toMatchObject({ added: 1 });
    const importedRecords = await plugin!.tools![0]!.execute({ action: "list" }, { ...context, projectId: "b" }) as { memories: { status: string; scope: string }[] };
    expect(importedRecords.memories[0]).toMatchObject({ status: "candidate", scope: "project:b" });
    const markdown = await plugin!.tools![0]!.execute({ action: "export", format: "markdown", scope: "global" }, context) as { path: string };
    expect(await readFile(markdown.path, "utf8")).toContain("默认中文回复");
    expect(await readFile(markdown.path, "utf8")).not.toContain("项目构建使用 pnpm");
    const read = plugin!.contextProviders![0]!;
    const next = { ...context, sessionId: "s2", query: "中文 pnpm", maxChars: 2000 };
    expect(await read.provide(next)).toHaveLength(2);
    expect(await read.provide({ ...next, projectId: "b" })).toHaveLength(1);
    const projectRecords = await plugin!.tools![0]!.execute({ action: "list" }, context) as { memories: { id: string; scope: string; revision: number }[] };
    const projectRecord = projectRecords.memories[0]!;
    await panel.act!({ id: "edit", value: JSON.stringify({ context: JSON.stringify(projectRecord), text: "项目构建使用 yarn" }) }, context, request);
    expect((await read.provide({ ...next, query: "yarn" }))[0]!.text).toContain("yarn");
    const history = await plugin!.tools![0]!.execute({ action: "history", id: projectRecord.id }, context) as { revisions: { text: string }[] };
    expect(history.revisions.map(item => item.text)).toEqual(["项目构建使用 yarn", "项目构建使用 pnpm"]);
    await panel.act!({ id: "history", value: JSON.stringify(projectRecord) }, context, request);
    expect(JSON.stringify(await panel.render(request, context))).toContain("版本历史");
    await expect(panel.act!({ id: "forget", value: JSON.stringify(projectRecord) }, context, request)).rejects.toThrow("conflict");
    await panel.act!({ id: "moveGlobal", value: JSON.stringify({ ...projectRecord, revision: 2 }) }, context, request);
    expect(await read.provide({ ...next, projectId: "b", query: "yarn" })).toHaveLength(1);
    const tool = plugin!.tools![0]!;
    await tool.execute({ action: "save", text: "项目 pnpm 候选" }, { ...context, toolCallId: "call1" });
    expect(await read.provide(next)).toHaveLength(1);
    controller.abort();
    await expect(read.provide(next)).rejects.toThrow();
  } finally { controller.abort(); await deactivate(); await rm(storagePath, { recursive: true, force: true }); }
});

it("activates exact user-requested memory with runtime provenance, retaining paraphrases as candidates", async () => {
  const storagePath = await mkdtemp(join(tmpdir(), "memory-explicit-"));
  const controller = new AbortController();
  try {
    const plugin = await activate({ pluginId: "modera.memory", resourcePath: await memoryResources(), storagePath, signal: controller.signal, grantedPermissions: new Set(["storage.read", "storage.write"]) });
    const context = { projectId: "a", sessionId: "s1", runId: "r1", toolCallId: "t1", signal: controller.signal, userMessage: { id: "u1", text: "请记住：构建使用 pnpm" } };
    await plugin!.tools![0]!.execute({ action: "save", text: "构建使用 pnpm" }, context);
    await plugin!.tools![0]!.execute({ action: "save", text: "已经成功构建 pnpm 项目" }, { ...context, toolCallId: "t2" });
    const memories = await plugin!.contextProviders![0]!.provide({ ...context, query: "pnpm", maxChars: 2000 });
    expect(memories).toHaveLength(1);
    expect(memories[0]!.text).toContain('"messageId":"u1"');
    await expect(plugin!.tools![0]!.execute({ action: "save", text: "构建使用 yarn" }, { ...context, userMessage: { id: "u2", text: "不要记住：构建使用 yarn" } })).rejects.toThrow("declined");
    const quoted = await plugin!.tools![0]!.execute({ action: "save", text: "构建使用 yarn" }, { ...context, userMessage: { id: "u3", text: "翻译这句话：请记住：构建使用 yarn" } }) as { memory: { status: string } };
    expect(quoted.memory.status).toBe("candidate");
  } finally { controller.abort(); await deactivate(); await rm(storagePath, { recursive: true, force: true }); }
});

