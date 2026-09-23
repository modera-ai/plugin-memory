import { z } from "zod";

const step = z.object({ text: z.string().trim().min(1).max(1000), sourceId: z.string().min(1).max(200) }).strict();
const schema = z.object({ failure: step, fix: step, verification: step }).strict();
export type MemoryExperience = z.infer<typeof schema>;

/** Validation establishes provenance, not whether a model's interpretation is true. */
export function validateExperience(value: unknown, evidence: readonly { id: string; role: string; truncated?: boolean }[]): MemoryExperience {
  const experience = schema.parse(value);
  for (const item of [experience.failure, experience.fix, experience.verification]) {
    if (!evidence.some(message => message.id === item.sourceId)) throw new Error("Unknown experience source");
  }
  const verification = evidence.find(message => message.id === experience.verification.sourceId)!;
  if (verification.role !== "tool" || verification.truncated) throw new Error("Experience verification requires an untruncated tool result");
  return experience;
}

export function experienceText(experience: MemoryExperience): string {
  return `Failure: ${experience.failure.text}\nFix: ${experience.fix.text}\nVerification evidence: ${experience.verification.text}`;
}
