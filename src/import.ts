import { z } from "zod";
import { createHash } from "node:crypto";

const snapshotSchema = z.object({
  format: z.literal("modera.memory"), version: z.literal(1), scope: z.string().min(1).max(200),
  records: z.array(z.object({
    id: z.string().min(1).max(200), scope: z.string().min(1).max(200), text: z.string().trim().min(1).max(4000),
    revision: z.number().int().positive(), status: z.enum(["active", "candidate", "stale", "superseded"]),
    source: z.string().max(20000),
  })).max(100),
});

function parseMarkdown(document: string): unknown {
  const lines = document.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "# Modera memory export") throw new Error("Expected a Modera JSON or Markdown export");
  const scopeLine = lines.find(line => line.startsWith("Scope: "));
  if (!scopeLine) throw new Error("Markdown export scope is missing");
  const records: unknown[] = [];
  for (let index = 0; index < lines.length; index++) {
    const match = /^(`{3,})json$/.exec(lines[index]!);
    if (!match) continue;
    const start = ++index;
    while (index < lines.length && lines[index] !== match[1]) index++;
    if (index === lines.length) throw new Error("Unclosed Markdown export record");
    records.push(JSON.parse(lines.slice(start, index).join("\n")));
    if (records.length > 100) throw new Error("Too many Markdown export records");
  }
  return { format: "modera.memory", version: 1, scope: JSON.parse(scopeLine.slice(7)), records };
}

export function parseMemoryImport(document: string) {
  if (document.length > 1_000_000) throw new Error("Import exceeds 1 million characters; import one exported page at a time");
  const snapshot = snapshotSchema.parse(document.trimStart().startsWith("{") ? JSON.parse(document) : parseMarkdown(document));
  if (snapshot.records.some(record => record.scope !== snapshot.scope)) throw new Error("Mixed export scopes are not supported");
  if (new Set(snapshot.records.map(record => record.id)).size !== snapshot.records.length) throw new Error("Duplicate import record IDs");
  return {
    records: snapshot.records.filter(record => record.status === "active" || record.status === "candidate").map(record => ({
      ...record,
      importDigest: createHash("sha256").update(JSON.stringify([snapshot.scope, record.id])).digest("hex"),
      sourceHash: createHash("sha256").update(record.source).digest("hex"),
    })),
    skipped: snapshot.records.filter(record => record.status === "stale" || record.status === "superseded").length,
  };
}
