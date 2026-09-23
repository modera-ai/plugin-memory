import { it, expect } from "vitest";
import { MemoryRepository } from "../src/repository";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("confirms corrections atomically and refuses changed targets or cross-scope moves", () => {
  const db = new MemoryRepository(":memory:");
  try {
    const old = db.save({ scope: "project:a", text: "build pnpm", status: "active", source: JSON.stringify({ sessionId: "s", messageId: "old" }) });
    db.enqueueEvidence(old.scope, "s", "r", JSON.stringify({ evidence: [{ id: "u", text: "use npm now" }] }));
    const job = db.claim([old.scope], 0)!;
    db.commitJob(job.id, job.leaseToken, [{ text: "build npm", sourceId: "u", replaces: { id: old.id, revision: old.revision } }], 1);
    const candidate = db.list([old.scope], "", true).find(record => record.status === "candidate")!;
    expect(db.list([old.scope]).map(record => record.text)).toEqual(["build pnpm"]);
    expect(() => db.move(old.scope, candidate.id, 1, "global")).toThrow("original scope");
    const confirmed = db.confirm(old.scope, candidate.id, 1);
    expect(confirmed.status).toBe("active");
    expect(db.list([old.scope]).map(record => record.text)).toEqual(["build npm"]);
    expect(db.get(old.scope, old.id)?.status).toBe("superseded");
    expect(db.history(old.scope, old.id).map(record => record.status)).toEqual(["superseded", "active"]);
    db.enqueueEvidence(old.scope, "s", "duplicate", JSON.stringify({ evidence: [{ id: "another", text: "build npm" }] }));
    const duplicate = db.claim([old.scope], 2)!;
    expect(db.commitJob(duplicate.id, duplicate.leaseToken, [{ text: "build npm", sourceId: "another" }], 3)).toBe(0);
    const stale = db.save({ scope: old.scope, text: "different correction", status: "candidate", source: candidate.source });
    expect(() => db.confirm(old.scope, stale.id, 1)).toThrow("target changed");
    expect(db.get(old.scope, stale.id)?.status).toBe("candidate");
    db.enqueueEvidence(old.scope, "s", "old-replayed", JSON.stringify({ evidence: [{ id: "old", text: "build pnpm" }] }));
    const replay = db.claim([old.scope], 2)!;
    expect(db.commitJob(replay.id, replay.leaseToken, [{ text: "build pnpm again", sourceId: "old" }], 3)).toBe(0);
    db.forget(old.scope, confirmed.id, confirmed.revision);
    expect(db.list([old.scope])).toEqual([]);
    expect(db.get(old.scope, old.id)?.status).toBe("superseded");
  } finally { db.close(); }
});

it("does not revive a forgotten message through another job, while retaining unrelated evidence", () => {
  const db = new MemoryRepository(":memory:");
  try {
    const evidence = JSON.stringify({ evidence: [{ id: "u", text: "old" }, { id: "v", text: "other" }] });
    db.enqueueEvidence("project:a", "s", "r1", evidence);
    const first = db.claim(["project:a"], 0)!;
    db.commitJob(first.id, first.leaseToken, [{ text: "old", sourceId: "u" }], 1);
    db.enqueueEvidence("project:a", "s", "r2", evidence);
    const inFlight = db.claim(["project:a"], 2)!;
    const memory = db.list(["project:a"], "", true)[0]!;
    db.forget(memory.scope, memory.id, memory.revision);
    db.commitJob(inFlight.id, inFlight.leaseToken, [{ text: "paraphrased old", sourceId: "u" }, { text: "other", sourceId: "v" }], 3);
    expect(db.list(["project:a"], "", true).map(row => row.text)).toEqual(["other"]);
    expect(db.jobSettled("project:a", "s", "r2", 4)).toBe(true);
    expect(() => db.save({ scope: "project:a", text: "revival", status: "active", source: JSON.stringify({ messageId: "u", sessionId: "s", jobId: "different" }) })).toThrow("suppressed");
    expect(() => db.save({ scope: "project:b", text: "separate", status: "active", source: memory.source })).not.toThrow();
  } finally { db.close(); }
});

it("does not acknowledge the final live attempt and settles exhausted leases as failures", () => {
  const db = new MemoryRepository(":memory:");
  try {
    db.enqueueEvidence("project:a", "s", "r", "original");
    let now = 0;
    for (let attempt = 1; attempt <= 4; attempt++) {
      const job = db.claim(["project:a"], now)!;
      db.finishJob(job.id, job.leaseToken, false, now + 1);
      now += 60_001;
    }
    const final = db.claim(["project:a"], now)!;
    expect(db.jobSettled("project:a", "s", "r", now + 1)).toBe(false);
    expect(db.jobEvidence(final.id, final.leaseToken, now + 1)).toBe("original");
    expect(db.claim(["project:a"], now + 1)).toBeUndefined();
    expect(db.jobSettled("project:a", "s", "r", now + 120_000)).toBe(true);
    expect(db.jobStatus(["project:a"])[0]).toMatchObject({ state: "failed", attempts: 5 });
    expect(() => db.commitJob(final.id, final.leaseToken, [{ text: "late", sourceId: "u" }], now + 120_001)).toThrow("revoked");
    db.enqueueEvidence("project:a", "s", "r", "must not revive");
    expect(db.claim(["project:a"], now + 200_000)).toBeUndefined();
  } finally { db.close(); }
});

