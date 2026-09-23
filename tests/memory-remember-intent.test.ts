import { expect, it } from "vitest";
import { rememberIntent } from "../src/remember-intent";
import { MemoryRepository } from "../src/repository";

it("activates complete direct commands, not quoted tasks or partial claims", () => {
  for (const text of ["请记住：使用 npm", 'remember: "使用 npm"', "Please remember that 使用 npm.", "save this to memory: 使用 npm"])
    expect(rememberIntent(text, "使用 npm")).toBe("explicit");
  for (const text of ["请翻译：remember 使用 npm", '他说“请记住：使用 npm”', "Do you remember 使用 npm?", "请记住：不要使用 npm", "请记住：使用 npm，但是只限本周"])
    expect(rememberIntent(text, "使用 npm")).toBe("candidate");
  expect(rememberIntent("请记住：不要使用 npm", "不要使用 npm")).toBe("explicit");
  expect(rememberIntent("Please remember to use npm?", "to use npm")).toBe("candidate");
});

it("rejects explicit storage refusals and cancels only their extraction run", () => {
  for (const text of ["不要记住：使用 npm", "请不要保存任何记忆", "别记录这个", "Don't remember this", "Please do not store this", "Never save this"])
    expect(rememberIntent(text, "使用 npm")).toBe("denied");
  const db = new MemoryRepository(":memory:");
  try {
    db.enqueueEvidence("project:p", "s", "denied", "private snapshot");
    db.enqueueEvidence("project:p", "s", "other", "other snapshot");
    const job = db.claim(["project:p"], 0, { sessionId: "s", cursor: "denied" })!;
    db.cancelRunJob("project:p", "s", "denied");
    expect(db.jobSettled("project:p", "s", "denied", 1)).toBe(true);
    expect(() => db.jobEvidence(job.id, job.leaseToken, 1)).toThrow();
    expect(db.claim(["project:p"], 2, { sessionId: "s", cursor: "other" })).toBeDefined();
  } finally { db.close(); }
});
