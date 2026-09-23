import { expect, it } from "vitest";
import { MemoryRepository } from "../src/repository";

it("retrieves a translated extraction using its source language and removes evidence terms on edit or forget", () => {
  const db = new MemoryRepository(":memory:");
  try {
    db.enqueueEvidence("project:p", "s", "r", JSON.stringify({ evidence: [
      { id: "u", role: "user", text: "配置文件位于 config/runtime.toml" },
      { id: "unrelated", role: "user", text: "供应商海豚" },
    ] }));
    const job = db.claim(["project:p"], 0)!;
    db.commitJob(job.id, job.leaseToken, [{ text: "Configuration lives at config/runtime.toml", sourceId: "u" }], 1);
    const candidate = db.list(["project:p"], "配置文件", true)[0]!;
    expect(candidate.status).toBe("candidate");
    expect(db.list(["project:p"], "配置文件")).toEqual([]);
    const active = db.confirm("project:p", candidate.id, candidate.revision);
    expect(db.list(["project:p"], "配置文件").map(row => row.id)).toEqual([active.id]);
    expect(db.list(["project:other"], "配置文件")).toEqual([]);
    expect(db.list(["project:p"], "供应商海豚")).toEqual([]);
    const edited = db.save({ ...active, expectedRevision: active.revision, text: "Different fact", source: "manual edit" });
    expect(db.list(["project:p"], "配置文件")).toEqual([]);
    db.forget(edited.scope, edited.id, edited.revision);
    expect(db.list(["project:p"], "Different")).toEqual([]);
  } finally { db.close(); }
});

it("source-session deletion removes translated recall and suppresses replay", () => {
  const db = new MemoryRepository(":memory:");
  try {
    db.enqueueEvidence("project:p", "s", "r", JSON.stringify({ evidence: [{ id: "u", role: "user", text: "所有项目回复语言为英文" }] }));
    const job = db.claim(["project:p"], 0)!;
    db.commitJob(job.id, job.leaseToken, [{ text: "Reply in English", scope: "global", sourceId: "u" }], 1);
    const candidate = db.list(["global"], "", true)[0]!;
    db.confirm("global", candidate.id, 1);
    expect(db.list(["global"], "回复语言")).toHaveLength(1);
    db.forgetSession(["global", "project:p"], "s");
    expect(db.list(["global"], "回复语言")).toEqual([]);
    expect(db.list(["global"], "English")).toEqual([]);
    db.enqueueEvidence("project:p", "s", "r2", JSON.stringify({ evidence: [] }));
    expect(db.claim(["project:p"], 2)).toBeUndefined();
  } finally { db.close(); }
});
