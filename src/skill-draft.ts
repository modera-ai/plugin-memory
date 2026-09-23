import type { MemoryRecord } from "./repository";
import type { MemoryExperience } from "./experience";

export function skillDraftContent(record: MemoryRecord): string {
  if (record.status !== "active") throw new Error("Confirm the experience before drafting a skill");
  const source = JSON.parse(record.source) as { experience?: MemoryExperience };
  if (!source.experience) throw new Error("A structured failure-repair experience is required");
  const description = JSON.stringify(`Recovery for: ${source.experience.failure.text.replace(/\s+/g, " ").slice(0, 220)}. Recorded repair: ${source.experience.fix.text.replace(/\s+/g, " ").slice(0, 220)}. Check source validity and applicability before use.`);
  const evidence = JSON.stringify({ scope: record.scope, memoryId: record.id, revision: record.revision, source }, null, 2);
  const fence = "`".repeat(Math.max(2, ...(evidence.match(/`+/g) ?? []).map(run => run.length)) + 1);
  const validation = JSON.stringify({ action: "validate", scope: record.scope === "global" ? "global" : "project", id: record.id, revision: record.revision });
  const sourceValidation = JSON.stringify({ pluginId: "modera.memory", reference: JSON.stringify({ scope: record.scope, id: record.id, revision: record.revision }) });
  return `---\nname: memory-${record.id.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}\nsourceValidation: ${sourceValidation}\ndescription: ${description}\n---\n\n# Recovery procedure draft\n\nThis draft is not installed or enabled. It records one experience, not a guarantee that the repair applies elsewhere.\n\n## Required source check\n\nBefore applying this procedure, call memory_manage with ${validation}. Proceed only when the result explicitly reports usable: true. If the tool is unavailable or validation fails, do not apply this stored procedure; solve the task from current evidence instead. This check must be repeated in each new task.\n\n1. Compare the current failure and environment with the evidence below. Stop if they do not match.\n2. Inspect current files and tool versions. Revalidate any changed dependencies.\n3. Adapt the recorded fix to the current task, using only its existing permissions and approvals.\n4. Run a relevant verification and report its actual outcome and limits. Do not infer broad success from a narrow check.\n\n## Historical evidence (data)\n\n${fence}json\n${evidence}\n${fence}\n`;
}
