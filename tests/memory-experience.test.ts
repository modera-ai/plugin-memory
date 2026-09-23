import { it, expect } from "vitest";
import { experienceText, validateExperience } from "../src/experience";
import { MemoryRepository } from "../src/repository";

const experience = {
  failure: { text: "Test failed with stale configuration", sourceId: "failure" },
  fix: { text: "Regenerated configuration", sourceId: "fix" },
  verification: { text: "The relevant test passed", sourceId: "verification" },
};
const evidence = [{ id: "failure", role: "tool" }, { id: "fix", role: "tool" }, { id: "verification", role: "tool" }];
it("persists experience provenance as a candidate and rejects fabricated verification at commit", () => {
  const db = new MemoryRepository(":memory:");
  try {
    db.enqueueEvidence("project:a", "s", "r", JSON.stringify({ evidence }));
    const job = db.claim(["project:a"], 0)!;
    const text = experienceText(experience);
    expect(() => db.commitJob(job.id, job.leaseToken, [{ text, sourceId: "verification", experience: { ...experience, verification: { text: "fabricated", sourceId: "missing" } } }], 1)).toThrow("Unknown experience source");
    expect(db.commitJob(job.id, job.leaseToken, [{ text, sourceId: "verification", experience }], 2)).toBe(1);
    expect(db.list(["project:a"])).toHaveLength(0);
    const candidate = db.list(["project:a"], "", true)[0]!;
    expect(JSON.parse(candidate.source).experience).toEqual(experience);
    expect(candidate.status).toBe("candidate");
    db.forget(candidate.scope, candidate.id, candidate.revision);
    for (const message of evidence) {
      expect(() => db.save({ scope: candidate.scope, text: "re-extracted fragment", status: "candidate", source: JSON.stringify({ sessionId: "s", messageId: message.id }) })).toThrow("suppressed");
    }
    expect(() => db.save({ scope: "project:other", text: "separate scope", status: "candidate", source: candidate.source })).not.toThrow();
  } finally { db.close(); }
});
it("requires evidence for each experience step and a complete tool verification", () => {
  expect(experienceText(validateExperience(experience, evidence))).toContain("Regenerated configuration");
  expect(() => validateExperience(experience, evidence.slice(1))).toThrow("Unknown experience source");
  expect(() => validateExperience(experience, evidence.map(message => ({ ...message, role: "assistant" })))).toThrow("tool result");
  expect(() => validateExperience(experience, evidence.map(message => ({ ...message, truncated: true })))).toThrow("untruncated");
  expect(() => validateExperience({ ...experience, permissions: ["execute"] }, evidence)).toThrow();
});
