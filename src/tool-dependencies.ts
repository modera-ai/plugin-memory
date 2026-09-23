import type { ChatMessage } from "@modera/contracts";
import type { MemoryExperience } from "./experience";
type Provenance = NonNullable<ChatMessage["toolProvenance"]>;

export function experienceToolDependencies(experience: MemoryExperience | undefined, evidence: readonly { id: string; toolProvenance?: Provenance | undefined }[]): Provenance[] {
  if (!experience) return [];
  const ids = new Set([experience.failure.sourceId, experience.fix.sourceId, experience.verification.sourceId]);
  const dependencies = evidence.filter(item => ids.has(item.id) && item.toolProvenance).map(item => item.toolProvenance!);
  return [...new Map(dependencies.map(item => [JSON.stringify(item), item])).values()];
}

export function toolDependenciesMatch(source: string, versions: Readonly<Record<string, string>> | undefined): boolean {
  let dependencies: unknown;
  try { dependencies = (JSON.parse(source) as { toolDependencies?: unknown }).toolDependencies; }
  catch { return true; /* Legacy opaque sources have no recorded tool versions. */ }
  if (dependencies === undefined) return true;
  if (!Array.isArray(dependencies)) return false;
  return dependencies.every(item => item && typeof item.tool === "string" && typeof item.owner === "string" && typeof item.version === "string" && versions?.[item.tool] === `${item.owner}@${item.version}`);
}
