import { describe, it, expect } from "vitest";
import { MemoryRepository } from "../src/repository";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("migrates legacy suppression metadata to stable hashes without retaining source text", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-suppression-"));
  const path = join(root, "memory.sqlite");
  try {
    new MemoryRepository(path).close();
    const legacy = new Database(path);
    legacy.prepare("INSERT INTO memory_suppressions VALUES (?,?)").run("project:a", JSON.stringify({ sessionId: "s", messageId: "u", jobId: "old" }));
    legacy.close();
    const migrated = new MemoryRepository(path);
    try {
      expect(() => migrated.save({ scope: "project:a", text: "forgotten", status: "candidate", source: JSON.stringify({ jobId: "new", messageId: "u", sessionId: "s" }) })).toThrow("suppressed");
    } finally { migrated.close(); }
    const inspected = new Database(path);
    try {
      expect(inspected.prepare("SELECT source FROM memory_suppressions").all()).toEqual([{ source: expect.stringMatching(/^memory-source:v1:[a-f0-9]{64}$/) }]);
    } finally { inspected.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

describe("memory persistence", () => {
  it("rolls back a cancelled operation including nested revision and FTS writes", () => {
    const db = new MemoryRepository(":memory:");
    const cancellation = new Int32Array(new SharedArrayBuffer(4));
    try {
      expect(() => db.runCancellable(() => {
        db.save({ scope: "project:a", text: "cancelled memory", source: "s", status: "active" });
        Atomics.store(cancellation, 0, 1);
      }, cancellation)).toThrow("cancelled");
      expect(db.list(["project:a"], "", true)).toEqual([]);
      expect(db.list(["project:a"], "cancelled")).toEqual([]);
    } finally { db.close(); }
  });
  it("paginates revisions and never exposes prior-project history after a scope move", () => {
    const db = new MemoryRepository(":memory:");
    try {
      let record = db.save({ scope: "project:a", text: "version 1", source: "original", status: "active" });
      for (let revision = 2; revision <= 25; revision++) record = db.save({ ...record, text: `version ${revision}`, expectedRevision: record.revision });
      expect(db.history("project:a", record.id)).toHaveLength(20);
      expect(db.history("project:a", record.id, 20).map(item => item.revision)).toEqual([5, 4, 3, 2, 1]);
      expect(db.history("project:b", record.id)).toEqual([]);
      const moved = db.move(record.scope, record.id, record.revision, "global");
      expect(db.history("global", record.id).map(item => item.revision)).toEqual([26]);
      expect(db.history("project:a", record.id)).toEqual([]);
      db.forget("global", record.id, moved.revision);
      expect(db.history("global", record.id)).toEqual([]);
    } finally { db.close(); }
  });
  it("retrieves global and selected project memories with Chinese and identifier queries", () => {
    const db = new MemoryRepository(":memory:");
    try {
      db.save({scope: "global", text: "偏好中文回复", source: "s1", status: "active"});
      db.save({scope: "project:a", text: "使用 pnpm 执行构建", source: "s2", status: "active"});
      db.save({scope: "project:b", text: "使用 npm 执行构建", source: "s3", status: "active"});
      expect(db.list(["global", "project:a"], "中文")).toHaveLength(1);
      expect(db.list(["global", "project:a"], "构建").map(item => item.scope)).toEqual(["project:a"]);
      expect(db.list(["project:a"], "pnpm")).toHaveLength(1);
      expect(db.list(["project:a"], "npm")).toHaveLength(0);
    } finally { db.close(); }
  });
  it("rejects cross-scope updates, stale revisions and re-extraction of all forgotten revisions", () => {
    const db = new MemoryRepository(":memory:");
    try {
      const original = {scope: "project:a", text: "npm", source: "source1", status: "active" as const};
      const record = db.save(original);
      expect(() => db.save({...original, scope: "project:b", id: record.id, expectedRevision: 1})).toThrow("conflict");
      const revised = db.save({...original, text: "pnpm", source: "source2", id: record.id, expectedRevision: 1});
      expect(() => db.forget(original.scope, record.id, 1)).toThrow("conflict");
      db.forget(original.scope, record.id, revised.revision);
      expect(db.list([original.scope], "pnpm")).toEqual([]);
      expect(() => db.save(original)).toThrow("suppressed");
      expect(() => db.save({...original, source: "source2"})).toThrow("suppressed");
    } finally { db.close(); }
  });
});
