import { it, expect } from "vitest";
import { MemoryRepository } from "../src/repository";

it("forgets historical session sources and blocks new messages from the same source within authorized scopes", () => {
  const db = new MemoryRepository(":memory:");
  const source = (sessionId: string, messageId = "u") => JSON.stringify({ sessionId, messageId });
  try {
    const original = db.save({ scope: "project:a", text: "old evidence", source: source("deleted"), status: "active" });
    db.save({ ...original, text: "later revision", source: source("editor"), expectedRevision: original.revision });
    db.save({ scope: "global", text: "promoted preference", source: source("deleted"), status: "active" });
    db.save({ scope: "project:b", text: "isolated evidence", source: source("deleted"), status: "active" });
    db.save({ scope: "project:a", text: "unrelated evidence", source: source("other"), status: "active" });
    db.enqueueEvidence("project:a", "deleted", "run", JSON.stringify({ evidence: [] }));
    expect(db.forgetSession(["project:a", "global"], "deleted")).toBe(2);
    expect(db.history("project:a", original.id)).toEqual([]);
    expect(db.list(["project:a"], "later")).toEqual([]);
    expect(db.list(["project:a"], "", true).map(item => item.text)).toEqual(["unrelated evidence"]);
    expect(db.list(["project:b"], "", true)).toHaveLength(1);
    expect(db.jobSettled("project:a", "deleted", "run")).toBe(true);
    expect(() => db.save({ scope: "project:a", text: "new extraction", source: source("deleted", "new-message"), status: "candidate" })).toThrow("suppressed");
    db.enqueueEvidence("project:a", "deleted", "late-run", JSON.stringify({ evidence: [] }));
    expect(db.jobSettled("project:a", "deleted", "late-run")).toBe(true);
    expect(db.forgetSession(["project:a", "global"], "deleted")).toBe(0);
  } finally { db.close(); }
});
