import { it, expect } from "vitest";
import { build } from "esbuild";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { MemoryDatabaseClient } from "../src/database-client";

it("cancels a worker transaction after its write and preserves another project's operations", async () => {
  const root = resolve("artifacts/memory-worker-tests");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "cancel-"));
  const workerPath = join(directory, "paused.cjs");
  const marker = join(directory, "write-started");
  // Deterministic scheduling seam: real repository transaction pauses before commit.
  await build({ stdin: { contents: `
    const { parentPort, workerData } = require("node:worker_threads");
    const { writeFileSync } = require("node:fs");
    const { MemoryRepository } = require(${JSON.stringify(resolve("plugins/memory/src/repository.ts"))});
    const repository = new MemoryRepository(workerData.databasePath);
    parentPort.on("message", ({ id, method, args, cancellation }) => {
      try {
        if (method === "close") { repository.close(); parentPort.postMessage({ id }); parentPort.close(); return; }
        const operation = () => {
          const result = repository[method](...args);
          if (method === "save" && cancellation) {
            writeFileSync(${JSON.stringify(marker)}, "ready");
            Atomics.wait(new Int32Array(cancellation), 0, 0, 10000);
          }
          return result;
        };
        const result = cancellation ? repository.runCancellable(operation, new Int32Array(cancellation)) : operation();
        parentPort.postMessage({ id, result });
      } catch (error) { parentPort.postMessage({ id, error: error.message }); }
    });
  `, resolveDir: resolve(".") }, outfile: workerPath, bundle: true, platform: "node", format: "cjs", packages: "external" });
  const client = new MemoryDatabaseClient(workerPath, join(directory, "memory.sqlite"));
  const controller = new AbortController();
  try {
    const pending = client.scoped(controller.signal).call("save", { scope: "project:a", text: "must roll back", source: "u1", status: "active" });
    const outcome = pending.then(() => "committed", () => "cancelled");
    await expect.poll(() => readFile(marker, "utf8").catch(() => ""), { timeout: 5000 }).toBe("ready");
    controller.abort();
    expect(await outcome).toBe("cancelled");
    expect(await client.call("list", ["project:a"], "", true)).toEqual([]);
    expect(await client.call("list", ["project:a"], "roll")).toEqual([]);
    await client.call("save", { scope: "project:b", text: "still available", source: "u2", status: "active" });
    expect(await client.call("list", ["project:b"])).toHaveLength(1);
  } finally { controller.abort(); await client.close(); }
});

it("runs the SQLite repository in a bundled worker and restores persisted records", async () => {
  const root = resolve("artifacts/memory-worker-tests");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "run-"));
  const workerPath = join(directory, "database.cjs");
  await build({ entryPoints: [resolve("plugins/memory/src/database.worker.ts")], outfile: workerPath, bundle: true, platform: "node", format: "cjs", packages: "external" });
  const path = join(directory, "memory.sqlite");
  const client = new MemoryDatabaseClient(workerPath, path);
  try {
    const saved = await client.call("save", { scope: "project:a", text: "构建使用 pnpm", source: "u1", status: "active" });
    expect((await client.call("list", ["project:a"], "pnpm"))[0]!.id).toBe(saved.id);
    await expect(client.call("forget", "project:b", saved.id, saved.revision)).rejects.toThrow("conflict");
  } finally { await client.close(); }
  await expect(client.call("list", ["project:a"])).rejects.toThrow("closed");
  const reopened = new MemoryDatabaseClient(workerPath, path);
  try { expect(await reopened.call("list", ["project:a"])).toHaveLength(1); }
  finally { await reopened.close(); }
});

it("rejects every pending operation when a worker stops answering and does not retry writes", async () => {
  const root = resolve("artifacts/memory-worker-tests");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "hung-"));
  const workerPath = join(directory, "hung.cjs");
  await writeFile(workerPath, "require('node:worker_threads').parentPort.on('message', () => {});");
  const client = new MemoryDatabaseClient(workerPath, join(directory, "unused.sqlite"), 100);
  const results = await Promise.allSettled([
    client.call("list", ["global"]),
    client.call("save", { scope: "global", text: "unknown outcome", source: "u1", status: "active" }),
  ]);
  expect(results.every(result => result.status === "rejected" && result.reason.message.includes("outcome is unknown"))).toBe(true);
  await expect(client.call("list", ["global"])).rejects.toThrow("closed");
  await client.close();
});
