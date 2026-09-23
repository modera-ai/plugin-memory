import { expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryRepository } from "../src/repository";
import { normalizedVector, OllamaEmbeddings } from "../src/embeddings";
import { activate, deactivate } from "../src";
import { memoryResources } from "./memory-test-resources";

it("binds vector retrieval to scope, model digest and current active revision", () => {
  const db = new MemoryRepository(":memory:");
  try {
    const key = "a".repeat(64);
    const record = db.save({ scope: "project:p", text: "Deployment in Frankfurt", source: "s", status: "active" });
    expect(db.pendingVectors([record.scope], key)).toHaveLength(1);
    expect(db.putVectors([record.scope], key, [{ id: record.id, revision: record.revision, vector: [2, 0] }])).toBe(1);
    expect(db.pendingVectors([record.scope], key)).toEqual([]);
    expect(db.searchVectors([record.scope], key, [1, 0])[0]!.id).toBe(record.id);
    expect(db.searchVectors(["project:other"], key, [1, 0])).toEqual([]);
    expect(db.searchVectors([record.scope], "b".repeat(64), [1, 0])).toEqual([]);
    expect(db.searchVectors([record.scope], key, [1, 0, 0])).toEqual([]);
    expect(db.clearVectors(["project:other"])).toBe(0);
    expect(db.clearVectors([record.scope])).toBe(1);
    expect(db.pendingVectors([record.scope], key)).toHaveLength(1);
    const edited = db.save({ ...record, expectedRevision: record.revision, text: "Deployment in Tokyo" });
    expect(db.searchVectors([record.scope], key, [1, 0])).toEqual([]);
    expect(db.putVectors([record.scope], key, [{ id: record.id, revision: record.revision, vector: [1, 0] }])).toBe(0);
    db.forget(edited.scope, edited.id, edited.revision);
    expect(db.putVectors([record.scope], key, [{ id: edited.id, revision: edited.revision, vector: [1, 0] }])).toBe(0);
  } finally { db.close(); }
});

it("rejects remote endpoints, credentials and invalid vectors", () => {
  for (const endpoint of ["https://example.com", "http://user:pass@localhost", "http://127.0.0.1/path"])
    expect(() => new OllamaEmbeddings(endpoint, "model")).toThrow();
  for (const vector of [[], [0, 0], [Infinity], [NaN], ["1"], Array(4097).fill(1)]) expect(() => normalizedVector(vector)).toThrow();
});

it("uses the real worker and local API protocol for hybrid recall, rebuild and outage fallback", async () => {
  let digest = "a".repeat(64);
  let unavailable = false;
  let stalled = false;
  let changeDuringEmbedding = false;
  const server = createServer(async (request, response) => {
    if (stalled) return;
    if (unavailable) { response.writeHead(503).end(); return; }
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/tags") { response.end(JSON.stringify({ models: [{ name: "fixture:latest", digest }] })); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString()) as { input: string[] };
    if (changeDuringEmbedding) digest = "c".repeat(64);
    response.end(JSON.stringify({ embeddings: input.input.map(text => text.includes("unrelated") ? [0, 1] : [1, 0]) }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const root = await mkdtemp(join(tmpdir(), "memory-semantic-"));
  const controller = new AbortController();
  try {
    const db = new MemoryRepository(join(root, "memory.sqlite"));
    const record = db.save({ scope: "project:p", text: "Deployment in Frankfurt", source: "s", status: "active" });
    db.save({ scope: "project:other", text: "Other project deployment", source: "x", status: "active" });
    db.save({ scope: "project:p", text: "unrelated", source: "y", status: "active" });
    db.close();
    const plugin = await activate({ pluginId: "modera.memory", storagePath: root, resourcePath: await memoryResources(), signal: controller.signal, grantedPermissions: new Set(["storage.read", "storage.write", "network.fetch"]), config: { read: async () => ({ revision: 1, values: { semanticRecall: true, embeddingEndpoint: endpoint, embeddingModel: "fixture" }, overrides: {}, inherited: {}, sources: {} }) } });
    const context = { projectId: "p", sessionId: "new", runId: "r", signal: controller.signal };
    expect(await plugin!.settings!.act({ id: "rebuildSemantic", value: "project" }, context)).toEqual({ indexed: 2, remaining: false });
    const recall = (query: string) => plugin!.contextProviders![0]!.provide({ ...context, query, maxChars: 2000 });
    expect((await recall("发布地区")).map(item => item.id)).toEqual([record.id]);
    unavailable = true;
    expect((await recall("Deployment")).map(item => item.id)).toEqual([record.id]);
    unavailable = false;
    stalled = true;
    expect((await recall("Deployment")).map(item => item.id)).toEqual([record.id]);
    stalled = false;
    digest = "b".repeat(64);
    expect(await recall("发布地区")).toEqual([]);
    expect(await plugin!.settings!.act({ id: "rebuildSemantic", value: "project" }, context)).toMatchObject({ indexed: 2 });
    expect(await recall("发布地区")).toHaveLength(1);
    changeDuringEmbedding = true;
    expect(await recall("发布地区")).toEqual([]);
    changeDuringEmbedding = false;
    await plugin!.tools![0]!.execute({ action: "forget", id: record.id, revision: record.revision }, context);
    expect(await recall("Deployment")).toEqual([]);
  } finally {
    controller.abort(); await deactivate(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
