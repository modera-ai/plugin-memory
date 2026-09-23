import type { MemoryRecord } from "./repository";

/** A portable page of current records, not a database or conversation backup. */
export function exportMemoryPage(scope: string, records: readonly MemoryRecord[], offset: number, format: "json" | "markdown"): string {
  if (records.some(record => record.scope !== scope)) throw new Error("Export scope mismatch");
  const snapshot = { format: "modera.memory", version: 1, scope, exportedAt: new Date().toISOString(),
    offset, nextOffset: records.length === 100 ? offset + 100 : null,
    contents: "Current records only; revision history, original conversations, jobs and suppression markers are not included.", records };
  if (format === "json") return JSON.stringify(snapshot, null, 2) + "\n";
  const sections = records.map(record => {
    // Fencing makes arbitrary memory text/source metadata literal in Markdown readers.
    const serialized = JSON.stringify(record, null, 2);
    const longest = Math.max(2, ...(serialized.match(/`+/g) ?? []).map(run => run.length));
    const fence = "`".repeat(longest + 1);
    return `${fence}json\n${serialized}\n${fence}`;
  });
  return `# Modera memory export\n\nScope: ${JSON.stringify(scope)}\n\nExported: ${snapshot.exportedAt}\n\nOffset: ${offset}; next offset: ${snapshot.nextOffset ?? "none"}\n\n${snapshot.contents}\n\n${sections.join("\n\n")}\n`;
}
