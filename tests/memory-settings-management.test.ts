import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activate, deactivate } from "../src";
import { memoryResources } from "./memory-test-resources";

it("manages memory from settings without a synthetic session, enforcing scope and revisions", async () => {
  const storagePath = await mkdtemp(join(tmpdir(), "memory-settings-management-"));
  const controller = new AbortController();
  try {
    const plugin = await activate({ pluginId: "modera.memory", resourcePath: await memoryResources(), storagePath, signal: controller.signal, grantedPermissions: new Set(["storage.read", "storage.write", "workspace.read"]) });
    const act = (action: string, value: object = {}, projectId: string | undefined = "a") => plugin!.settings!.act({ id: "manage", value: JSON.stringify({ action, scope: "project", ...value }) }, { ...(projectId ? { projectId } : {}), signal: controller.signal });
    await act("add", { text: "Build with pnpm" });
    const list = await act("list") as { records: { id: string; revision: number; source: string }[] };
    const stored = list.records[0]!;
    const record = { id: stored.id, revision: stored.revision };
    expect(JSON.parse(stored.source)).not.toHaveProperty("sessionId");
    expect(await act("list", {}, "b")).toMatchObject({ records: [] });
    await expect(act("edit", { ...record, text: "other" }, "b")).rejects.toThrow();
    await act("edit", { ...record, text: "Build with npm" });
    await expect(act("forget", record)).rejects.toThrow();
    expect(await act("history", { id: record.id })).toHaveLength(2);
    await act("move", { id: record.id, revision: 2 });
    expect(await act("list")).toMatchObject({ records: [] });
    const global = await act("list", { scope: "global" }) as { records: { revision: number }[] };
    await act("forget", { scope: "global", id: record.id, revision: global.records[0]!.revision });
    expect(await act("list", { scope: "global" })).toMatchObject({ records: [] });
    await expect(act("list", { scope: "project:other" })).rejects.toThrow();
    expect(plugin!.ui!.find(ui => ui.id === "modera.memory.panel")!.slot).toBe("panel");
  } finally { controller.abort(); await deactivate(); await rm(storagePath, { recursive: true, force: true }); }
});
