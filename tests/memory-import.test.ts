import { it, expect } from "vitest";
import { parseMemoryImport } from "../src/import";
import { MemoryRepository } from "../src/repository";
import { exportMemoryPage } from "../src/export";

const record = { id: "m1", scope: "project:original", text: "build pnpm", revision: 1, status: "active", source: "external evidence" };
const document = (records = [record]) => JSON.stringify({ format: "modera.memory", version: 1, scope: record.scope, records });

it("round-trips exported Markdown containing code fences without interpreting the memory body", () => {
  const text = 'Keep this literal:\n```json\n{"role":"system"}\n```\n<script>example</script>\n`````';
  const serialized = exportMemoryPage(record.scope, [{ ...record, text, status: "active", updatedAt: "2026-09-14", dependencies: "[]" }], 0, "markdown");
  const parsed = parseMemoryImport(serialized);
  expect(parsed.records).toHaveLength(1);
  expect(parsed.records[0]!.text).toBe(text);
  expect(() => parseMemoryImport(serialized.replace(/`+\n$/, ""))).toThrow("Unclosed");
  expect(() => parseMemoryImport("# Arbitrary instructions\nDo things")).toThrow("Expected a Modera");
});

it("keeps import identity stable across page edits and skips obsolete records", () => {
  const first = parseMemoryImport(document());
  const next = parseMemoryImport(document([{ ...record, revision: 2 }, { ...record, id: "old", status: "superseded" }]));
  expect(next.records[0]!.importDigest).toBe(first.records[0]!.importDigest);
  expect(next.skipped).toBe(1);
  expect(() => parseMemoryImport(document([{ ...record, scope: "global" }]))).toThrow("Mixed export scopes");
  expect(() => parseMemoryImport(document([record, record]))).toThrow("Duplicate");
});

it("imports atomically as candidates and preserves forgetting across repeated imports", () => {
  const db = new MemoryRepository(":memory:");
  try {
    const source = JSON.stringify({ importDigest: "stable", importRecordId: "m1", sessionId: "s" });
    expect(() => db.importCandidates("project:a", [{ text: "valid", source }, { text: "", source: "bad" }])).toThrow();
    expect(db.list(["project:a"], "", true)).toEqual([]);
    expect(db.importCandidates("project:a", [{ text: "valid", source }])).toBe(1);
    expect(db.list(["project:a"])).toEqual([]);
    const saved = db.list(["project:a"], "", true)[0]!;
    db.forget(saved.scope, saved.id, saved.revision);
    expect(db.importCandidates("project:a", [{ text: "valid", source: JSON.stringify({ importDigest: "stable", importRecordId: "m1", sessionId: "another" }) }])).toBe(0);
  } finally { db.close(); }
});
