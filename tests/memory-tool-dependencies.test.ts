import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { activate, deactivate } from "../src";
import { memoryResources } from "./memory-test-resources";

it("captures experience tool versions from host evidence and rejects reuse after upgrade or disable", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-tool-versions-"));
  const controller = new AbortController();
  try {
    const plugin = await activate({ pluginId: "modera.memory", storagePath: root, resourcePath: await memoryResources(), signal: controller.signal, grantedPermissions: new Set(["storage.read", "storage.write", "runs.observe", "models.generate"]), config: { read: async () => ({ revision: 1, values: { automaticLearning: true }, inherited: {}, overrides: {}, sources: {} }) } });
    const provenance = { tool: "fixture_tool", owner: "fixture.owner", version: "1.0" };
    const experience = { failure: { text: "Missing config", sourceId: "f" }, fix: { text: "Create config", sourceId: "x" }, verification: { text: "Fixture check passed", sourceId: "v" } };
    await plugin!.runCompleted!({ projectId: "p", sessionId: "prior", runId: "r", messages: Object.values(experience).map(step => ({ id: step.sourceId, role: "tool", text: step.text, toolProvenance: provenance })) }, { signal: controller.signal, generate: async () => JSON.stringify({ memories: [{ text: "recovery", sourceId: "v", experience }] }) });
    const context = { projectId: "p", sessionId: "new", runId: "r", signal: controller.signal, toolVersions: { fixture_tool: "fixture.owner@1.0" } };
    const tool = plugin!.tools![0]!;
    const listed = await tool.execute({ action: "list" }, context) as { memories: { id: string; scope: string; revision: number; source: string }[] };
    const candidate = listed.memories[0]!;
    expect(JSON.parse(candidate.source).toolDependencies).toEqual([provenance]);
    await plugin!.ui![0]!.act!({ id: "confirm", value: JSON.stringify(candidate) }, context, { id: plugin!.ui![0]!.id, sessionId: "new", locale: "en" });
    const validation = { action: "validate", id: candidate.id, revision: 2 };
    expect(await tool.execute(validation, context)).toMatchObject({ usable: true });
    await tool.execute({ action: "draft_skill", id: candidate.id, revision: 2 }, context);
    const upgraded = { ...context, toolVersions: { fixture_tool: "fixture.owner@2.0" } };
    expect(await tool.execute(validation, upgraded)).toEqual({ usable: false, reason: "dependencies_changed" });
    await expect(tool.execute({ action: "draft_skill", id: candidate.id, revision: 2 }, upgraded)).rejects.toThrow("revalidation");
    expect(JSON.stringify(await plugin!.contextProviders![0]!.provide({ ...upgraded, query: "config", maxChars: 2000 }))).toContain("STALE:");
    expect(await plugin!.validateSkillSource!(JSON.stringify({ scope: "project:p", id: candidate.id, revision: 2 }), { ...context, toolVersions: {} })).toBe(false);
  } finally { controller.abort(); await deactivate(); await rm(root, { recursive: true, force: true }); }
});
