import type { PluginConfigValues } from "@modera/plugin-sdk";
import { OllamaEmbeddings } from "./embeddings";
import type { MemoryDatabaseClient } from "./database-client";
import type { MemoryRecord } from "./repository";

function provider(values: PluginConfigValues) {
  return new OllamaEmbeddings(String(values.embeddingEndpoint ?? "http://127.0.0.1:11434"), String(values.embeddingModel ?? "embeddinggemma"));
}
export async function rebuildVectors(db: MemoryDatabaseClient, scopes: string[], values: PluginConfigValues, signal: AbortSignal) {
  const backend = provider(values);
  const database = db.scoped(signal);
  const identity = await backend.identify(signal);
  let indexed = 0;
  for (let batch = 0; batch < 8; batch++) {
    const records = await database.call("pendingVectors", scopes, identity.key);
    if (!records.length) return { indexed, remaining: false };
    const vectors = await backend.embed(records.map(record => record.text), identity, signal);
    indexed += await database.call("putVectors", scopes, identity.key, records.map((record, index) => ({ id: record.id, revision: record.revision, vector: vectors[index]! })));
  }
  return { indexed, remaining: (await database.call("pendingVectors", scopes, identity.key)).length > 0 };
}

export async function semanticRecall(db: MemoryDatabaseClient, scopes: string[], values: PluginConfigValues, query: string, signal: AbortSignal) {
  const backend = provider(values);
  const identity = await backend.identify(signal);
  const vectors = await backend.embed([query.slice(0, 4000)], identity, signal);
  return db.scoped(signal).call("searchVectors", scopes, identity.key, vectors[0]!);
}

/** Reciprocal rank fusion keeps keyword hits and adds semantic candidates without comparing incompatible scores. */
export function fuseRecall(keyword: readonly MemoryRecord[], semantic: readonly MemoryRecord[]): MemoryRecord[] {
  const ranks = new Map<string, { record: MemoryRecord; score: number }>();
  for (const list of [keyword, semantic]) list.slice(0, 12).forEach((record, index) => {
    const entry = ranks.get(record.id) ?? { record, score: 0 };
    entry.score += 1 / (60 + index + 1);
    ranks.set(record.id, entry);
  });
  return [...ranks.values()].sort((a, b) => b.score - a.score).slice(0, 12).map(entry => entry.record);
}
