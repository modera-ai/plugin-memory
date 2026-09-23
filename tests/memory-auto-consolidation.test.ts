import { expect, it } from "vitest";
import { MemoryRepository } from "../src/repository";

it("auto-activates supported new facts but keeps review, corrections and truncated evidence gated", () => {
  const db = new MemoryRepository(":memory:");
  try {
    const extract = (cursor: string, review: boolean, truncated = false, replaces?: { id: string; revision: number }) => {
      db.enqueueEvidence("project:p", "s", cursor, JSON.stringify({ truncated, evidence: [{ id: cursor, role: "user", text: cursor }] }));
      const job = db.claim(["project:p"], 0, { sessionId: "s", cursor })!;
      db.commitJob(job.id, job.leaseToken, [{ text: cursor, sourceId: cursor, ...(replaces ? { replaces } : {}) }], 1, review);
      return db.list(["project:p"], "", true).find(r => r.text === cursor)!;
    };
    const active = extract("new", false);
    expect(active.status).toBe("active");
    expect(extract("manual", true).status).toBe("candidate");
    expect(extract("partial", false, true).status).toBe("candidate");
    expect(extract("correction", false, false, active).status).toBe("candidate");
    expect(db.get(active.scope, active.id)?.status).toBe("active");
  } finally { db.close(); }
});

it("consolidates equivalent records without scope leakage, status downgrade or lost revision history", () => {
  const db = new MemoryRepository(":memory:");
  const save = (text: string, status: "active" | "candidate", scope = "global") => db.save({ text, status, scope, source: JSON.stringify({ sessionId: text + status, messageId: "u" }) });
  try {
    const active = save("喜欢骑行", "active");
    const duplicate = save("喜欢骑行", "candidate");
    expect(db.consolidate(["global"])).toBe(1);
    expect(db.get("global", duplicate.id)?.status).toBe("superseded");
    expect(db.history("global", duplicate.id)).toHaveLength(2);
    const translated = save("Enjoys cycling", "candidate");
    expect(db.mergeDuplicate(["global"], active, translated)).toBe(true);
    const opposite = save("不喜欢骑行", "candidate");
    expect(db.mergeDuplicate(["global"], active, opposite)).toBe(false);
    const other = save("喜欢骑行", "candidate", "project:p");
    expect(db.mergeDuplicate(["global", "project:p"], active, other)).toBe(false);
    const stale = save("Cycling is a hobby", "candidate");
    expect(db.mergeDuplicate(["global"], { ...active, revision: 99 }, stale)).toBe(false);
    db.forget("global", active.id, active.revision);
    expect(() => db.save({ text: "Enjoys cycling again", scope: "global", status: "candidate", source: translated.source })).toThrow("suppressed");
    expect(db.list(["global"])).toHaveLength(0);
  } finally { db.close(); }
});
