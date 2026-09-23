import { it, expect } from "vitest";
import { extractionPrompt } from "../src/extraction-prompt";

it("bounds serialized comparison context without changing evidence or accepting hidden targets", () => {
  const evidence = [{ id: "u", text: "a".repeat(13500) }];
  const records = Array.from({ length: 8 }, (_, index) => ({ id: `r${index}`, revision: 1, text: "\u0000".repeat(800), source: "not needed" }));
  const result = extractionPrompt({ truncated: true, evidence }, records);
  expect(result.instructions.length).toBeLessThanOrEqual(16000);
  const payload = JSON.parse(result.instructions.slice(result.instructions.indexOf('{"truncated":')));
  expect(payload.evidence).toEqual(evidence);
  expect(payload.existingOmitted).toBe(true);
  expect(payload.existing).toEqual(result.existing);
  expect(result.existing.length).toBeLessThan(5);
  expect(extractionPrompt({ truncated: false, evidence: [] }, records).existing[0]).toMatchObject({ truncated: true });
  expect(result.instructions).not.toContain("not needed");
  expect(records[0]!.text.length).toBe(800);
});

it("rejects oversized evidence instead of silently truncating its provenance", () => {
  expect(() => extractionPrompt({ truncated: false, evidence: [{ text: "x".repeat(16000) }] }, [])).toThrow("evidence exceeds");
});
