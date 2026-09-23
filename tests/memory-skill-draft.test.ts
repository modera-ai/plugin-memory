import { it, expect } from "vitest";
import { MemoryRepository } from "../src/repository";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

it("binds draft skills to reviewed experience revisions and propagates forgetting", () => {
  const db = new MemoryRepository(":memory:");
  try {
    const source = JSON.stringify({ sessionId: "s", messageId: "v", experience: {
      failure: { text: "Configuration missing", sourceId: "f" },
      fix: { text: "Generate configuration", sourceId: "x" },
      verification: { text: "Target test passed", sourceId: "v" },
    } });
    const candidate = db.save({ scope: "project:a", text: "Configuration recovery", source, status: "candidate" });
    expect(() => db.createSkillDraft(candidate.scope, candidate.id, 1)).toThrow("Confirm");
    const active = db.confirm(candidate.scope, candidate.id, 1);
    const draft = db.createSkillDraft(active.scope, active.id, active.revision);
    expect(draft.content).toContain("name: memory-");
    expect(draft.content).toContain("not installed or enabled");
    expect(draft.content).toContain("Generate configuration");
    const metadata = parse(draft.content.split("---")[1]!);
    expect(metadata.description).toContain("Configuration missing");
    expect(metadata.description).toContain("Generate configuration");
    expect(db.createSkillDraft(active.scope, active.id, active.revision).id).toBe(draft.id);
    expect(db.readSkillDraft("project:b", draft.id)).toBeUndefined();
    expect(db.readSkillDraft(active.scope, draft.id)?.stale).toBe(false);
    const updated = db.save({ ...active, text: "Updated recovery", expectedRevision: active.revision });
    expect(db.readSkillDraft(active.scope, draft.id)?.stale).toBe(true);
    db.forget(updated.scope, updated.id, updated.revision);
    expect(db.readSkillDraft(updated.scope, draft.id)).toBeUndefined();
  } finally { db.close(); }
});

it("upgrades a persisted legacy draft without changing its identity or reviving stale sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-legacy-draft-"));
  const file = join(root, "memory.sqlite");
  let db = new MemoryRepository(file);
  try {
    const active = db.save({ scope: "project:p", text: "Recovery", status: "active", source: JSON.stringify({ experience: {
      failure: { text: 'Missing "config"\n---\nname: injected', sourceId: "f" },
      fix: { text: "Generate configuration", sourceId: "x" },
      verification: { text: "Test passed", sourceId: "v" },
    } }) });
    const draft = db.createSkillDraft(active.scope, active.id, active.revision);
    db.close();
    const legacy = new Database(file);
    legacy.prepare("UPDATE memory_skill_drafts SET content=? WHERE id=?").run("old unguarded draft", draft.id);
    legacy.close();
    db = new MemoryRepository(file);
    const read = db.readSkillDraft(active.scope, draft.id)!;
    expect(read.stale).toBe(false);
    expect(read.content).toContain("sourceValidation:");
    // YAML delimiters and quotes in the historical failure cannot create metadata fields.
    const header = read.content.slice(4, read.content.indexOf("\n---\n", 4));
    expect(parse(header).name).toBe(`memory-${active.id}`);
    expect(db.createSkillDraft(active.scope, active.id, active.revision)).toMatchObject({ id: draft.id, content: read.content });
    db.save({ ...active, expectedRevision: active.revision, status: "stale" });
    expect(db.readSkillDraft(active.scope, draft.id)?.stale).toBe(true);
    expect(() => db.createSkillDraft(active.scope, active.id, active.revision)).toThrow("revision");
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