it("deduplicates extraction jobs, reclaims expired leases and rejects late writers", () => {
  const db = new MemoryRepository(":memory:");
  try {
    db.enqueueEvidence("project:a", "s", "turn1", JSON.stringify({ evidence: [{ id: "u", text: "new evidence" }] }));
    db.enqueueEvidence("project:a", "s", "turn1", JSON.stringify({ evidence: [{ id: "u", text: "new evidence" }] }));
    expect(db.claim(["project:b"], 0)).toBeUndefined();
    const first = db.claim(["project:a"], 0)!;
    expect(db.claim(["project:a"], 1)).toBeUndefined();
    const second = db.claim(["project:a"], 120001)!;
    expect(first.id).toBe(second.id);
    expect(first.leaseToken).not.toBe(second.leaseToken);
    expect(() => db.commitJob(first.id, first.leaseToken, [{ text: "obsolete", sourceId: "u" }], 120002)).toThrow("revoked");
    db.commitJob(second.id, second.leaseToken, [{ text: "new evidence", sourceId: "u" }], 120002);
    db.jobResult(second.id, "model completed", { inputTokens: 100, outputTokens: 10 });
    db.jobResult(second.id, "retry completed", { inputTokens: 50, outputTokens: 5 });
    db.jobResult(second.id, "extracted");
    expect(db.jobStatus(["project:a"])[0]).toMatchObject({ state: "done", inputTokens: 150, outputTokens: 15, detail: "extracted" });
    expect(db.jobStatus(["project:b"])).toEqual([]);
    expect(db.claim(["project:a"], 120003)).toBeUndefined();
    expect(db.list(["project:a"], "", true)).toHaveLength(1);
    expect(db.list(["project:a"])).toHaveLength(0);
  } finally { db.close(); }
});

it("restores exact extraction evidence after restart and clears it on completion or cancellation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "memory-job-recovery-"));
  const path = join(directory, "memory.sqlite");
  const first = new MemoryRepository(path);
  first.enqueueEvidence("project:a", "s", "r", JSON.stringify({ evidence: [{ id: "u", text: "original evidence" }] }));
  first.close();
  const restored = new MemoryRepository(path);
  try {
    const job = restored.claim(["project:a"], 0)!;
    expect(restored.jobEvidence(job.id, job.leaseToken, 1)).toContain("original evidence");
    restored.commitJob(job.id, job.leaseToken, [], 2);
    expect(() => restored.jobEvidence(job.id, job.leaseToken, 3)).toThrow();
    restored.enqueueEvidence("project:a", "s", "r2", "{}");
    const other = restored.claim(["project:a"], 4)!;
    restored.cancelSessionJobs("project:a", "s");
    expect(() => restored.jobEvidence(other.id, other.leaseToken, 5)).toThrow();
    restored.enqueueEvidence("project:a", "s", "r2", "should not revive");
    expect(restored.claim(["project:a"], 6)).toBeUndefined();
  } finally { restored.close(); await rm(directory, { recursive: true, force: true }); }
});

it("cancellation invalidates jobs and candidate batch failures roll back all writes", () => {
  const db = new MemoryRepository(":memory:");
  try {
    db.enqueueEvidence("global", "s", "turn1", JSON.stringify({ evidence: [{ id: "u", text: "valid" }] }));
    const job = db.claim(["global"], 0)!;
    expect(() => db.commitJob(job.id, job.leaseToken, [{ text: "valid", sourceId: "u" }, { text: "", sourceId: "u" }], 1)).toThrow();
    expect(() => db.commitJob(job.id, job.leaseToken, [{ text: "valid", sourceId: "u" }, { text: "invented", sourceId: "missing" }], 1)).toThrow("Unknown extraction source");
    expect(db.list(["global"], "", true)).toHaveLength(0);
    db.cancelSessionJobs("global", "s");
    expect(() => db.commitJob(job.id, job.leaseToken, [{ text: "late result", sourceId: "u" }], 2)).toThrow("revoked");
    db.enqueueEvidence("global", "s", "turn1", JSON.stringify({ evidence: [{ id: "u", text: "valid" }] }));
    expect(db.claim(["global"], 3)).toBeUndefined();
  } finally { db.close(); }
});

